// ============================================================================
// 進捗スケジュール（P6 方式）の補助: 基準日（Data Date）の鮮度・進捗状態・ベースライン差・
// ステータス変更時の実績日の補完。UI 非依存の純関数（CPM と同じ判定を共有する）。
// ============================================================================
import type { CpmTaskResult } from './cpm';
import type { Status, Task } from './types';

/** 進捗状態: 完了／着手済み（残作業のみ計算）／未着手（計画どおり計算）。 */
export type ProgressState = 'done' | 'started' | 'planned';

/** 基準日（進捗の締め日）がこの日数より古いと「更新が必要」とみなす。 */
export const STALE_DATA_DATE_DAYS = 7;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 利用者の現地日付 'YYYY-MM-DD'（UTC だと JST 午前9時前に前日になるため現地時刻で組み立てる）。 */
export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function utcDayOf(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((iso || '').trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000;
}

/** 暦日差（to − from）。UTC で数えるため時差・夏時間の影響を受けない。不正な日付は 0。 */
export function daysBetween(from: string, to: string): number {
  const a = utcDayOf(from);
  const b = utcDayOf(to);
  if (a == null || b == null) return 0;
  return Math.round(b - a);
}

/** 基準日が今日から STALE_DATA_DATE_DAYS 日を超えて古いか。 */
export function isStaleDataDate(dataDate: string, today: string): boolean {
  return daysBetween(dataDate, today) > STALE_DATA_DATE_DAYS;
}

/** 進捗状態（CPM と共通）。中断でも実績開始があれば着手済みとして扱う。 */
export function progressState(t: Task): ProgressState {
  if (t.status === 'DONE') return 'done';
  if (t.status === 'IN_PROGRESS') return 'started';
  if (t.status === 'ON_HOLD' && t.actualStart) return 'started';
  return 'planned';
}

/** ベースライン終了日との差（暦日・正=遅れ）。ベースライン終了日か CPM 結果が無ければ null。 */
export function finishVariance(t: Task, r: CpmTaskResult | undefined): number | null {
  if (!t.baselineFinish || !r) return null;
  return daysBetween(t.baselineFinish, r.finishDate);
}

/** 現在の計画（CPM 結果）をベースラインとして保存する値。終了日はその日を含む。 */
export function baselinePatch(r: CpmTaskResult): { baselineStart: string; baselineFinish: string } {
  return { baselineStart: r.esDate, baselineFinish: r.finishDate };
}

const minIso = (a: string, b: string): string => (a <= b ? a : b);

/**
 * ステータス変更時に補完する実績日（入力済みの実績は尊重し、未来日は today で頭打ち）。
 * NOT_STARTED は実績を消去、IN_PROGRESS は実績開始、DONE は実績開始/完了と進捗100%、ON_HOLD は変更なし。
 */
export function actualsForStatusChange(
  t: Task,
  next: Status,
  r: CpmTaskResult | undefined,
  today: string,
): Partial<Task> {
  switch (next) {
    case 'NOT_STARTED': {
      const patch: Partial<Task> = {};
      if (t.actualStart != null) patch.actualStart = null;
      if (t.actualFinish != null) patch.actualFinish = null;
      return patch;
    }
    case 'IN_PROGRESS': {
      const patch: Partial<Task> = {
        actualStart: t.actualStart || minIso(r?.esDate ?? today, today),
      };
      if (t.actualFinish != null) patch.actualFinish = null;
      return patch;
    }
    case 'DONE': {
      // マイルストーンは開始＝完了の1日（既に実績開始があればその日を優先）。
      const actualFinish = t.isMilestone
        ? t.actualFinish || t.actualStart || minIso(r?.finishDate ?? today, today)
        : t.actualFinish || minIso(r?.finishDate ?? today, today);
      const actualStart = t.isMilestone
        ? actualFinish
        : t.actualStart || minIso(r?.esDate ?? today, actualFinish);
      return { actualStart, actualFinish, progress: 100 };
    }
    default:
      return {};
  }
}
