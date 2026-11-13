import { SqlStore } from './sqlStore';
import { MemoryStore } from './memoryStore';
import { StoreConfigError } from '../errors';
import type { ServerStore } from './types';

let cached: ServerStore | undefined;

// SQL_CONNECTION_STRING があれば Azure SQL。無ければ ALLOW_MEMORY_STORE=1（開発用）のときだけメモリ。
// それ以外は、本番でデータを黙って失わないよう構成エラー（500）にする。
export function getStore(): ServerStore {
  if (cached) return cached;
  const conn = process.env.SQL_CONNECTION_STRING;
  if (conn) {
    cached = new SqlStore(conn);
  } else if (process.env.ALLOW_MEMORY_STORE === '1') {
    console.warn('[api] ALLOW_MEMORY_STORE=1: using in-memory store (data is lost on restart)');
    cached = new MemoryStore();
  } else {
    throw new StoreConfigError('SQL_CONNECTION_STRING is not set (set ALLOW_MEMORY_STORE=1 for development only)');
  }
  return cached;
}
