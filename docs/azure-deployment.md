# サーバー版（複数人編集）を Azure に構築する

GitHub Pages 版（ブラウザ内保存・1人用）は公開デモとして残り、画面に「デモ版」と表示されます。本番はサーバー版で、
別URL（Azure Static Web Apps）で動きます。同じコードを `VITE_STORAGE=api` でビルドしたものです。

```
ブラウザ ──(Entra ID ログイン)──> Azure Static Web Apps ──> /api (Functions, Node 22) ──> Azure SQL
```

- ログイン: 社内テナントの Entra ID のみ。プロジェクトごとに 所有者 / 編集者 / 閲覧者 を招待（メールアドレス）。
- 同時編集: 行単位の楽観ロック。同じタスクを同時に変えた時だけ「相手の変更を採用 / 自分の変更で上書き」を選ぶ。
  他の人の変更は約10秒ごとに自動で反映。
- 保存履歴: サーバー側に保持（直近5件＋日ごと7日分）。

## 費用の目安

| リソース | プラン | 目安 |
|---|---|---|
| Static Web Apps | Standard（テナント限定ログインに必須） | 約 $9/月 |
| Azure SQL Database | サーバーレス＋無料枠（月10万vCore秒） | 小規模なら $0。無料枠を超えた分は従量課金で継続（既定。月額予算アラートで検知） |
| Application Insights | ログ保持30日 | 小規模なら無料枠内 |

## 手順（初回のみ）

前提: Azure サブスクリプション、リソースグループ作成権限、Entra ID のアプリ登録権限（なければ管理者に依頼）。

### 1. Entra ID アプリ登録

1. Azure ポータル → Microsoft Entra ID → アプリの登録 → 新規登録
   - 名前: `c-relations`、サポートされるアカウント: **この組織ディレクトリのみ**
   - リダイレクト URI は手順3の後で設定（Web）
2. 「証明書とシークレット」→ クライアントシークレットを作成し、値を控える
3. 「認証」→ **ID トークン** にチェック
4. 控えるもの: アプリケーション(クライアント)ID、ディレクトリ(テナント)ID、シークレット値

### 2. Azure リソースを作成

Azure Cloud Shell（ポータル右上の `>_`）で:

```bash
az group create -n rg-c-relations -l japaneast
az deployment group create -g rg-c-relations \
  --template-file epc-task-graph/infra/main.bicep \
  --parameters sqlAdminLogin=crelationsadmin \
               sqlAdminPassword='<十分に長いパスワード>' \
               sqlAppPassword='<アプリ専用ユーザーのパスワード（管理者とは別）>' \
               aadClientId='<クライアントID>' \
               aadClientSecret='<シークレット値>' \
               alertEmails='["you@example.com"]' \
               monthlyBudget=30
```

- `alertEmails` を指定すると、API の死活監視・5xx 多発のアラートと、月額予算（80%/100%）の通知が有効になります（省略可。省略時はアラート/予算なし）。
- `sqlFreeLimitExhaustion=AutoPause` を付けると、無料枠を使い切った時に課金せず月末まで DB を停止します（その間サーバー版は使えません）。既定の `BillOverUsage` は課金して継続します。

（リポジトリを Cloud Shell に clone するか、`main.bicep` をアップロードして実行）

出力の `loginRedirectUri` と `staticWebAppName` を控えます。

### 2b. アプリ専用の DB ユーザーを作成

API は管理者ではなく最小権限のユーザー（`crelations_app`）で DB に接続します。作成しないと API が DB に接続できません。

1. Azure ポータル → SQL データベース（`<prefix>-db`）→ クエリ エディターに管理者（`sqlAdminLogin`）でログイン（初回はクライアント IP の許可を求められるので許可）
2. `epc-task-graph/infra/sql/create-app-user.sql` の `<APP_PASSWORD>` を `sqlAppPassword` と同じ値に置き換えて実行

### 3. リダイレクト URI を登録

アプリ登録 →「認証」→ プラットフォーム「Web」に `loginRedirectUri`（`https://<ホスト名>/.auth/login/aad/callback`）を追加。

### 4. GitHub にデプロイ情報を登録

```bash
az staticwebapp secrets list -n <staticWebAppName> -g rg-c-relations --query properties.apiKey -o tsv
```

配信元リポジトリ → Settings で次を登録します（どのリポジトリ・Environment に置くかは下の「配信先の設定」を参照）。

- Environments: `production`（検証環境なら `staging`）を作成し、その Environment に
  - Secret: `AZURE_STATIC_WEB_APPS_API_TOKEN` = 上記の値
  - Variable: `AZURE_TENANT_ID` = テナントID
- Secrets and variables → Actions → Variables（リポジトリ変数）:
  - `DEPLOY_AZURE` = `true`
  - `AZURE_ENVIRONMENT` = 上で作った Environment 名（省略時 `production`）

### 5. デプロイ

`main` に push すると、CI（lint・単体・E2E・API 結合テスト）が全て通った後に、有効化された配信先へデプロイされます。
CI では API の単体テストに加え、SQL Server コンテナ上での結合テストとサーバー版 E2E も実行しています。
API は `npm run package:deploy` で `epc-task-graph/api-deploy/` に組み立てられ（mssql のみ実行時依存として同梱）、それがそのまま SWA に載ります。
デプロイ先 URL は Actions の実行結果（Environment の URL）にも表示されます。

### 6. 使い始める

1. `https://<ホスト名>/` を開き社内アカウントでログイン → 最初のプロジェクトが自動で作られ、自分が所有者になる
2. 既存データの移行: デモ版（GitHub Pages）で「データ → JSONを書き出す」→ サーバー版で「データ → JSONを読み込む…」
   （新しいプロジェクトとして取り込まれ、読み込んだ人が所有者になる。1ファイル 20MB まで）
3. ヘッダーの「メンバー」からメールアドレスで招待（編集者/閲覧者）。招待された人はログインすると一覧に表示される

## 配信先の設定（検証 → 本番）

配信先はリポジトリ変数で明示的に有効化します（未設定の配信先には何も出ません）。

| 変数 | 値 | 効果 |
|---|---|---|
| `DEPLOY_PAGES` | `true` | 公開デモ版を GitHub Pages へ（「デモ版」表示付き） |
| `DEPLOY_AZURE` | `true` | サーバー版を Azure へ。シークレット/テナントIDが無いと CI はエラーで止まる |
| `AZURE_ENVIRONMENT` | 例 `staging` / `production` | 使う GitHub Environment（既定 `production`） |

推奨構成:

| リポジトリ | 役割 | 設定 |
|---|---|---|
| 個人 fork（開発・検証） | デモ版＋検証環境 | `DEPLOY_PAGES=true`。検証時は `DEPLOY_AZURE=true`・`AZURE_ENVIRONMENT=staging`（検証用リソースグループの SWA トークン） |
| 会社の Organization（本番） | 本番のみ | `DEPLOY_AZURE=true`・`AZURE_ENVIRONMENT=production`。`DEPLOY_PAGES` は設定しない |

### Organization へ移管するとき

1. Organization に private リポジトリを作成し、`main` を push（Actions を有効化）
2. 本番用のリソースグループ・Entra アプリ登録（リダイレクト URI は本番 SWA のもの）を用意し、手順 2〜3 を実施
3. Environment `production` を作成し、**Required reviewers（承認者）** と **Deployment branches: main のみ** を設定。
   シークレット/テナントIDはこの Environment に登録（手順 4）
4. ブランチ保護（Settings → Rules）: `main` への直接 push 禁止、PR 必須、CI の全ジョブ成功を必須に
5. Dependabot（`.github/dependabot.yml`）が週1回、依存更新の PR を作る。CI が通ったものをマージ
6. 個人 fork 側は `DEPLOY_AZURE` を削除し、検証用 SWA のデプロイトークンを再生成して旧トークンを無効化
   （`az staticwebapp secrets reset-api-key -n <検証用SWA名> -g <検証用RG>`）。検証環境が不要ならリソースグループごと削除

## 運用メモ

- DB の自動停止: 60 分アクセスが無いと一時停止し、次のアクセスで再開します（最大 1 分）。API は再開を待って接続を再試行し、画面には「サーバーを起動しています…」と表示されます。
- 監視: Application Insights（Azure ポータル → `<prefix>-ai-…` → 障害 / ログ）。`alertEmails` 指定時は死活監視と 5xx アラートが届きます。
- リクエスト本文の上限は 20MB（超えると 413）。
- DB のバックアップ: Azure SQL の自動バックアップ（ポイントインタイムリストア 7日）。アプリ内の保存履歴とは別。
- シークレットの更新: アプリ登録のシークレット期限前に新しい値を SWA のアプリ設定 `AAD_CLIENT_SECRET` に設定。
  期限（最長 24 か月）は作成時にカレンダーへ登録しておく。
- ログインできる人を絞る: Entra ID → エンタープライズ アプリケーション → `c-relations` → プロパティ →
  「割り当てが必要」をはい → 「ユーザーとグループ」で対象グループを割り当て（アプリの変更は不要）。
  社外の人は Entra ID にゲスト招待すると同じ手順で使える。
- テーブルは API の初回アクセス時に自動作成されます（`epc-task-graph/api/sql/schema.sql` と同じ定義）。
- ローカル開発: `epc-task-graph/api/README.md` を参照（メモリ上のDBで API を起動し、`VITE_STORAGE=api npm run dev`）。
