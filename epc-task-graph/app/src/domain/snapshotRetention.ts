// ============================================================================
// 保存履歴（スナップショット）の剪定規則。純関数（クライアント DexieRepository とサーバー API で共有）。
// ============================================================================
export const SNAPSHOT_KEEP = 5;
export const SNAPSHOT_KEEP_DAYS = 7;

function localDayKey(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// 剪定で残す seq を選ぶ。直近 keepRecent 件に加え、それより古いものは「ローカル日付ごとに最新1件」を
// 最大 keepDays 日分だけ残す（直近25分しか遡れない問題の対策）。
export function selectSnapshotsToKeep(
  rows: { seq: number; createdAt: string }[],
  keepRecent: number = SNAPSHOT_KEEP,
  keepDays: number = SNAPSHOT_KEEP_DAYS,
): Set<number> {
  const sorted = [...rows].sort((a, b) => b.seq - a.seq);
  const keep = new Set<number>(sorted.slice(0, keepRecent).map((r) => r.seq));
  const days = new Set<string>();
  for (const r of sorted.slice(keepRecent)) {
    if (days.size >= keepDays) break;
    const key = localDayKey(r.createdAt);
    if (key === null || days.has(key)) continue;
    days.add(key);
    keep.add(r.seq);
  }
  return keep;
}
