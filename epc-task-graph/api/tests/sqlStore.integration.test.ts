import { afterAll, describe } from 'vitest';
import { SqlStore } from '../src/store/sqlStore';
import { defineApiScenarios } from './scenarios';

// 実 SQL Server / Azure SQL がある場合のみ実行する。
// 例: MSSQL_TEST_CONNECTION="Server=localhost,1433;Database=epc_test;User Id=sa;Password=...;Encrypt=false;TrustServerCertificate=true"
const conn = process.env.MSSQL_TEST_CONNECTION;

describe.skipIf(!conn)('API（SqlStore 統合）', () => {
  const store = new SqlStore(conn ?? '');
  afterAll(() => store.close());
  defineApiScenarios(() => store);
});
