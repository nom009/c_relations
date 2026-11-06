// ============================================================================
// 導出値セレクタ（§9.1-9.2, §5.1/§12.3.1）: 入力の「参照」が変わった時だけ再計算する。
// immer は変更時のみ参照を差し替えるため、全コンポーネントで同じ入力参照＝キャッシュが共有される。
// CPM 結果・テーブル行は非永続の導出値（DBに焼かない）。
// ============================================================================
import {
  computeCpm,
  deriveTableRows,
  deriveVisibleGraph,
  type Calendar,
  type CpmResult,
  type DeriveResult,
  type Dependency,
  type Task,
  type TableResult,
  type TableSort,
  type ViewSpec,
} from '../domain';

// 直前1回分の引数（参照比較）と結果を保持するメモ化。
function memoizeLast<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  let lastArgs: A | null = null;
  let lastResult!: R;
  return (...args: A): R => {
    const prev = lastArgs;
    if (prev && prev.length === args.length && args.every((a, i) => a === prev[i])) return lastResult;
    lastResult = fn(...args);
    lastArgs = args;
    return lastResult;
  };
}

export const selectCpm: (
  tasks: Task[],
  deps: Dependency[],
  dataDate: string,
  calendar: Calendar | null,
) => CpmResult = memoizeLast(computeCpm);

// キャンバスと左パネル統計が同じ表示グラフを共有する（CPM を注入した viewSpec で導出）。
export const selectVisibleGraph = memoizeLast(
  (
    tasks: Task[],
    deps: Dependency[],
    viewSpec: ViewSpec,
    cpHighlight: boolean,
    cpm: CpmResult,
  ): DeriveResult =>
    deriveVisibleGraph(tasks, deps, {
      ...viewSpec,
      criticalTasks: cpm.criticalTasks,
      criticalEdges: cpm.criticalEdges,
      cpHighlight,
    }),
);

// テーブルとガントが同じ行集合を共有する（両ビューが同一引数で呼ぶのでキャッシュが当たる）。
export const selectTableRows = memoizeLast(
  (
    tasks: Task[],
    deps: Dependency[],
    viewSpec: ViewSpec,
    sort: TableSort[],
    cpm: CpmResult,
  ): TableResult =>
    deriveTableRows(tasks, deps, { ...viewSpec, criticalTasks: cpm.criticalTasks }, sort, cpm.byTask),
);

export const selectTaskIndex = memoizeLast(
  (tasks: Task[]): Map<string, Task> => new Map(tasks.map((t) => [t.id, t])),
);

export const selectAssigneeOptions = memoizeLast((tasks: Task[]): string[] =>
  [...new Set(tasks.map((t) => t.assignee).filter(Boolean))].sort(),
);
