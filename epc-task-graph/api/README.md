# EPC Task Graph API

マルチユーザー版バックエンド。Azure Static Web Apps（Standard）の**マネージド Azure Functions**（Node 22 / `@azure/functions` v4 / HTTP トリガーのみ）＋ **Azure SQL**（`mssql`）＋ **Entra ID 認証**（SWA が付与する `x-ms-client-principal`）。

## API

エンドポイント・権限・ステータス・楽観ロックの規則は契約ファイルが唯一の定義です:
`../app/src/storage/apiContract.ts`（クライアントと共有）。

実装上の補足:

- 非メンバーには 404（存在を漏らさない）。メンバー照合は email（小文字）。初回アクセス時に `userId` / `name` を記録。
- パッチの衝突規則（all-or-nothing）
  - upsert: 行が存在 → `baseRev === 現rev` のときのみ可（`baseRev=0` は新規作成の意なので既存行とは衝突）。行が無い → `baseRev=0` のみ可（`baseRev>0` は他者に削除済み＝衝突、`serverRev=0`/`serverRow=null`）。
  - delete: 行が無い → 成功（冪等）。行が存在 → `baseRev === 現rev` のときのみ可（`baseRev=0`＝クライアント未同期の行、や rev 不一致は衝突）。
  - タスク削除は、それを参照する依存もカスケード削除（墓標付き）。
  - 適用後の全体を DAG・参照整合で検証し、不正なら 422 でロールバック。
- 書き込みはプロジェクト単位で直列化（SQL: `UPDLOCK, ROWLOCK`）。`viewState` はユーザー個人ごとに保存し、共有 `version` を進めない。
- スナップショット: PUT / restore / duplicate で作成、patch は前回から 5 分以上空いたときに `autosave`。剪定は共有の純関数 `selectSnapshotsToKeep`（`../app/src/domain/snapshotRetention.ts`）。
- `GET /api/health` は認証不要（`{"ok":true}`）。

## 環境変数

| 名前 | 用途 |
| --- | --- |
| `SQL_CONNECTION_STRING` | Azure SQL 接続文字列（ADO 形式。例: `Server=tcp:<host>,1433;Database=<db>;User Id=<u>;Password=<p>;Encrypt=true`）。設定されていれば SqlStore を使用。スキーマは初回利用時に冪等に自動作成（`sql/schema.sql` は参照用）。 |
| `ALLOW_MEMORY_STORE` | `1` のときだけ、接続文字列なしでメモリストアを使う（開発専用）。未設定かつ接続文字列も無い場合は 500（データを黙って失わない）。 |
| `DEV_USER_EMAIL` | 開発サーバーのみ。`x-ms-client-principal` が無いリクエストをこのユーザーとして扱う。 |
| `PORT` | 開発サーバーのポート（既定 7071）。 |
| `MSSQL_TEST_CONNECTION` | 設定時のみ SqlStore 統合テストを実行。 |
| `EXTERNALS` | ビルド時のみ。カンマ区切りのモジュール名を bundle から除外（例: `mssql`。その場合 `dist` と一緒に `node_modules` が必要）。 |

## ローカル開発

```powershell
cd epc-task-graph\api
npm install            # package-lock.json は無い（npm install を使う）
npm run typecheck
npm test
npm run dev            # http://localhost:7071/api/...（メモリストア。認証は x-ms-client-principal か DEV_USER_EMAIL）
```

## ビルド・デプロイ

```powershell
npm run build          # esbuild で src/index.ts → dist/index.js（cjs, node22）に bundle
```

SWA の API ロケーションに `epc-task-graph/api` を指定し、`platform.apiRuntime` を `node:22` にします。`staticwebapp.config.json` で `/api/*` に `authenticated` ロールを要求してください。Functions のアプリ設定に `SQL_CONNECTION_STRING` を登録します。

## 共有ドメインと zod の解決

検証ロジックは `../app/src/domain`（純 TypeScript + zod）を相対 import して共有します（`src/domain.ts` が唯一の入口）。そこでの `zod` は、build（esbuild プラグイン）・test（vitest プラグイン）・typecheck（tsconfig `paths`）のいずれでも **api 側の `node_modules/zod`** に解決されるため、`app` 側で `npm ci` していなくても動作します。
