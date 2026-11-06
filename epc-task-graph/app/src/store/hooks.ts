// ============================================================================
// 導出値フック: 全ビュー共通の参照経路（CPM・テーブル行・選択タスク・担当候補）を1か所に集約。
// ============================================================================
import { useApp, selectActiveCalendar } from './store';
import {
  selectAssigneeOptions,
  selectCpm,
  selectTableRows,
  selectTaskIndex,
  selectVisibleGraph,
} from './selectors';
import type { CpmResult, DeriveResult, TableResult, Task } from '../domain';

export function useCpm(): CpmResult {
  const tasks = useApp((s) => s.tasks);
  const deps = useApp((s) => s.dependencies);
  const dataDate = useApp((s) => s.project.dataDate);
  const calendar = useApp(selectActiveCalendar);
  return selectCpm(tasks, deps, dataDate, calendar);
}

// キャンバスと左パネル統計が同じ表示グラフを共有する（§2.6）。
export function useVisibleGraph(): DeriveResult {
  const tasks = useApp((s) => s.tasks);
  const deps = useApp((s) => s.dependencies);
  const viewSpec = useApp((s) => s.viewSpec);
  const cpHighlight = useApp((s) => s.cpHighlight);
  const cpm = useCpm();
  return selectVisibleGraph(tasks, deps, viewSpec, cpHighlight, cpm);
}

// テーブルとガントが同じ行集合を共有する（§12.3.1）。
export function useTableRows(): TableResult {
  const tasks = useApp((s) => s.tasks);
  const deps = useApp((s) => s.dependencies);
  const viewSpec = useApp((s) => s.viewSpec);
  const sort = useApp((s) => s.tableSort);
  const cpm = useCpm();
  return selectTableRows(tasks, deps, viewSpec, sort, cpm);
}

export function useSelectedTask(): Task | undefined {
  return useApp((s) => (s.selection.taskId ? selectTaskIndex(s.tasks).get(s.selection.taskId) : undefined));
}

export function useAssigneeOptions(): string[] {
  return selectAssigneeOptions(useApp((s) => s.tasks));
}
