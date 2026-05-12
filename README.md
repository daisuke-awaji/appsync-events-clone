# appsync-events-clone

AppSync Events 互換の Pub/Sub を **API Gateway WebSocket + Lambda + DynamoDB** で再現するリファレンス実装です。
TypeScript / AWS CDK で書かれており、HTTP API 部分は **Lambda Web Adapter + Hono** によりローカルでも `node` 単体で起動できます。

> 詳細な設計ドキュメント: [docs/PLAN.md](./docs/PLAN.md)
> AWS 公式仕様のファクトチェック結果: [docs/factcheck.md](./docs/factcheck.md)

## ステータス

| Phase | 内容                                         | 状態      |
| ----- | -------------------------------------------- | --------- |
| 0     | リポジトリ雛形 + CI                          | 🚧 進行中 |
| 1     | core パッケージ（channel matcher, protocol） | 🚧 進行中 |
| 2     | WebSocket MVP（完全一致）                    | ⏳        |
| 3     | fanout worker                                | ⏳        |
| 4     | ワイルドカード対応                           | ⏳        |
| 5     | HTTP Publish (LWA + Hono)                    | ⏳        |
| 6     | Event Handler Lambda 連携                    | ⏳        |
| 7     | API Key 認可                                 | ⏳        |
| 8     | 観測性 + 負荷試験                            | ⏳        |

## 開発前提

- Node.js 20+
- pnpm 9+
- AWS CDK 2.x（インフラ層）

## クイックスタート

```bash
pnpm install
pnpm verify   # format:check + lint + typecheck + test
```

各種コマンド:

| コマンド          | 内容                     |
| ----------------- | ------------------------ |
| `pnpm test`       | 全パッケージの単体テスト |
| `pnpm test:watch` | watch モード             |
| `pnpm lint`       | ESLint                   |
| `pnpm typecheck`  | tsc -b                   |
| `pnpm format`     | Prettier 適用            |
| `pnpm verify`     | CI と同じチェック一式    |

## ライセンス

MIT
