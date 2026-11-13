-- アプリ専用の最小権限 DB ユーザーを作成する（Azure SQL Database・包含ユーザー）。
-- 実行: 管理者（sqlAdminLogin）で「ユーザーデータベース」(<prefix>-db) に接続して実行する。
--       Azure ポータル → SQL データベース → クエリ エディターが手軽（初回はクライアント IP の許可を求められる）。
-- <APP_PASSWORD> は main.bicep の sqlAppPassword と同じ値に置き換える。
-- 何度実行しても安全（既存ならパスワードのみ更新）。

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'crelations_app')
  CREATE USER [crelations_app] WITH PASSWORD = '<APP_PASSWORD>';
ELSE
  ALTER USER [crelations_app] WITH PASSWORD = '<APP_PASSWORD>';

-- データの読み書き
ALTER ROLE db_datareader ADD MEMBER [crelations_app];
ALTER ROLE db_datawriter ADD MEMBER [crelations_app];

-- 初回アクセス時の自動テーブル作成（api/src/store/schema.ts）と将来のスキーマ追加に必要な最小限。
-- テーブル作成が済み今後のスキーマ変更が無い運用なら、次の 2 行を REVOKE しても動作する。
GRANT CREATE TABLE TO [crelations_app];
GRANT ALTER ON SCHEMA::dbo TO [crelations_app];
