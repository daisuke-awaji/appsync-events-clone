# AWS リアルタイム関連サービス ファクトチェックレポート

**調査日: 2025-2026年時点の最新公式情報に基づく**

---

## 1. AWS AppSync Events（2024年10月発表 Pub/Sub 機能）

### 1-1. Namespace / Channel / ChannelNamespace の概念と階層パスの仕様

- **Event API**：Pub/Sub の最上位リソース。HTTP エンドポイント（`https://<id>.appsync-api.<region>.amazonaws.com/event`）と WebSocket エンドポイント（`wss://<id>.appsync-realtime-api.<region>.amazonaws.com/event/realtime`）を持つ。
- **Channel Namespace（チャンネル名前空間）**：チャンネルの設定と動作を定義するグループ。名前空間の名称がチャンネルパスの **第1セグメント（プレフィックス）** となる。例: 名前空間名 `default` → `/default/messages`, `/default/greetings` などが属する。
- **Channel（チャンネル）**：イベントを配送するルーティング機構（「トピック」相当）。エフェメラル（オンデマンド生成）。
- **チャンネルパス規則**：
  - セグメント数：最大 **5 セグメント**（スラッシュ区切り）
  - セグメント長：1セグメント最大 **50 文字**（英数字・ハイフンのみ）
  - 正規表現：`/^\/?[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?){0,4}\/?$/`
  - 大文字小文字を区別（case sensitive）
  - 例：`/namespaceA/subB/subC` ✅

> **出典**：
>
> - https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-concepts.html
> - https://docs.aws.amazon.com/appsync/latest/eventapi/channel-namespaces.html
> - https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-websocket-protocol.html

---

### 1-2. ワイルドカード（`*` `**`）のマッチング規則

- ワイルドカード使用でチャンネルグループへの一括サブスクライブが可能。
- `*`（シングルワイルドカード）：パスの末尾で使用し、**同一階層の複数チャンネル**にマッチ。
  - 例：`/messages/*` → `/messages/user1`, `/messages/user2` などにマッチ
- `**`（ダブルワイルドカード）：複数セグメントにまたがってマッチ（公式ブログで言及）
  - 例：`/messages/**` のように使用
- **サブスクライブ時のみワイルドカード使用可能**（パブリッシュ時は具体的なチャンネルパスが必要）

> **出典**：
>
> - https://aws.amazon.com/blogs/mobile/announcing-aws-appsync-events-serverless-websocket-apis/
> - https://docs.aws.amazon.com/appsync/latest/eventapi/appsync-eventapi-dg.pdf

---

### 1-3. 認可モード

以下 **5種類** の認可モードをサポート。API レベルと Namespace レベルで独立して設定可能（混在設定も可）。

| 認可モード                    | ヘッダー/パラメータ                                                    |
| ----------------------------- | ---------------------------------------------------------------------- |
| **API Key**                   | `x-api-key: <key>`                                                     |
| **Amazon Cognito User Pools** | `Authorization: <JWT ID token>`                                        |
| **OpenID Connect (OIDC)**     | `Authorization: <JWT ID token>`                                        |
| **AWS IAM**                   | SigV4（`Authorization`, `x-amz-date`, `X-Amz-Security-Token`, `host`） |
| **AWS Lambda カスタム認可**   | `Authorization: <カスタムトークン>`                                    |

- **接続（WebSocket Upgrade）時**：API レベルの認可を使用
- **Publish / Subscribe 時**：Namespace レベルの認可で上書き可能
- Lambda authorizer の制約：コンテキストデータは最大 **5 MB**

> **出典**：
>
> - https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-websocket-protocol.html
> - https://docs.aws.amazon.com/appsync/latest/eventapi/appsync-eventapi-dg.pdf

---

### 1-4. Event Handler（onPublish / onSubscribe）の I/F、resolver の書き方

#### onPublish ハンドラ

```typescript
// シグネチャ
function onPublish(context: Context): OutgoingEvent[] | null;

type Context = {
  events: IncomingEvent[]; // 処理するイベント配列
  channel: string; // 公開先チャンネル
  identity: Identity; // 公開者情報
  info: {
    channel: {
      path: string; // フルチャンネルパス
      segments: string[]; // パスセグメント
    };
  };
  channelNamespace: { name: string };
  operation: "SUBSCRIBE" | "PUBLISH";
};
```

- イベントのフィルタリング、変換、バリデーションが可能
- エラー付きイベントはブロードキャストされない（`error` プロパティを付与するとスキップ）
- `null` を返した場合、そのインデックスのイベントは無視される
- 返却配列の各イベントIDは受信イベントのIDと対応させる必要がある

#### onSubscribe ハンドラ

```typescript
// シグネチャ
function onSubscribe(context: Context): void;
```

- サブスクライブ前の認可・フィルタリング処理
- 例外をスローするとサブスクライブを拒否できる

#### JavaScript ハンドラ記述例

```javascript
import { util } from "@aws-appsync/utils";
export function onPublish(ctx) {
  return ctx.events.map((event) => ({
    id: event.id,
    payload: {
      ...event.payload,
      message: event.payload.message.toUpperCase(),
      timestamp: util.time.nowISO8601(),
    },
  }));
}
```

- **実行環境**：AppSync_JS ランタイム（JavaScript のみ。Lambda は「データソース」として接続する形）
- **ハンドラはオプション**（設定しなくてもチャンネルは動作する）
- **コードサイズ上限**：32 KB（All APIs - Handler, resolver, and function code size）

> **出典**：
>
> - https://docs.aws.amazon.com/appsync/latest/eventapi/channel-namespace-handlers.html
> - https://docs.aws.amazon.com/appsync/latest/eventapi/event-handlers-overview.html
> - https://docs.aws.amazon.com/appsync/latest/eventapi/appsync-eventapi-dg.pdf

---

### 1-5. WebSocket プロトコルの詳細

#### 接続 URL

| 種別                                    | URL                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------- |
| HTTP エンドポイント                     | `https://<id>.appsync-api.<region>.amazonaws.com/event`                 |
| WebSocket（リアルタイム）エンドポイント | `wss://<id>.appsync-realtime-api.<region>.amazonaws.com/event/realtime` |
| カスタムドメイン使用時（HTTP）          | `https://api.example.com/event`                                         |
| カスタムドメイン使用時（WSS）           | `wss://api.example.com/event/realtime`                                  |

#### WebSocket サブプロトコル

接続時に **2つのサブプロトコル**を指定する必要がある：

1. `aws-appsync-event-ws`（固定）
2. `header-<Base64URL encoded authorization JSON>`

```javascript
const socket = new WebSocket(`wss://${REALTIME_DOMAIN}/event/realtime`, [
  "aws-appsync-event-ws",
  `header-${base64urlEncodedAuth}`,
]);
```

#### メッセージフォーマット（主要なもの）

| メッセージ種別      | 方向          | 内容                                                 |
| ------------------- | ------------- | ---------------------------------------------------- |
| `connection_init`   | Client→Server | 接続初期化（オプション）                             |
| `connection_ack`    | Server→Client | 接続確認。`connectionTimeoutMs: 300000`（5分）を含む |
| `ka`                | Server→Client | Keep-alive（60秒間隔）                               |
| `subscribe`         | Client→Server | チャンネル購読登録                                   |
| `subscribe_success` | Server→Client | 購読成功確認                                         |
| `data`              | Server→Client | イベントデータ配信                                   |
| `publish`           | Client→Server | イベント公開（2025年3月追加）                        |
| `publish_success`   | Server→Client | 公開成功確認                                         |
| `unsubscribe`       | Client→Server | 購読解除                                             |

- **接続持続時間**：最大 **24 時間**
- 1つの WebSocket 接続で複数サブスクリプション可能

> **出典**：
>
> - https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-websocket-protocol.html
> - https://aws.amazon.com/about-aws/whats-new/2025/03/appsync-events-publishing-websocket-real-time-pub-sub/

---

### 1-6. HTTP Publish API のエンドポイントとリクエスト形式

```
POST https://<id>.appsync-api.<region>.amazonaws.com/event
```

```json
// リクエストボディ
{
  "channel": "/default/channel",
  "events": ["{\"event_1\":\"data_1\"}", "{\"event_2\":\"data_2\"}"]
}
```

- **メソッド**：POST のみ（Publishing のみサポート）
- **events 配列**：各要素は **文字列化（stringify）された JSON 値**である必要がある
- **バッチサイズ**：1リクエストで最大 **5 イベント**
- **認可ヘッダー例**（API Key）：`x-api-key: da2-xxxx`

> **出典**：
>
> - https://docs.aws.amazon.com/appsync/latest/eventapi/publish-http.html

---

### 1-7. 制限値（クォータ）

| 項目                                              | デフォルト値     | 増加可否 |
| ------------------------------------------------- | ---------------- | -------- |
| Event APIs per region                             | 50               | ✅       |
| Channel namespaces per API                        | 50               | ✅       |
| Batch size per publish request                    | **5 イベント**   | ❌       |
| Channel segments max                              | **5 セグメント** | ❌       |
| Channel segment characters max                    | **50 文字**      | ❌       |
| Publish payload size（1リクエスト全体）           | **1.2 MB**       | ❌       |
| Event size（1イベント）                           | **240 KB**       | ❌       |
| Subscription payload size                         | **240 KB**       | ❌       |
| Subscriptions per client connection（全API共通）  | **200**          | ✅       |
| Rate of connections per API                       | 2,000/秒         | ✅       |
| Rate of inbound events per API                    | 10,000/秒        | ✅       |
| Rate of outbound messages per API                 | 1,000,000/秒     | ✅       |
| Rate of publish requests per WebSocket connection | **25/秒**        | ❌       |
| Handler/resolver code size                        | **32 KB**        | ❌       |
| Request execution time                            | **30 秒**        | ❌       |

> **出典**：
>
> - https://docs.aws.amazon.com/general/latest/gr/appsync.html

---

## 2. Amazon API Gateway WebSocket API

### 2-1. $connect / $disconnect / $default / カスタムルートの仕様

| ルートキー     | トリガータイミング                                               | 認可設定                                               |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| `$connect`     | WebSocket アップグレードリクエスト時（接続確立前）               | **接続時のみ設定可能**（AuthN/AuthZ は接続時のみ実行） |
| `$disconnect`  | クライアントまたはサーバーが切断後                               | なし（ベストエフォート配信）                           |
| `$default`     | ルート選択式の評価失敗時、またはマッチするカスタムルートがない時 | 任意                                                   |
| カスタムルート | ルート選択式がルートキー値と一致した時                           | 任意                                                   |

- `$connect` インテグレーションが完了するまで接続は保留状態
- 認可失敗時：クライアントに `401` or `403` を返し接続を確立しない
- `$disconnect` は**ベストエフォート**（デリバリー保証なし）

> **出典**：
>
> - https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-overview.html
> - https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-route-keys-connect-disconnect.html

---

### 2-2. ルート選択式（Route Selection Expression）

- API レベルの属性 `routeSelectionExpression` で定義
- 形式：`$request.body.{path_to_body_element}`
- 例：`${request.body.action}` → JSON ボディの `action` フィールドで振り分け
- マッチするルートがなく `$default` も存在しない場合はエラー
- 非 JSON メッセージは常に `$default` にルーティング

```json
// 例：{ "action": "sendMessage" } というメッセージ
// → routeSelectionExpression: ${request.body.action}
// → routeKey: "sendMessage" のルートにマッチ
```

> **出典**：
>
> - https://docs.aws.amazon.com/apigateway/latest/developerguide/websocket-api-develop-routes.html
> - https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-selection-expressions.html

---

### 2-3. @connections API（PostToConnection, GetConnection, DeleteConnection）

すべて **IAM 認可 + SigV4 署名必須**。

| 操作                                   | HTTP メソッド | エンドポイント                                                                             |
| -------------------------------------- | ------------- | ------------------------------------------------------------------------------------------ |
| **PostToConnection**（メッセージ送信） | `POST`        | `https://{api-id}.execute-api.{region}.amazonaws.com/{stage}/@connections/{connection_id}` |
| **GetConnection**（接続情報取得）      | `GET`         | 同上                                                                                       |
| **DeleteConnection**（接続切断）       | `DELETE`      | 同上                                                                                       |

- **IAM ポリシー**：`execute-api:ManageConnections` アクションが必要
- **ARN 形式**：`arn:aws:execute-api:{region}:{account-id}:{api-id}/{stage}/POST/@connections`
- SDK 利用例：`@aws-sdk/client-apigatewaymanagementapi` の `ApiGatewayManagementApiClient`
- `GoneException`（HTTP 410）：接続確立前または切断後に POST した場合に発生

> **出典**：
>
> - https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api-connections.html
> - https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-control-access-iam.html

---

### 2-4. 接続の最大アイドル時間とハードリミット

| 制限                     | 値         | 増加可否 |
| ------------------------ | ---------- | -------- |
| **アイドルタイムアウト** | **10 分**  | ❌       |
| **接続最大持続時間**     | **2 時間** | ❌       |

- 10分間アイドル、または2時間で API Gateway がクローズ（ステータスコード `1001` を返す）
- 切断前にクライアントが再接続ロジックを実装する必要がある

> **出典**：
>
> - https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html
> - https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-overview.html

---

### 2-5. ペイロードサイズ制限

| 制限                           | 値         | 備考       |
| ------------------------------ | ---------- | ---------- |
| **WebSocket フレームサイズ**   | **32 KB**  | ❌増加不可 |
| **メッセージペイロードサイズ** | **128 KB** | ❌増加不可 |

- 128 KB を超えるメッセージは複数フレーム（各 32 KB 以下）に分割が必要
- 32 KB を超えるフレームを受信した場合、接続はコード `1009` でクローズされる
- `@connections` API 経由の PostToConnection にも同様の制限が適用される

> **出典**：
>
> - https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html

---

### 2-6. 認可（Lambda Authorizer, IAM, Cognito）の対応状況

| 認可タイプ                          | WebSocket での対応          | 備考                                |
| ----------------------------------- | --------------------------- | ----------------------------------- |
| **IAM（AWS_IAM）**                  | ✅ `$connect` ルートのみ    | SigV4 署名必須                      |
| **Lambda Authorizer（REQUEST 型）** | ✅ `$connect` ルートのみ    | パス変数は使用不可                  |
| **Cognito（JWT Authorizer）**       | ❌ **WebSocket では未対応** | JWT Authorizer は **HTTP API のみ** |

- **重要**：WebSocket API では Cognito JWT Authorizer を直接使用できない
- Cognito で認証したい場合は **Lambda Authorizer** を使い、その中でトークン検証を実装するのが標準パターン
- 認可は接続時（`$connect`）のみ実行される（以降のメッセージには再評価なし）

> **出典**：
>
> - https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-lambda-auth.html
> - https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html
> - https://docs.aws.amazon.com/apigateway/latest/developerguide/websocket-api-develop-routes.html

---

### 2-7. 410 Gone のハンドリング

- `@connections` API で **切断済み接続ID** に PostToConnection すると `GoneException`（HTTP 410）が返される
- 接続確立前のタイミングでも同様に発生
- **推奨対応**：410 を受信したら接続IDを DynamoDB 等のレジストリから削除し、再送試行しない

```javascript
try {
  await client.send(new PostToConnectionCommand({ ConnectionId, Data }));
} catch (error) {
  if (error.statusCode === 410) {
    // 接続IDを削除
    await dynamoDB.delete({ TableName, Key: { connectionId: ConnectionId } });
  }
}
```

> **出典**：
>
> - https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api-connections.html

---

### 2-8. WebSocket での SigV4 署名の方法

- `$connect` への WebSocket アップグレードリクエストは通常の HTTP リクエストと同様に SigV4 で署名
- `Upgrade` ヘッダー付きの HTTP リクエストとして扱い署名する
- **ブラウザから接続する場合**：`WebSocket` コンストラクタはカスタムヘッダーを設定できないため、SigV4 パラメータを **クエリ文字列**として渡す
  - `X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-Date`, `X-Amz-Expires`, `X-Amz-SignedHeaders`, `X-Amz-Signature`
- **サーバー側（Node.js 等）から接続する場合**：`Authorization` ヘッダーとして SigV4 署名を渡す
- @connections API の呼び出しも SigV4 署名必須（`execute-api:ManageConnections` アクション）

> **出典**：
>
> - https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-control-access-iam.html
> - https://repost.aws/questions/QUsnYQWS6nTcqRCP5dV8Ah9A/api-gateway-websocket-api-with-iam-authorization-on-connect-route

---

## 3. AWS Lambda Web Adapter

### 3-1. 公式リポジトリ・最新バージョン・提供方法

- **公式リポジトリ**：`aws/aws-lambda-web-adapter`（※ awslabs ではなく aws org）
  - https://github.com/aws/aws-lambda-web-adapter
- **最新バージョン**：`v1.0.0-rc1`（2025年時点の最新 GA リリース候補）
  - ※ `v0.9.1` が最後の安定 0.x リリース

#### Layer ARN（商用リージョン）

```
# x86_64
arn:aws:lambda:${AWS::Region}:753240598075:layer:LambdaAdapterLayerX86:27

# arm64
arn:aws:lambda:${AWS::Region}:753240598075:layer:LambdaAdapterLayerArm64:27
```

#### Docker イメージ

```dockerfile
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 \
  /lambda-adapter /opt/extensions/lambda-adapter
```

- `public.ecr.aws/awsguru/aws-lambda-adapter` にマルチアーキテクチャイメージが提供（x86_64 + arm64）

#### 設定方法（Zip パッケージの場合）

1. Layer ARN をアタッチ
2. 環境変数 `AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap` を設定
3. ハンドラにウェブアプリの起動スクリプト（例：`run.sh`）を指定

> **出典**：
>
> - https://github.com/aws/aws-lambda-web-adapter/blob/main/README.md
> - https://github.com/aws/aws-lambda-web-adapter/releases

---

### 3-2. 対応イベントソース

公式 README に明記されている対応イベントソース：

| イベントソース                                   | 対応                                     |
| ------------------------------------------------ | ---------------------------------------- |
| **Amazon API Gateway REST API**                  | ✅                                       |
| **Amazon API Gateway HTTP API**                  | ✅                                       |
| **Lambda Function URLs**                         | ✅                                       |
| **Application Load Balancer (ALB)**              | ✅                                       |
| **非 HTTP トリガー（SQS, SNS, EventBridge 等）** | ✅（`AWS_LWA_PASS_THROUGH_PATH` で受信） |
| **API Gateway WebSocket API**                    | ❌（非対応）                             |

> **出典**：
>
> - https://github.com/aws/aws-lambda-web-adapter（README Features セクション）

---

### 3-3. API Gateway WebSocket をサポートしているか？ — **NO**

**結論：API Gateway WebSocket API は Lambda Web Adapter の対応イベントソースに含まれていない（非対応）**

**根拠**：

1. 公式 README の Features セクションに「Supports Amazon API Gateway Rest API and **Http API** endpoints, Lambda Function URLs, and Application Load Balancer」と明示されており、WebSocket API は記載なし。
2. Lambda Web Adapter の動作原理として、受信した Lambda イベントを **HTTP/1.1 リクエスト形式に変換**してローカルサーバーへ転送する仕組みを採用している。
3. API Gateway WebSocket の Lambda プロキシ統合では、`APIGatewayWebsocketProxyRequest` という **WebSocket 専用のイベント形式**（`requestContext.routeKey`, `requestContext.connectionId` 等を含む）が渡される。この形式は HTTP リクエストへ変換できない。
4. WebSocket の `$connect`, `$disconnect`, `$default` や各メッセージはそれぞれ個別の Lambda 呼び出しとして届き、持続的な WebSocket 接続をプロセス内で管理できない。

> **出典**：
>
> - https://github.com/aws/aws-lambda-web-adapter（README Features）
> - https://aws.amazon.com/blogs/compute/using-response-streaming-with-aws-lambda-web-adapter-to-optimize-performance/

---

### 3-4. 環境変数一覧

| 環境変数                                 | デフォルト     | 説明                                                  |
| ---------------------------------------- | -------------- | ----------------------------------------------------- |
| `AWS_LWA_PORT`                           | `"8080"`       | トラフィックポート（`PORT` へのフォールバックも有効） |
| `AWS_LWA_READINESS_CHECK_PORT`           | `AWS_LWA_PORT` | ヘルスチェックポート                                  |
| `AWS_LWA_READINESS_CHECK_PATH`           | `"/"`          | ヘルスチェックパス                                    |
| `AWS_LWA_READINESS_CHECK_PROTOCOL`       | `"http"`       | `"http"` or `"tcp"`                                   |
| `AWS_LWA_READINESS_CHECK_HEALTHY_STATUS` | `"100-499"`    | 正常とみなす HTTP ステータスコード範囲                |
| `AWS_LWA_ASYNC_INIT`                     | `"false"`      | 初期化時間が長い関数の非同期初期化を有効化            |
| `AWS_LWA_REMOVE_BASE_PATH`               | None           | リクエストパスから除去するベースパス                  |
| `AWS_LWA_ENABLE_COMPRESSION`             | `"false"`      | gzip/br レスポンス圧縮（バッファードモードのみ）      |
| `AWS_LWA_INVOKE_MODE`                    | `"buffered"`   | `"buffered"` or `"response_stream"`                   |
| `AWS_LWA_PASS_THROUGH_PATH`              | `"/events"`    | 非 HTTP トリガーのイベントペイロードを受信するパス    |
| `AWS_LWA_AUTHORIZATION_SOURCE`           | None           | `Authorization` ヘッダーに置換するヘッダー名          |
| `AWS_LWA_ERROR_STATUS_CODES`             | None           | Lambda 呼び出し失敗とみなす HTTP ステータスコード     |

**非推奨（v2.0 で削除予定）**：`HOST`, `READINESS_CHECK_PORT`, `READINESS_CHECK_PATH`, `READINESS_CHECK_PROTOCOL`, `REMOVE_BASE_PATH`, `ASYNC_INIT`

> **出典**：
>
> - https://github.com/aws/aws-lambda-web-adapter/blob/main/README.md

---

### 3-5. Node.js（Express/Fastify/Hono）でのローカル実行と Lambda デプロイの両立方法

```javascript
// Express の例（ローカルでは 3000 番ポートで起動、Lambda では LWA が 8080 に転送）
const app = express();
// ... ルート定義 ...
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
```

- **ローカル実行**：通常の `node app.js` で起動
- **Lambda デプロイ**：Lambda Web Adapter が `AWS_LWA_PORT`（デフォルト 8080）でリクエストを受け付けてローカルサーバーに転送。`PORT` 環境変数でポートを統一可能
- `Dockerfile` または Layer + `run.sh` で同一コードを両環境にデプロイ可能
- `AWS_LWA_READINESS_CHECK_PATH` を `/health` 等に設定し、サーバー起動完了を確認後にトラフィックを受け付ける

> **出典**：
>
> - https://github.com/aws/aws-lambda-web-adapter/blob/main/README.md

---

## 4. 補足調査

### 4-1. API Gateway WebSocket からの Lambda 統合は「Lambda プロキシ統合」のみで、WebSocket 専用の event 形式が渡されるという認識は正しいか？

**→ ほぼ正しい。ただし非プロキシ統合（マッピングテンプレート使用）も存在する。**

- **Lambda プロキシ統合（`AWS_PROXY`）**：最も一般的。API Gateway が `APIGatewayWebsocketProxyRequest` 形式のイベントオブジェクトを Lambda に渡す。イベントには `requestContext.routeKey`, `requestContext.connectionId`, `requestContext.domainName` 等が含まれる。Lambda のレスポンスは `{ statusCode, body }` 形式。
- **非プロキシ統合**：マッピングテンプレート（VTL）を使って任意の形式に変換して渡すことも可能だが、HTTP リクエスト形式ではなく WebSocket コンテキスト変数（`$context.connectionId` 等）を使った変換になる。
- **重要**：`LAMBDA_PROXY` 統合では、Lambda の返すレスポンスボディはクライアントに自動返送されない（`route response` を定義しない限り）。双方向通信には `@connections` API 経由の PostToConnection か、RouteResponse の定義が必要。

> **出典**：
>
> - https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-routes-integrations.html
> - https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-route-keys-connect-disconnect.html

---

### 4-2. 「WebSocket ルートはハンドラ Lambda、Publish や管理 API は HTTP API + Web Adapter」という分離構成は妥当か？

**→ 妥当。これが現時点での合理的な設計パターン。**

**理由と根拠**：

1. **Lambda Web Adapter は WebSocket 非対応**（公式 README に非記載・前述 3-3 参照）
2. **WebSocket 専用イベント形式**は HTTP/1.1 形式に変換できないため、Web Adapter の仕組みが機能しない
3. **推奨分離パターン**：

| 機能                             | 構成                                                            |
| -------------------------------- | --------------------------------------------------------------- |
| WebSocket 接続・切断管理         | API Gateway WebSocket API → Lambda（ハンドラ Lambda）           |
| WebSocket メッセージルーティング | 同上（`$connect`, `$disconnect`, `$default`, カスタムルート）   |
| HTTP API（REST エンドポイント）  | API Gateway HTTP API + Lambda Web Adapter（Express/Hono 等）    |
| サーバーサイドからの Push        | @connections API（PostToConnection）を HTTP Lambda から呼び出す |

4. **代替案として AppSync Events の検討を推奨**：WebSocket のコネクション管理（DynamoDB への接続ID保存、@connections API の手動呼び出し等）が不要で、Pub/Sub パターンを完全マネージドで実現できる

> **出典**：
>
> - https://github.com/aws/aws-lambda-web-adapter（Features セクション）
> - https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-routes-integrations.html
> - https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-concepts.html

---

## 出典 URL 一覧

### AWS AppSync Events

- **概念**: https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-concepts.html
- **チャンネル名前空間**: https://docs.aws.amazon.com/appsync/latest/eventapi/channel-namespaces.html
- **WebSocket プロトコル**: https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-websocket-protocol.html
- **HTTP Publish**: https://docs.aws.amazon.com/appsync/latest/eventapi/publish-http.html
- **WebSocket Publish（2025年3月追加）**: https://docs.aws.amazon.com/appsync/latest/eventapi/publish-websocket.html
- **Event Handlers（onPublish/onSubscribe）**: https://docs.aws.amazon.com/appsync/latest/eventapi/channel-namespace-handlers.html
- **Event Handlers 概要**: https://docs.aws.amazon.com/appsync/latest/eventapi/event-handlers-overview.html
- **クォータ**: https://docs.aws.amazon.com/general/latest/gr/appsync.html
- **発表ブログ（2024年10月）**: https://aws.amazon.com/blogs/mobile/announcing-aws-appsync-events-serverless-websocket-apis/
- **WebSocket Publish 発表（2025年3月）**: https://aws.amazon.com/about-aws/whats-new/2025/03/appsync-events-publishing-websocket-real-time-pub-sub/

### Amazon API Gateway WebSocket API

- **概要**: https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-overview.html
- **ルート作成**: https://docs.aws.amazon.com/apigateway/latest/developerguide/websocket-api-develop-routes.html
- **$connect/$disconnect**: https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-route-keys-connect-disconnect.html
- **選択式**: https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-selection-expressions.html
- **@connections API**: https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api-connections.html
- **IAM 認可**: https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-control-access-iam.html
- **Lambda Authorizer**: https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-lambda-auth.html
- **ルートとインテグレーション**: https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-routes-integrations.html
- **クォータ（WebSocket）**: https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html
- **JWT Authorizer（HTTP API のみ）**: https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html

### AWS Lambda Web Adapter

- **公式リポジトリ（README）**: https://github.com/aws/aws-lambda-web-adapter
- **リリース一覧**: https://github.com/aws/aws-lambda-web-adapter/releases
- **解説ブログ**: https://aws.amazon.com/blogs/compute/using-response-streaming-with-aws-lambda-web-adapter-to-optimize-performance/
