// サーバー版の初回読込用: DB の自動停止からの再開待ち（サーバーが 5xx を返す間）は
// 時間予算の範囲で再試行し、待っていることを UI へ知らせる。
// 何を「待てば直る」とみなすかは呼び出し側の述語で決める（ApiRepository の isServerWaking）。

export interface WakeRetryOptions {
  budgetMs?: number;
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_BUDGET_MS = 120_000;
const DEFAULT_DELAYS_MS = [2000, 3000, 5000, 8000];

let wakeListener: (() => void) | null = null;
export function setServerWakingListener(fn: (() => void) | null): void {
  wakeListener = fn;
}

export async function retryWhileWaking<T>(
  fn: () => Promise<T>,
  isWaking: (e: unknown) => boolean,
  opts: WakeRetryOptions = {},
): Promise<T> {
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
      if (!isWaking(e) || now() - start + delay > budget) throw e;
      if (attempt === 0) wakeListener?.();
      await sleep(delay);
    }
  }
}
