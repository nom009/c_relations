// Azure SQL サーバーレスは自動一時停止からの再開に最大 1 分ほどかかり、その間のログインは
// 一時的エラー（40613 等）で失敗する。接続確立だけは時間予算の範囲で再試行して吸収する。

export function sqlErrNumber(e: unknown): number | undefined {
  const x = e as { number?: unknown; originalError?: { number?: unknown; info?: { number?: unknown } } } | null;
  const n = x?.number ?? x?.originalError?.number ?? x?.originalError?.info?.number;
  return typeof n === 'number' ? n : undefined;
}

// 再開中・フェイルオーバー・スロットリングなど、待てば解消する Azure SQL のエラー番号。
const TRANSIENT_NUMBERS = new Set([4060, 40197, 40501, 40613, 49918, 49919, 49920, 10928, 10929, 10053, 10054, 10060, 233, 64]);
const TRANSIENT_CODES = new Set(['ETIMEOUT', 'ESOCKET', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT']);

export function isTransientSqlError(e: unknown): boolean {
  const n = sqlErrNumber(e);
  if (n !== undefined && TRANSIENT_NUMBERS.has(n)) return true;
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TRANSIENT_CODES.has(code);
}

export interface RetryOptions {
  /** 最初の試行開始からの許容時間（超えたら最後のエラーを投げる） */
  budgetMs?: number;
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// SWA のゲートウェイは約 45 秒で打ち切るため、既定の予算はそれより短くする。
const DEFAULT_BUDGET_MS = 35_000;
const DEFAULT_DELAYS_MS = [1000, 2000, 3000, 5000];

export async function retryTransient<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const budget = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const delays = opts.delaysMs ?? DEFAULT_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const start = now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const delay = delays[Math.min(attempt, delays.length - 1)]!;
      if (!isTransientSqlError(e) || now() - start + delay > budget) throw e;
      await sleep(delay);
    }
  }
}
