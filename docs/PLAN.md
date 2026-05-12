# AppSync Events 相当を API Gateway WebSocket で再現する詳細実装計画

> 前提：TypeScript / Node.js / AWS CDK / Lambda Web Adapter（HTTP 系のみ）
> 関連ファクトチェック: [`aws-realtime-factcheck-2025.md`](./aws-realtime-factcheck-2025.md)

---

## 0. ファクトチェックで判明した「設計に効く事実」

実装方針を直撃する重要な確認結果を冒頭に明示しておきます。

| #   | 事実                                                                                                                                                  | 出典                                                                                                                                     | 設計への影響                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **Lambda Web Adapter は API Gateway WebSocket に非対応**（HTTP リクエストへの変換を前提とするため、`APIGatewayWebsocketProxyRequest` 形式を扱えない） | [LWA README](https://github.com/aws/aws-lambda-web-adapter)                                                                              | WebSocket ルートのハンドラは **素の Lambda Handler**（`@types/aws-lambda` の `APIGatewayProxyWebsocketEventV2`）で書く。LWA は HTTP API 側にのみ適用 |
| F2  | API Gateway WebSocket の **アイドル 10 分 / 最大 2 時間**、フレーム 32KB / メッセージ 128KB                                                           | [WS Quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html)       | クライアント側で Keep-alive Ping を 5〜9 分間隔で送出、再接続戦略を必須にする                                                                        |
| F3  | **Cognito JWT Authorizer は WebSocket 非対応**（HTTP API 専用）                                                                                       | [Lambda Auth for WS](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-lambda-auth.html)             | Cognito を使う場合も Lambda Authorizer 内で JWKS 検証する                                                                                            |
| F4  | `$connect` でのみ Authorizer が動く。`$disconnect` はベストエフォート                                                                                 | 同上                                                                                                                                     | 認可情報は接続時に DynamoDB へキャッシュ。subscribe/publish では再検証は EventHandler Lambda 内で                                                    |
| F5  | AppSync Events のチャンネル仕様：**最大 5 セグメント・各 50 文字以内・英数字とハイフンのみ・大文字小文字区別**                                        | [Channel Namespaces](https://docs.aws.amazon.com/appsync/latest/eventapi/channel-namespaces.html)                                        | バリデータの正規表現を本物に合わせる                                                                                                                 |
| F6  | ワイルドカード：`*`（同階層 1 セグメント）/ `**`（多階層）。**サブスクライブ時のみ**                                                                  | [WS Protocol](https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-websocket-protocol.html)                                     | publish は具体パスのみ、subscribe はパターン許容                                                                                                     |
| F7  | AppSync Events HTTP Publish は **1 リクエスト 5 イベントまで・全体 1.2MB・1 イベント 240KB**                                                          | [Publish HTTP](https://docs.aws.amazon.com/appsync/latest/eventapi/publish-http.html)                                                    | 互換のため同じ制限を採用                                                                                                                             |
| F8  | API Gateway WebSocket の Lambda 統合では **レスポンス Body は自動で返らない** ことがある（`RouteResponse` 未定義時）                                  | [WS Routes/Integrations](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-routes-integrations.html) | 双方向通信は `PostToConnection`（`@connections`）で能動 push、または Two-Way 通信ルートを定義                                                        |
| F9  | **LWA Layer ARN（最新）**: `arn:aws:lambda:${region}:753240598075:layer:LambdaAdapterLayerArm64:27`（arm64）                                          | [LWA README](https://github.com/aws/aws-lambda-web-adapter)                                                                              | CDK でリージョン別に Layer 参照                                                                                                                      |

---

## 1. ゴール定義（再掲）

AppSync Events の以下機能を「API Gateway WebSocket + HTTP API + Lambda + DynamoDB」で再現する。

1. Namespace + 階層チャンネル（`/default/room/123`）
2. ワイルドカード購読（`*`, `**`）
3. WebSocket 経由の subscribe / publish
4. HTTP 経由の publish（1リクエスト最大 5 イベント）
5. Lambda Event Handler（`onPublish` / `onSubscribe`）による認可・変換・フィルタ
6. 認可モード（API Key / Cognito / Lambda / IAM。OIDC は Lambda Authorizer に集約）
7. ファンアウト配信（数千購読を想定）

「再現しない」と明示する範囲：

- 240KB のイベントサイズ（API Gateway WebSocket の 128KB 制約のため **128KB に縮小**）
- AppSync_JS ランタイム上の resolver（**Lambda 関数として書き換え**）
- マルチリージョン（v1 では単一リージョン）

---

## 2. アーキテクチャ全体図

```mermaid
flowchart LR
    subgraph Clients
      C1[Browser/Mobile<br/>WS Client]
      C2[Server<br/>HTTP Publisher]
    end

    subgraph APIGW
      WS[WebSocket API<br/>route key=$request.body.action]
      HTTP[HTTP API<br/>POST /event]
    end

    subgraph Auth
      AUTHZ[Lambda Authorizer<br/>API Key / JWT / IAM]
    end

    subgraph WSHandlers[WS Lambdas - 純Lambda]
      L_CON[connect]
      L_DIS[disconnect]
      L_SUB[subscribe]
      L_UNSUB[unsubscribe]
      L_PUB_WS[publish-ws]
      L_DEF[default]
    end

    subgraph HTTPSvc[HTTP API - LWA + Hono]
      L_HTTP[publish-http<br/>+ admin endpoints]
    end

    subgraph EventHandlers[Event Handlers]
      L_HOOK[onPublish / onSubscribe<br/>純Lambda invoke]
    end

    subgraph Fanout
      Q[(SQS Standard<br/>Fanout Queue)]
      DLQ[(SQS DLQ)]
      L_FAN[fanout-worker]
    end

    subgraph Data[DynamoDB]
      T_CONN[(Connections<br/>PK: connectionId)]
      T_SUB[(Subscriptions<br/>PK: channelPrefix<br/>SK: connectionId#pattern)]
      T_NS[(Namespaces<br/>PK: namespace)]
    end

    C1 <-->|WSS| WS
    C2 -->|HTTPS| HTTP
    WS -.connect.-> AUTHZ
    HTTP -.JWT.-> AUTHZ

    WS --> L_CON --> T_CONN
    WS --> L_DIS --> T_CONN
    WS --> L_DIS --> T_SUB
    WS --> L_SUB --> L_HOOK
    L_SUB --> T_SUB
    WS --> L_UNSUB --> T_SUB
    WS --> L_PUB_WS --> L_HOOK
    L_PUB_WS --> Q
    WS --> L_DEF

    HTTP --> L_HTTP --> L_HOOK
    L_HTTP --> Q

    Q --> L_FAN
    Q -.失敗.-> DLQ
    L_FAN --> T_SUB
    L_FAN -->|@connections.PostToConnection| WS
    L_FAN -->|410 Gone| T_CONN
```

---

## 3. リポジトリ構成（モノレポ / pnpm workspaces）

```
appsync-events-clone/
├── package.json                 # root, pnpm workspace
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .eslintrc.cjs                # @typescript-eslint + import + unicorn
├── .prettierrc
├── vitest.workspace.ts
├── README.md
├── packages/
│   ├── core/                    # 共通ロジック (channel matcher, validators)
│   │   ├── src/
│   │   │   ├── channel.ts       # parseChannel, matchPattern, channelPrefix
│   │   │   ├── validation.ts    # zod schemas
│   │   │   ├── authz.ts         # 認可ペイロードの型・検証
│   │   │   └── index.ts
│   │   └── test/
│   ├── ws-handlers/             # WebSocket 用 純Lambda Handlers
│   │   ├── src/
│   │   │   ├── connect.ts
│   │   │   ├── disconnect.ts
│   │   │   ├── subscribe.ts
│   │   │   ├── unsubscribe.ts
│   │   │   ├── publish.ts
│   │   │   ├── default.ts
│   │   │   ├── authorizer.ts
│   │   │   └── shared/
│   │   │       ├── ddb.ts
│   │   │       ├── apigw.ts     # ApiGatewayManagementApiClient ラッパ
│   │   │       └── post.ts      # クライアントへの返信（PostToConnection）
│   │   └── test/
│   ├── http-api/                # HTTP API: Hono + LWA で動くサーバ
│   │   ├── src/
│   │   │   ├── server.ts        # 起動エントリ (PORT=8080)
│   │   │   ├── app.ts           # Hono app
│   │   │   ├── routes/
│   │   │   │   ├── publish.ts   # POST /event
│   │   │   │   └── admin.ts     # POST /admin/namespaces 等（任意）
│   │   │   └── middleware/
│   │   │       └── auth.ts
│   │   ├── Dockerfile           # ローカル dev / Lambda 両対応
│   │   └── test/                # supertest で in-process テスト
│   ├── fanout-worker/           # SQS 駆動の配信ワーカー
│   │   ├── src/
│   │   │   ├── handler.ts
│   │   │   └── matcher.ts
│   │   └── test/
│   └── event-handler-sample/    # ユーザ定義 onPublish/onSubscribe のサンプル
│       └── src/index.ts
├── infra/
│   └── cdk/
│       ├── bin/app.ts
│       ├── lib/
│       │   ├── ddb-stack.ts
│       │   ├── ws-api-stack.ts
│       │   ├── http-api-stack.ts
│       │   ├── fanout-stack.ts
│       │   └── observability-stack.ts
│       └── test/                # CDK assertions
└── tools/
    ├── ws-client/               # 動作確認用 CLI（wscat 代替）
    └── load-test/               # k6 / artillery シナリオ
```

### 採用ライブラリ

| 用途                          | ライブラリ                                                                       | 理由                                                                |
| ----------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| HTTP framework                | **Hono**                                                                         | Edge/Lambda/Node 対応、型安全、軽量。LWA との相性◎                  |
| バリデーション                | **Zod**                                                                          | TS 型生成、Hono 公式サポート（`@hono/zod-validator`）               |
| AWS SDK                       | **AWS SDK v3**                                                                   | tree-shaking、`@aws-sdk/client-apigatewaymanagementapi` 等          |
| DDB アクセス                  | **`@aws-sdk/lib-dynamodb`**                                                      | Document Client                                                     |
| ロガー                        | **`@aws-lambda-powertools/logger`**                                              | 構造化ログ、相関ID                                                  |
| メトリクス                    | **`@aws-lambda-powertools/metrics`**                                             | EMF 形式                                                            |
| トレーシング                  | **`@aws-lambda-powertools/tracer`**                                              | X-Ray                                                               |
| Lint                          | ESLint + `@typescript-eslint` + `eslint-plugin-import` + `eslint-plugin-unicorn` |                                                                     |
| Format                        | Prettier                                                                         |                                                                     |
| Test                          | **Vitest** + `aws-sdk-client-mock`                                               | jest より速く ESM 互換、CDK は `@aws-cdk/assertions`                |
| ローカル AWS エミュレーション | **LocalStack** (DynamoDB, SQS, API Gateway HTTP)                                 | WebSocket は LocalStack Pro が必要なので対象外、in-process でモック |
| WS クライアント               | `ws`（公式）、テストには `mock-socket`                                           |                                                                     |

---

## 4. データモデル（最終版）

### 4.1 `Connections` テーブル

| 属性                | 型  | 用途                                    |
| ------------------- | --- | --------------------------------------- |
| `connectionId` (PK) | S   | API Gateway connectionId                |
| `userId`            | S   | 認可情報（Authorizer から）             |
| `authMode`          | S   | `apiKey` / `cognito` / `iam` / `lambda` |
| `claims`            | M   | JWT claims など                         |
| `connectedAt`       | N   | epoch ms                                |
| `lastSeenAt`        | N   | 直近受信 ms（任意）                     |
| `ttl`               | N   | 接続切れ後 1h で自動削除                |

### 4.2 `Subscriptions` テーブル

ワイルドカード対応のため、**「ワイルドカード前の固定プレフィックス」をパーティションキー**にする。

| 属性                 | 型  | 用途                                       |
| -------------------- | --- | ------------------------------------------ |
| `channelPrefix` (PK) | S   | 例 `/default/room`（`*` `**` 直前まで）    |
| `sk` (SK)            | S   | `${connectionId}#${pattern}`               |
| `connectionId`       | S   |                                            |
| `pattern`            | S   | 完全な購読パターン（例 `/default/room/*`） |
| `namespace`          | S   | 第1セグメント                              |
| `subscriptionId`     | S   | クライアント発行 ID（unsubscribe で利用）  |
| `filter`             | S   | onSubscribe で設定された JSON Logic 等     |
| `subscribedAt`       | N   | epoch ms                                   |

GSI:

- `byConnection` (PK: `connectionId`, SK: `pattern`) — disconnect 時の一括削除用
- `bySubscriptionId` (PK: `connectionId`, SK: `subscriptionId`) — unsubscribe 用

### 4.3 `Namespaces` テーブル（v1 では設定ファイルから seed）

| 属性             | 型  | 用途                       |
| ---------------- | --- | -------------------------- |
| `namespace` (PK) | S   | 例 `default`               |
| `authMode`       | S   | `apiKey` / `cognito` / ... |
| `onPublishArn`   | S   | （任意）Lambda ARN         |
| `onSubscribeArn` | S   | （任意）Lambda ARN         |
| `createdAt`      | N   |                            |

---

## 5. WebSocket プロトコル設計

ルート選択式：`$request.body.action`。AppSync Events 互換のメッセージ型を採用。

| `action`            | 方向 | ペイロード（例）                                                                  |
| ------------------- | ---- | --------------------------------------------------------------------------------- |
| `connection_init`   | C→S  | `{action:"connection_init"}`（`$connect` 直後の確認）                             |
| `connection_ack`    | S→C  | `{action:"connection_ack", connectionTimeoutMs:600000}`                           |
| `subscribe`         | C→S  | `{action:"subscribe", id:"sub-1", channel:"/default/room/*"}`                     |
| `subscribe_success` | S→C  | `{action:"subscribe_success", id:"sub-1"}`                                        |
| `subscribe_error`   | S→C  | `{action:"subscribe_error", id:"sub-1", errors:[...]}`                            |
| `unsubscribe`       | C→S  | `{action:"unsubscribe", id:"sub-1"}`                                              |
| `publish`           | C→S  | `{action:"publish", id:"p-1", channel:"/default/room/123", events:["{\"x\":1}"]}` |
| `publish_success`   | S→C  | `{action:"publish_success", id:"p-1"}`                                            |
| `data`              | S→C  | `{action:"data", id:"sub-1", event:"{\"x\":1}"}`                                  |
| `ka`                | S→C  | Keep-alive（クライアントは無視可）                                                |
| `error`             | S→C  | プロトコルエラー                                                                  |

> 注：API Gateway WebSocket のアイドル 10 分制約に対し、`ka` は 4 分間隔程度で送る。サーバ→クライアントは `PostToConnection` で能動送信する（**RouteResponse は使わない**＝シンプル化）。

---

## 6. パッケージ別の実装詳細

### 6.1 `packages/core`

#### `channel.ts` — チャンネル文字列解析とマッチング

```typescript
// 仕様: セグメント最大5・各最大50文字・英数字+ハイフン・大文字小文字区別
const SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;

export type ParsedChannel = {
  raw: string;
  segments: string[];
  namespace: string;
  hasWildcard: boolean;
  channelPrefix: string; // ワイルドカード直前までの固定パス
};

export function parsePublishChannel(input: string): ParsedChannel {
  /* ワイルドカード禁止 */
}
export function parseSubscribePattern(input: string): ParsedChannel {
  /* * / ** 許容 */
}

export function matchesPattern(pattern: ParsedChannel, concrete: ParsedChannel): boolean {
  // 末尾 ** は残り全セグメントにマッチ、* は1セグメント
}

export function computeChannelPrefix(pattern: ParsedChannel): string {
  // ワイルドカード直前の固定プレフィックスを返す（DDB PK 用）
}
```

テスト観点：

- 正常: `/default/room/123` → 5セグメント未満OK
- 異常: `/default/Room_1`（`_` 不可）→ `ValidationError`
- ワイルドカード: `/default/room/*` で `/default/room/123` にマッチ、`/default/room/123/sub` は不一致
- `**`: `/default/room/**` は `/default/room/123/sub` にもマッチ

### 6.2 `packages/ws-handlers`

#### Lambda Handler 雛形（純 Lambda、LWA 不使用）

```typescript
// connect.ts
import type { APIGatewayProxyWebsocketHandlerV2 } from "aws-lambda";
import { ddb } from "./shared/ddb";

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const { connectionId } = event.requestContext;
  const ctx = JSON.parse(event.requestContext.authorizer?.context ?? "{}");
  await ddb.put({
    TableName: process.env.CONNECTIONS_TABLE!,
    Item: {
      connectionId,
      userId: ctx.userId,
      authMode: ctx.authMode,
      claims: ctx.claims ?? {},
      connectedAt: Date.now(),
      ttl: Math.floor(Date.now() / 1000) + 60 * 60 * 3,
    },
  });
  return { statusCode: 200 };
};
```

#### `subscribe.ts` の流れ

1. `parseSubscribePattern(channel)` で検証
2. `Connections` から接続情報をロード（認可コンテキスト）
3. `onSubscribe` Event Handler Lambda を **Invoke**（同期 InvocationType=RequestResponse）
   - 入力: `{ identity, channel, namespace }`
   - 出力: `{ allow: boolean, filter?: string, reason?: string }`
4. allow なら `Subscriptions` に Put
5. `PostToConnection` で `subscribe_success` を返す

#### `publish.ts`（WS から）の流れ

1. `parsePublishChannel(channel)` で検証（ワイルドカード禁止）
2. `events.length <= 5` を確認、各 stringified JSON のサイズ確認
3. `onPublish` Event Handler Lambda を Invoke（同期）
4. 返ってきた `events`（変換後）を **SQS にバッチ enqueue**（メッセージ属性に `channel`、`namespace`）
5. 即時に `publish_success` を返す（fanout は非同期）

### 6.3 `packages/http-api` — Lambda Web Adapter で動かす Hono サーバ

ここが **LWA を活かすパート**。同一コードでローカル `node` 起動も Lambda 起動もできる。

#### `Dockerfile`（マルチステージ、arm64）

```dockerfile
# syntax=docker/dockerfile:1.7
FROM public.ecr.aws/docker/library/node:20-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY packages/http-api/package.json packages/http-api/
COPY packages/core/package.json packages/core/
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter http-api build

FROM public.ecr.aws/docker/library/node:20-alpine
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter
WORKDIR /var/task
COPY --from=builder /app/packages/http-api/dist ./dist
COPY --from=builder /app/packages/http-api/node_modules ./node_modules
ENV PORT=8080
ENV AWS_LWA_PORT=8080
ENV AWS_LWA_READINESS_CHECK_PATH=/health
CMD ["node", "dist/server.js"]
```

ローカル: `docker run -p 8080:8080 -e AWS_REGION=us-east-1 ... http-api` または `pnpm --filter http-api dev`（`tsx watch src/server.ts`）。

#### `app.ts`（Hono）

```typescript
import { Hono } from "hono";
import { logger } from "hono/logger";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { authMiddleware } from "./middleware/auth";
import { publishHandler } from "./routes/publish";

export const app = new Hono();
app.use("*", logger());
app.get("/health", (c) => c.json({ ok: true }));

const publishSchema = z.object({
  channel: z.string().min(1),
  events: z.array(z.string()).min(1).max(5), // AppSync Events 仕様準拠
});

app.post(
  "/event",
  authMiddleware, // API Key / JWT 検証
  zValidator("json", publishSchema),
  publishHandler,
);
```

#### `publishHandler` 内部

```typescript
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { parsePublishChannel } from "@appsync-events-clone/core";

export const publishHandler = async (c) => {
  const { channel, events } = c.req.valid("json");
  const parsed = parsePublishChannel(channel); // 例外時 400
  // onPublish Lambda 同期 invoke → 変換後イベント取得
  // SQS にバッチ enqueue
  // 200 を返す
};
```

#### ローカルテストの容易性（LWA を選んだ価値）

- `vitest` + `supertest`（あるいは Hono 標準の `app.request()`）で **HTTP リクエストを in-process でテスト**
- AWS SDK は `aws-sdk-client-mock` で stub
- `pnpm --filter http-api test` で完結。Lambda 環境を立ち上げる必要なし
- `pnpm --filter http-api dev` で `tsx watch`、コード変更が即反映

### 6.4 `packages/fanout-worker`

```typescript
// SQS バッチサイズ 10 で受信、各メッセージ = 1 publish
// 1. matchingPrefixes(channel) → DDB Query（複数 prefix を並列 Query）
// 2. 結果を pattern matcher にかけて該当 connectionId を集約
// 3. PostToConnection を Promise.allSettled で並列実行（concurrency=50）
// 4. 410 Gone → DDB から接続削除
// 5. 残りはそのまま（再試行は SQS の visibility timeout 経由）
```

並列度制御に `p-limit` を使用。バッチアイテム失敗は `BatchItemFailures` で部分失敗を返す（SQS 側で再試行）。

### 6.5 `packages/event-handler-sample`

ユーザ定義の onPublish / onSubscribe を別 Lambda として書く例。サンプルとして「メッセージ末尾にタイムスタンプを付与」「特定 user は admin namespace に subscribe 不可」を実装。

---

## 7. インフラ（CDK / TypeScript）

### スタック分割

1. **DataStack**: DynamoDB 3 テーブル + SQS + DLQ
2. **WebSocketStack**: WebSocket API + 6 Lambda + Authorizer + IAM
3. **HttpStack**: HTTP API + LWA Lambda（Container Image or Layer + Zip）
4. **FanoutStack**: fanout-worker Lambda + SQS event source
5. **ObservabilityStack**: CloudWatch Dashboard + Alarms

### WebSocket Stack の要点

```typescript
const wsApi = new apigwv2.WebSocketApi(this, "EventsWsApi", {
  routeSelectionExpression: "$request.body.action",
  connectRouteOptions: {
    integration: new WebSocketLambdaIntegration("ConnectInt", connectFn),
    authorizer: new WebSocketLambdaAuthorizer("Authz", authzFn, {
      identitySource: ["route.request.querystring.authorization"], // ブラウザ向け
    }),
  },
  disconnectRouteOptions: {
    integration: new WebSocketLambdaIntegration("DisconnectInt", disconnectFn),
  },
  defaultRouteOptions: { integration: new WebSocketLambdaIntegration("DefaultInt", defaultFn) },
});
wsApi.addRoute("subscribe", { integration: new WebSocketLambdaIntegration("Sub", subFn) });
wsApi.addRoute("unsubscribe", { integration: new WebSocketLambdaIntegration("Unsub", unsubFn) });
wsApi.addRoute("publish", { integration: new WebSocketLambdaIntegration("PubWs", pubWsFn) });

// PostToConnection 権限
[connectFn, subFn, pubWsFn, fanoutFn].forEach((fn) =>
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["execute-api:ManageConnections"],
      resources: [`arn:aws:execute-api:${region}:${account}:${wsApi.apiId}/*/POST/@connections/*`],
    }),
  ),
);
```

### HTTP Stack で LWA を使う方式

```typescript
const lwaLayer = LayerVersion.fromLayerVersionArn(
  this,
  "LwaLayer",
  `arn:aws:lambda:${this.region}:753240598075:layer:LambdaAdapterLayerArm64:27`,
);

const httpFn = new lambda.Function(this, "HttpFn", {
  runtime: lambda.Runtime.NODEJS_20_X,
  architecture: lambda.Architecture.ARM_64,
  code: lambda.Code.fromAsset("packages/http-api", {
    /* esbuild bundling */
  }),
  handler: "run.sh", // LWA + AWS_LAMBDA_EXEC_WRAPPER
  layers: [lwaLayer],
  environment: {
    AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
    PORT: "8080",
    AWS_LWA_READINESS_CHECK_PATH: "/health",
    QUEUE_URL: queue.queueUrl,
    CONNECTIONS_TABLE: connTable.tableName,
  },
});
```

`run.sh` は `node dist/server.js` を起動するだけ。

---

## 8. ローカル開発ループ（フィードバック最短化）

### 8.1 開発時に常時走らせるもの

| ターミナル | コマンド                                     | 役割                                            |
| ---------- | -------------------------------------------- | ----------------------------------------------- |
| 1          | `pnpm --filter core test --watch`            | core ロジックの即時テスト                       |
| 2          | `pnpm --filter http-api dev`                 | Hono サーバ（`tsx watch`）http://localhost:8080 |
| 3          | `pnpm --filter ws-handlers test --watch`     | ハンドラ単体テスト                              |
| 4          | `docker compose up dynamodb-local sqs-local` | LocalStack（DynamoDB + SQS のみ）               |

### 8.2 統合テスト

- **HTTP API**：Hono の `app.request()` で in-process リクエスト発行 → DDB（LocalStack）→ SQS まで結合確認
- **WebSocket Handler**：`APIGatewayProxyWebsocketEventV2` のフィクスチャを vitest で投入。`ApiGatewayManagementApi` を `aws-sdk-client-mock` で監視
- **fanout-worker**：SQS イベントを直接 handler に渡し、`PostToConnection` のモックが期待 connection に呼ばれるか検証
- **エンドツーエンド（任意）**：CDK で dev 環境を `cdk deploy --hotswap`。`tools/ws-client` で実 WS 接続して subscribe/publish

### 8.3 統一スクリプト（root `package.json`）

```json
{
  "scripts": {
    "lint": "eslint . --ext .ts --max-warnings=0",
    "format": "prettier -w .",
    "typecheck": "tsc -b",
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "pnpm -r build",
    "synth": "pnpm --filter cdk synth",
    "verify": "pnpm lint && pnpm typecheck && pnpm test && pnpm synth"
  }
}
```

`pnpm verify` をローカルでも CI でも走らせる。これが「フィードバックループの一周」。

### 8.4 Pre-commit / CI

- **lefthook**（lint-staged 代替・速い）で `eslint --fix` と `prettier -w` を変更ファイルに適用
- GitHub Actions:
  - `verify` ジョブ: Node 20 + pnpm キャッシュ → `pnpm verify`
  - `cdk-diff` ジョブ: PR 時に `cdk diff` をコメント
  - `e2e` ジョブ: 任意ブランチで CDK deploy → smoke test → destroy

---

## 9. テスト戦略マトリクス

| 層          | 対象                               | ツール                         | 観点                                            |
| ----------- | ---------------------------------- | ------------------------------ | ----------------------------------------------- |
| **Unit**    | `core` channel matcher / validator | Vitest                         | ワイルドカード網羅、不正文字、最大セグメント    |
| Unit        | Hono ルート                        | Vitest + `app.request()`       | 200/400/401、Zod エラー形                       |
| Unit        | WS handlers                        | Vitest + `aws-sdk-client-mock` | DDB 入出力、PostToConnection 引数               |
| Contract    | Event Handler I/F                  | Zod スキーマで入出力検証       | onPublish 戻り値が events[] か                  |
| Integration | LocalStack                         | DynamoDB + SQS 実体で確認      | publish→queue→worker→post の流れ                |
| Property    | Channel matcher                    | `fast-check`                   | `parse(serialize(x)) === x`、マッチ規則の対称性 |
| Load        | fanout                             | k6 / Artillery                 | 10k subscribers への配信 p99                    |
| CDK         | スタック構造                       | `aws-cdk-lib/assertions`       | 重要リソースの存在・IAM 最小権限                |

---

## 10. セキュリティと運用

- IAM は **関数ごとに最小権限**。fanout-worker は `execute-api:ManageConnections` を持つが、Connections テーブルは `Read+DeleteItem` のみ
- API Gateway WebSocket には WAF 直接アタッチ不可 → CloudFront 前段は使わず、**Authorizer 内でトークン形式を厳密検証**
- CloudWatch Logs は構造化（Powertools Logger）。`connectionId`, `userId`, `requestId`, `channel` を必ず含める
- メトリクス：
  - `ConnectionsActive`（`$connect` / `$disconnect` カウント）
  - `PublishLatency`（受信→ack）
  - `FanoutLatency`（publish→最後の購読者へ届いた時間）
  - `GoneOn410Count`（接続クリーンアップ数）
- アラーム：DLQ 1件以上、5xx 1% 以上、Lambda Throttle、`PostToConnection` 失敗率

---

## 11. リスクと緩和策

| リスク                                    | 影響               | 緩和策                                                 |
| ----------------------------------------- | ------------------ | ------------------------------------------------------ |
| アイドル 10 分切断                        | UX 悪化            | サーバから 4 分毎 `ka`、クライアントは ping/再接続実装 |
| WebSocket メッセージ 128KB                | 大型ペイロード不可 | publish API で 128KB を validate、超過は 413 を返す    |
| 大量 fan-out で `PostToConnection` レート | 配信遅延           | SQS で平準化、`p-limit` 並列度、ホットチャンネル分割   |
| Lambda コールドスタート                   | 初回購読遅延       | Provisioned Concurrency on subscribe / publish-ws      |
| DDB ホットパーティション                  | スケール頭打ち     | `channelPrefix` の粒度を細かくする運用ルール           |
| Cognito 直接非対応                        | 開発工数           | Lambda Authorizer に JWKS キャッシュ実装をテンプレ化   |

---

## 12. マイルストーン

| Phase                            | 期間目安 | 成果物                                                                |
| -------------------------------- | -------- | --------------------------------------------------------------------- |
| **0. リポジトリ立ち上げ**        | 0.5 週   | pnpm workspace, ESLint/Prettier/Vitest/CDK 雛形, `pnpm verify` が通る |
| **1. core パッケージ**           | 0.5 週   | channel parser/matcher + 100% カバレッジ                              |
| **2. WS MVP（完全一致）**        | 1 週     | connect/disconnect/subscribe/publish が DDB と動作、wscat で疎通      |
| **3. fanout worker**             | 0.5 週   | SQS 経由配信、410 削除、property test                                 |
| **4. ワイルドカード対応**        | 0.5 週   | `*` `**` を本実装、結合テスト                                         |
| **5. HTTP Publish (LWA + Hono)** | 0.5 週   | `POST /event` 動作、ローカル `node` 起動も両立                        |
| **6. Event Handler 連携**        | 0.5 週   | onPublish/onSubscribe Lambda 連携、サンプル実装                       |
| **7. 認可**                      | 1 週     | API Key / JWT(Cognito) / IAM の Lambda Authorizer                     |
| **8. 観測性 + 負荷試験**         | 1 週     | ダッシュボード、k6 で 1万購読シナリオ                                 |
| **9. ドキュメント + リリース**   | 0.5 週   | README, 利用手順、移行ガイド（AppSync Events との差分）               |

合計：**約 6 週**（1 人想定）

---

## 13. 未確定事項（要意思決定）

実装に入る前に決めておきたい点：

1. **認可の優先順位**：v1 で Cognito を必須にするか、API Key 先行か？
2. **ペイロードサイズ**：128 KB 制約を許容するか、それとも S3 経由のラージペイロード機構（claim check pattern）を入れるか？
3. **接続再開時のメッセージ補完**：v1 ではスコープ外で良いか？（必要なら DynamoDB Streams + 履歴テーブル）
4. **デプロイターゲット**：CDK のみ提供か、SAM テンプレートも併設するか？
5. **Event Handler の言語**：Lambda（任意言語）に絞るか、AppSync 互換で JS resolver も模倣するか？

---

> 次アクション提案：このプランで方向性に問題なければ、Phase 0（リポジトリ雛形 + `pnpm verify` が通る状態）まで一気に作成します。
