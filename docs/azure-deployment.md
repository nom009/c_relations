# サーバー版（複数人編集）を Azure に構築する

GitHub Pages 版（ブラウザ内保存・1人用）はそのまま残ります。サーバー版は別URL（Azure Static Web Apps）で動き、
同じコードを `VITE_STORAGE=api` でビルドしたものです。

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
| Azure SQL Database | サーバーレス＋無料枠（月10万vCore秒） | 小規模なら $0（超過時は自動一時停止） |

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
               aadClientId='<クライアントID>' \
               aadClientSecret='<シークレット値>'
```

（リポジトリを Cloud Shell に clone するか、`main.bicep` をアップロードして実行）

出力の `loginRedirectUri` と `staticWebAppName` を控えます。

### 3. リダイレクト URI を登録

アプリ登録 →「認証」→ プラットフォーム「Web」に `loginRedirectUri`（`https://<ホスト名>/.auth/login/aad/callback`）を追加。

### 4. GitHub にデプロイ情報を登録

```bash
az staticwebapp secrets list -n <staticWebAppName> -g rg-c-relations --query properties.apiKey -o tsv
```

GitHub の `nom009/c_relations` → Settings → Secrets and variables → Actions:

- Secrets: `AZURE_STATIC_WEB_APPS_API_TOKEN` = 上記の値
- Variables: `AZURE_TENANT_ID` = テナントID

### 5. デプロイ

`main` に push すると CI が通った後に GitHub Pages と Azure の両方へデプロイされます
（シークレット未登録の間は Azure へのデプロイは自動でスキップ）。
CI では API の単体テストに加え、SQL Server コンテナ上での結合テストとサーバー版 E2E も実行しています。
API は `npm run package:deploy` で `epc-task-graph/api-deploy/` に組み立てられ（mssql のみ実行時依存として同梱）、それがそのまま SWA に載ります。

### 6. 使い始める

1. `https://<ホスト名>/` を開き社内アカウントでログイン → 最初のプロジェクトが自動で作られ、自分が所有者になる
2. 既存データの移行: GitHub Pages 版で「JSONエクスポート」→ サーバー版で「インポート」
3. ヘッダーの「メンバー」からメールアドレスで招待（編集者/閲覧者）。招待された人はログインすると一覧に表示される

## 運用メモ

- DB のバックアップ: Azure SQL の自動バックアップ（ポイントインタイムリストア 7日）。アプリ内の保存履歴とは別。
- シークレットの更新: アプリ登録のシークレット期限前に新しい値を SWA のアプリ設定 `AAD_CLIENT_SECRET` に設定。
- テーブルは API の初回アクセス時に自動作成されます（`epc-task-graph/api/sql/schema.sql` と同じ定義）。
- ローカル開発: `epc-task-graph/api/README.md` を参照（メモリ上のDBで API を起動し、`VITE_STORAGE=api npm run dev`）。
