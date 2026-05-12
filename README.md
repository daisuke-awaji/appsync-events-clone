# appsync-events-clone

AppSync Events 互換の Pub/Sub を **API Gateway WebSocket + Lambda + DynamoDB** で再現するリファレンス実装です。
TypeScript / AWS CDK で書かれており、HTTP API 部分は **Lambda Web Adapter + Hono** によりローカルでも `node` 単体で起動できます。

> 詳細な設計ドキュメント: [docs/PLAN.md](./docs/PLAN.md)
> AWS 公式仕様のファクトチェック結果: [docs/factcheck.md](./docs/factcheck.md)

## ステータス

| Phase | 内容                                                 | 状態 |
| ----- | ---------------------------------------------------- | ---- |
| 0     | リポジトリ雛形 + CI                                  | ✅   |
| 1     | core パッケージ（channel matcher, protocol）         | ✅   |
| 2     | WebSocket Lambda Handlers                            | ✅   |
| 3     | Fanout Worker（SQS → @connections）                  | ✅   |
| 4     | ワイルドカード対応（`*` / `**`）                     | ✅   |
| 5     | HTTP Publish API（Hono + Lambda Web Adapter）        | ✅   |
| 6     | Event Handler Lambda 連携（onPublish / onSubscribe） | ✅   |
| 7     | API Key 認可                                         | ✅   |
| -     | CDK インフラスタック（Data / Ws / Fanout / Http）    | ✅   |
| 8     | 観測性 + 負荷試験                                    | ⏳   |
| 9     | 実 AWS 環境での E2E 検証                             | ⏳   |

## アーキテクチャ

```
[Client] --(WSS)--> [API Gateway WebSocket]
                          ↓ $connect           → connect Lambda  → DDB Connections
                          ↓ subscribe          → subscribe Lambda (onSubscribe hook) → DDB Subscriptions
                          ↓ publish            → publish Lambda  (onPublish hook)    → SQS
                          ↓ unsubscribe        → unsubscribe Lambda
                          ↓ $disconnect        → disconnect Lambda (cleanup)
                          ↑ data frames        ← @connections.PostToConnection

[Server] --(HTTPS)--> [API Gateway HTTP] → Lambda (Hono + LWA) → SQS

[SQS] → fanout-worker → DDB Subscriptions (Query) → @connections.PostToConnection
                                                  → DDB Connections (delete on 410)
```

## パッケージ構成

| パッケージ               | 役割                                                  |
| ------------------------ | ----------------------------------------------------- |
| `packages/core`          | チャンネル文字列の解析・マッチング、Zod スキーマ      |
| `packages/ws-handlers`   | WebSocket 各ルートの純 Lambda Handler                 |
| `packages/fanout-worker` | SQS 駆動のファンアウト配信ワーカー                    |
| `packages/http-api`      | Hono アプリ。LWA で Lambda 化、ローカルで `node` 起動 |
| `infra/cdk`              | AWS CDK スタック（Data / Ws / Fanout / Http）         |

## 開発前提

- Node.js 20+
- pnpm 9+
- AWS CDK 2.x（インフラ層）

## クイックスタート

```bash
pnpm install
pnpm verify   # format:check + lint + typecheck + test (62 tests)
```

各種コマンド:

| コマンド                                    | 内容                                      |
| ------------------------------------------- | ----------------------------------------- |
| `pnpm test`                                 | 全パッケージの単体テスト + CDK synth 検証 |
| `pnpm test:watch`                           | watch モード                              |
| `pnpm lint`                                 | ESLint                                    |
| `pnpm typecheck`                            | tsc -b                                    |
| `pnpm format`                               | Prettier 適用                             |
| `pnpm verify`                               | CI と同じチェック一式                     |
| `pnpm --filter http-api dev`                | HTTP API をローカル起動（port 8080）      |
| `pnpm --filter cdk synth`                   | CloudFormation テンプレ生成               |
| `pnpm --filter cdk deploy -- -c apiKey=xxx` | デプロイ                                  |

## デプロイ

```bash
cd infra/cdk
pnpm cdk bootstrap   # 初回のみ
pnpm cdk deploy --all -c apiKey=$(openssl rand -hex 32)
```

主な出力:

- `WebSocketEndpoint`: `wss://<id>.execute-api.<region>.amazonaws.com/prod`
- `HttpEndpoint`: `https://<id>.execute-api.<region>.amazonaws.com`

## ライセンス

MIT
