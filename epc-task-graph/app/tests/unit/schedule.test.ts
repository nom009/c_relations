// ============================================================================
// 進捗スケジュール補助（schedule.ts）の純関数テスト: 日付差・基準日の鮮度・進捗状態・
// ベースライン差・ステータス変更時の実績日の補完。
// ============================================================================
import { describe, expect, it } from 'vitest';
import {
  actualsForStatusChange,
  baselinePatch,
  daysBetween,
  finishVariance,
  isStaleDataDate,
  progressState,
  todayIso,
} from '../../src/domain/schedule';
import { computeCpm } from '../../src/domain/cpm';
import { makeTask } from '../../src/domain/factory';
import type { Task } from '../../src/domain/types';

// 実績・ベースラインは makeTask でも渡せるが、明示のため後から展開して付与する。
function task(p: Partial<Task> = {}): Task {
  return { ...makeTask({ id: 'A', name: 'A', ...p }), ...p };
}

describe('schedule: 日付', () => {
  it('todayIso は現地日付の YYYY-MM-DD', () => {
    expect(todayIso(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(todayIso(new Date(2026, 11, 31, 0, 1))).toBe('2026-12-31');
  });

  it('daysBetween は暦日差（負・年またぎ可。不正値は 0）', () => {
    expect(daysBetween('2026-01-01', '2026-01-05')).toBe(4);
    expect(daysBetween('2026-01-05', '2026-01-01')).toBe(-4);
    expect(daysBetween('2025-12-30', '2026-03-01')).toBe(61);
    expect(daysBetween('bad', '2026-01-01')).toBe(0);
  });

  it('isStaleDataDate は基準日から7日を超えたら古い', () => {
    expect(isStaleDataDate('2026-01-01', '2026-01-08')).toBe(false);
    expect(isStaleDataDate('2026-01-01', '2026-01-09')).toBe(true);
    expect(isStaleDataDate('2026-01-10', '2026-01-01')).toBe(false);
  });
});

describe('schedule: 進捗状態とベースライン', () => {
  it('progressState: 完了／着手済み（中断でも実績開始あり）／未着手', () => {
    expect(progressState(task({ status: 'DONE' }))).toBe('done');
    expect(progressState(task({ status: 'IN_PROGRESS' }))).toBe('started');
    expect(progressState(task({ status: 'ON_HOLD', actualStart: '2026-01-02' }))).toBe('started');
    expect(progressState(task({ status: 'ON_HOLD' }))).toBe('planned');
    expect(progressState(task({ status: 'NOT_STARTED', actualStart: '2026-01-02' }))).toBe('planned');
  });

  it('finishVariance はベースライン終了日との暦日差（正=遅れ）。無ければ null', () => {
    const t = task({ durationDays: 5, baselineFinish: '2026-01-03' });
    const r = computeCpm([t], [], '2026-01-01').byTask.get('A');
    expect(r?.finishDate).toBe('2026-01-05');
    expect(finishVariance(t, r)).toBe(2);
    expect(finishVariance({ ...t, baselineFinish: '2026-01-07' }, r)).toBe(-2);
    expect(finishVariance({ ...t, baselineFinish: null }, r)).toBeNull();
    expect(finishVariance(t, undefined)).toBeNull();
  });

  it('baselinePatch は現在の開始日と（その日を含む）終了日', () => {
    const t = task({ durationDays: 5 });
    const r = computeCpm([t], [], '2026-01-01').byTask.get('A')!;
    expect(baselinePatch(r)).toEqual({ baselineStart: '2026-01-01', baselineFinish: '2026-01-05' });
  });
});

describe('schedule: actualsForStatusChange', () => {
  // 計画: 2026-01-05 開始・2026-01-09 終了（5日・線形）。
  const plan = task({ durationDays: 5 });
  const r = computeCpm([plan], [], '2026-01-05').byTask.get('A');

  it('NOT_STARTED: 入力済みの実績だけを消す（無ければ空）', () => {
    expect(actualsForStatusChange(plan, 'NOT_STARTED', r, '2026-01-07')).toEqual({});
    expect(
      actualsForStatusChange(task({ actualStart: '2026-01-02' }), 'NOT_STARTED', r, '2026-01-07'),
    ).toEqual({ actualStart: null });
    expect(
      actualsForStatusChange(
        task({ actualStart: '2026-01-02', actualFinish: '2026-01-03' }),
        'NOT_STARTED',
        r,
        '2026-01-07',
      ),
    ).toEqual({ actualStart: null, actualFinish: null });
  });

  it('IN_PROGRESS: 実績開始は入力済みを優先、無ければ計画開始（未来なら今日）。実績完了は消す', () => {
    expect(actualsForStatusChange(plan, 'IN_PROGRESS', r, '2026-01-07')).toEqual({ actualStart: '2026-01-05' });
    expect(actualsForStatusChange(plan, 'IN_PROGRESS', r, '2026-01-03')).toEqual({ actualStart: '2026-01-03' });
    expect(actualsForStatusChange(plan, 'IN_PROGRESS', undefined, '2026-01-07')).toEqual({
      actualStart: '2026-01-07',
    });
    expect(
      actualsForStatusChange(
        task({ actualStart: '2026-01-02', actualFinish: '2026-01-03' }),
        'IN_PROGRESS',
        r,
        '2026-01-07',
      ),
    ).toEqual({ actualStart: '2026-01-02', actualFinish: null });
  });

  it('DONE: 実績完了は計画終了（未来なら今日）、実績開始は計画開始（完了より後なら完了日）、進捗100%', () => {
    expect(actualsForStatusChange(plan, 'DONE', r, '2026-01-12')).toEqual({
      actualStart: '2026-01-05',
      actualFinish: '2026-01-09',
      progress: 100,
    });
    expect(actualsForStatusChange(plan, 'DONE', r, '2026-01-07')).toEqual({
      actualStart: '2026-01-05',
      actualFinish: '2026-01-07',
      progress: 100,
    });
    expect(actualsForStatusChange(plan, 'DONE', r, '2026-01-03')).toEqual({
      actualStart: '2026-01-03',
      actualFinish: '2026-01-03',
      progress: 100,
    });
    expect(
      actualsForStatusChange(task({ actualStart: '2026-01-06' }), 'DONE', undefined, '2026-01-08'),
    ).toEqual({ actualStart: '2026-01-06', actualFinish: '2026-01-08', progress: 100 });
  });

  it('DONE（マイルストーン）: 実績開始＝実績完了の同じ日', () => {
    const m = task({ isMilestone: true });
    const rm = computeCpm([m], [], '2026-01-05').byTask.get('A');
    expect(actualsForStatusChange(m, 'DONE', rm, '2026-01-07')).toEqual({
      actualStart: '2026-01-05',
      actualFinish: '2026-01-05',
      progress: 100,
    });
  });

  it('ON_HOLD: 実績は変えない', () => {
    expect(actualsForStatusChange(task({ actualStart: '2026-01-02' }), 'ON_HOLD', r, '2026-01-07')).toEqual({});
  });
});
