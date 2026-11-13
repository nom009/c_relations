// ============================================================================
// 複数タブ対策: Web Locks で「書き込めるタブ」を1つに限定する。
// 2タブが同じIndexedDBへ書くと後勝ちで上書きされ、依存の循環すら永続化しうるため。
// navigator.locks が無い環境では従来どおり単独タブ前提（常に書込可）で動く。
// ============================================================================
const LOCK_NAME = "epc-task-graph-writer";

let writer = true;

/** このタブがDBへ書込んでよいか。ロック未取得の間は false。 */
export function isWriterTab(): boolean {
  return writer;
}

// 取得したロックはタブが閉じるまで保持する（コールバックが決して解決しない Promise を返す）。
const holdForever = () => new Promise<never>(() => undefined);

function getLocks(): LockManager | null {
  try {
    return typeof navigator !== "undefined" && navigator.locks ? navigator.locks : null;
  } catch {
    return null;
  }
}

/**
 * 書込ロックを確保する。すぐ取得できればそのまま解決。
 * 他タブが保持中は onBlocked を呼び、その間は isWriterTab() が false のまま、解放され次第解決する。
 */
export async function acquireWriterLock(onBlocked: () => void): Promise<void> {
  const locks = getLocks();
  if (!locks) return;
  const immediate = await new Promise<boolean>((resolve) => {
    locks
      .request(LOCK_NAME, { mode: "exclusive", ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        return holdForever();
      })
      // ロックAPIが使えない状況（opaque origin 等）は単独タブ扱いにする
      .catch(() => resolve(true));
  });
  if (immediate) return;
  writer = false;
  onBlocked();
  await new Promise<void>((resolve) => {
    locks
      .request(LOCK_NAME, { mode: "exclusive" }, () => {
        resolve();
        return holdForever();
      })
      .catch(() => resolve());
  });
  writer = true;
}
