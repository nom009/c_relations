// ============================================================================
// ストア内部の共通ヘルパ（store.ts から分割）: 閲覧のみガード・実績日の自動記録・選択/折り畳みの補助・
// 名前解決・稼働カレンダーの参照。useApp は関数本体の中でだけ参照する（モジュール評価時には触れない）。
// ============================================================================
import { normalizeTaskPatch } from "../domain/taskEditing";
import { actualsForStatusChange } from "../domain/schedule";
import type { CpmResult } from "../domain/cpm";
import { type Calendar, type Task, canConnect } from "../domain";
import type { ProjectRole } from "../storage/apiContract";
import { selectCpm } from "./selectors";
import { useApp } from "./store";
import type { AppState, DirtyState, Selection } from "./storeTypes";

export const emptyDirty = (): DirtyState => ({
  tasks: new Set(),
  deps: new Set(),
  deletedTasks: new Set(),
  deletedDeps: new Set(),
});

export function selectReadOnly(s: { role: ProjectRole | null }): boolean {
  return s.role === "viewer";
}

const READ_ONLY_TOAST_INTERVAL_MS = 3000;
let lastReadOnlyToastAt = 0;
// 閲覧のみ（viewer）ならデータ変更を拒否して true を返す（ローカル版は role=null で常に false）。
export function readOnlyBlocked(): boolean {
  if (useApp.getState().role !== "viewer") return false;
  const now = Date.now();
  if (now - lastReadOnlyToastAt > READ_ONLY_TOAST_INTERVAL_MS) {
    lastReadOnlyToastAt = now;
    useApp.getState().showToast("閲覧のみの権限です", true);
  }
  return true;
}

// 実績日の自動記録に使う CPM（ステータス/進捗を変える編集の時だけ・1アクション1回）。
export function cpmForStatusEdit(patch: Partial<Task>): CpmResult | null {
  if (patch.status === undefined && patch.progress === undefined) return null;
  const s = useApp.getState();
  return selectCpm(s.tasks, s.dependencies, s.project.dataDate, selectActiveCalendar(s));
}

// ステータスが変わる編集では実績日を自動記録する（パッチで明示した実績日が優先）。
export function patchWithActuals(
  t: Task,
  patch: Partial<Task>,
  cpm: CpmResult | null,
  today: string,
): Partial<Task> {
  const norm = normalizeTaskPatch(t, patch);
  if (!cpm || norm.status === undefined || norm.status === t.status) return norm;
  return { ...actualsForStatusChange(t, norm.status, cpm.byTask.get(t.id), today), ...norm };
}

export const noSelection = (): Selection => ({ taskId: null, edgeId: null, aggId: null });

// 折り畳み状態は表示（viewSpec）と永続（viewState）の両方へ同じ値を書く。
export function setCollapsedWbs(
  s: { viewSpec: { collapsedWbs: string[] }; viewState: { collapsedWbs: string[] } },
  collapsedWbs: string[],
): void {
  s.viewSpec.collapsedWbs = collapsedWbs;
  s.viewState.collapsedWbs = collapsedWbs;
}

export function currentWbsContext(): string {
  const s = useApp.getState();
  const selId = s.selection.taskId;
  if (selId) {
    const t = s.tasks.find((x) => x.id === selId);
    if (t) return t.wbsCode;
  }
  return "";
}

function nameOfState(s: AppState, id: string): string {
  const t = s.tasks.find((x) => x.id === id);
  return t ? t.name : id.slice(0, 6);
}

export function explainReject(
  chk: ReturnType<typeof canConnect>,
  s: AppState,
): string {
  if (chk.reason === "self") return "自己ループは作成できません";
  if (chk.reason === "duplicate") return "同じ依存が既に存在します";
  if (chk.reason === "cycle") {
    const names = (chk.path || []).map((id) => nameOfState(s, id));
    const shown =
      names.length > 6
        ? [...names.slice(0, 3), "…", ...names.slice(-2)]
        : names;
    return "循環依存になるため接続できません（" + shown.join(" → ") + "）";
  }
  return "接続できません";
}

export function nameOf(id: string): string {
  return nameOfState(useApp.getState(), id);
}

// 現在の稼働カレンダー（project.calendarId で参照。無ければ先頭）。selectCpm に渡す。
// 参照は immer が変更時のみ差し替えるため、全コンポーネントで同一参照＝selectCpm のキャッシュが効く。
export const selectActiveCalendar = (s: AppState): Calendar | null =>
  s.calendars.find((c) => c.id === s.project.calendarId) ??
  s.calendars[0] ??
  null;
