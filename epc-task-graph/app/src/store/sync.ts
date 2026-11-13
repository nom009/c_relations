// ============================================================================
// サーバー版の同期状態（純粋ロジック）。store を import しない（循環回避・単体テスト容易化）。
//   ・revs: 行ID → 最後にサーバーと同期した rev（GraphPatch の baseRev の元）。
//   ・project/calendars/savedViews/viewState: 最後に同期した内容の JSON。差があるものだけ送る。
//   ・lastVersion: changes ポーリングの since。
// モード判定（import.meta.env）には依存せず、呼び出し側が SyncState を渡す。
// ============================================================================
import type { Calendar, Dependency, GraphDoc, ProjectMeta, SavedView, Task } from '../domain';
import type { ChangesResponse } from '../storage/apiContract';
import type { GraphPatch, RowConflict } from '../storage/GraphRepository';
import type { DirtySnapshot } from './persistence';

export interface SyncState {
  projectId: string | null;
  epoch: number; // プロジェクト切替/リセットのたびに増える。古い応答の取り込み防止に使う
  lastVersion: number;
  revs: Map<string, number>;
  project: string | null;
  calendars: string | null;
  savedViews: string | null;
  viewState: string | null;
}

export function createSyncState(): SyncState {
  return {
    projectId: null,
    epoch: 0,
    lastVersion: 0,
    revs: new Map(),
    project: null,
    calendars: null,
    savedViews: null,
    viewState: null,
  };
}

export const syncState: SyncState = createSyncState();

type SharedMeta = Pick<ProjectMeta, 'name' | 'description' | 'dataDate' | 'calendarId'>;

// サーバーと共有するプロジェクト項目（apiContract の共有範囲）。キー順を固定して JSON 比較する。
export function sharedMeta(p: SharedMeta): SharedMeta {
  return { name: p.name, description: p.description, dataDate: p.dataDate, calendarId: p.calendarId };
}
const json = (v: unknown) => JSON.stringify(v);

export function resetSync(sync: SyncState, doc: GraphDoc): void {
  sync.epoch += 1;
  sync.projectId = doc.project.id;
  sync.lastVersion = doc.project.version;
  sync.revs = new Map();
  for (const t of doc.tasks) sync.revs.set(t.id, t.rev);
  for (const d of doc.dependencies) sync.revs.set(d.id, d.rev);
  sync.project = json(sharedMeta(doc.project));
  sync.calendars = json(doc.calendars);
  sync.savedViews = json(doc.savedViews);
  sync.viewState = json(doc.viewState);
}

export function detachSync(sync: SyncState): void {
  sync.epoch += 1;
  sync.projectId = null;
  sync.revs = new Map();
}

// ---- 保存パッチ ----
export function buildApiPatch(doc: GraphDoc, dirty: DirtySnapshot, sync: SyncState): GraphPatch {
  const taskById = new Map(doc.tasks.map((t) => [t.id, t]));
  const depById = new Map(doc.dependencies.map((d) => [d.id, d]));
  const deletedTasks = new Set(dirty.deletedTasks);
  const deletedDeps = new Set(dirty.deletedDeps);
  const rev = (id: string) => sync.revs.get(id) ?? 0;

  const patch: GraphPatch = {
    projectId: doc.project.id,
    baseProjectVersion: sync.lastVersion,
    upsertTasks: dirty.tasks
      .filter((id) => !deletedTasks.has(id) && taskById.has(id))
      .map((id) => ({ ...taskById.get(id)!, baseRev: rev(id) })),
    // サーバーに存在しない行（未同期のまま削除/既にサーバー側で削除済み）の削除は送らない。
    deleteTaskIds: dirty.deletedTasks.filter((id) => rev(id) > 0).map((id) => ({ id, baseRev: rev(id) })),
    upsertDeps: dirty.deps
      .filter((id) => !deletedDeps.has(id) && depById.has(id))
      .map((id) => ({ ...depById.get(id)!, baseRev: rev(id) })),
    deleteDepIds: dirty.deletedDeps.filter((id) => rev(id) > 0).map((id) => ({ id, baseRev: rev(id) })),
  };
  const meta = sharedMeta(doc.project);
  if (json(meta) !== sync.project) patch.project = meta;
  if (json(doc.calendars) !== sync.calendars) patch.calendars = doc.calendars;
  if (json(doc.savedViews) !== sync.savedViews) patch.savedViews = doc.savedViews;
  if (json(doc.viewState) !== sync.viewState) patch.viewState = doc.viewState;
  return patch;
}

export function isPatchEmpty(p: GraphPatch): boolean {
  return (
    !p.upsertTasks.length &&
    !p.deleteTaskIds.length &&
    !p.upsertDeps.length &&
    !p.deleteDepIds.length &&
    !p.project &&
    !p.calendars &&
    !p.savedViews &&
    !p.viewState
  );
}

// 保存成功: 送った行の rev をサーバー採番へ更新し、送った周辺データを「同期済み」にする。
export function commitPatch(sync: SyncState, patch: GraphPatch, newRevs: Record<string, number>): void {
  for (const t of patch.upsertTasks) sync.revs.set(t.id, newRevs[t.id] ?? t.baseRev + 1);
  for (const d of patch.upsertDeps) sync.revs.set(d.id, newRevs[d.id] ?? d.baseRev + 1);
  for (const r of patch.deleteTaskIds) sync.revs.delete(r.id);
  for (const r of patch.deleteDepIds) sync.revs.delete(r.id);
  if (patch.project) sync.project = json(sharedMeta(patch.project as SharedMeta));
  if (patch.calendars) sync.calendars = json(patch.calendars);
  if (patch.savedViews) sync.savedViews = json(patch.savedViews);
  if (patch.viewState) sync.viewState = json(patch.viewState);
}

// ---- 他者の変更の取り込み計画 ----
export interface RemotePlan {
  upsertTasks: Task[];
  removeTaskIds: string[];
  upsertDeps: Dependency[];
  removeDepIds: string[];
  // 自分が削除済みのタスクに他者が足した依存。ストアには入れず、次回保存で削除として送る。
  pushDeleteDepIds: string[];
  settled: DirtySnapshot; // ダーティから外す行
  revs: [string, number | null][]; // 記録する rev（null は破棄）
  project?: ProjectMeta;
  calendars?: Calendar[];
  savedViews?: SavedView[];
}

export interface LocalView {
  tasks: readonly Task[];
  dependencies: readonly Dependency[];
  project: ProjectMeta;
  calendars: Calendar[];
  savedViews: SavedView[];
}

const emptySettled = (): DirtySnapshot => ({ tasks: [], deps: [], deletedTasks: [], deletedDeps: [] });

export function emptyPlan(): RemotePlan {
  return {
    upsertTasks: [],
    removeTaskIds: [],
    upsertDeps: [],
    removeDepIds: [],
    pushDeleteDepIds: [],
    settled: emptySettled(),
    revs: [],
  };
}

export function isPlanEmpty(p: RemotePlan): boolean {
  return (
    !p.upsertTasks.length &&
    !p.removeTaskIds.length &&
    !p.upsertDeps.length &&
    !p.removeDepIds.length &&
    !p.pushDeleteDepIds.length &&
    !p.revs.length &&
    !p.project &&
    !p.calendars &&
    !p.savedViews
  );
}

// 他者の変更のうち、自分が未保存で触っていない行だけを取り込む。触っている行は取り込まず、
// 保存時の 409 競合としてユーザーに選ばせる（rev も更新しない＝baseRev が古いまま残る）。
export function planRemoteChanges(
  changes: ChangesResponse,
  local: LocalView,
  dirty: DirtySnapshot,
  sync: SyncState,
): RemotePlan {
  const plan = emptyPlan();
  const dTasks = new Set(dirty.tasks);
  const dDelTasks = new Set(dirty.deletedTasks);
  const dDeps = new Set(dirty.deps);
  const dDelDeps = new Set(dirty.deletedDeps);

  for (const t of changes.tasks) {
    if (dTasks.has(t.id) || dDelTasks.has(t.id) || sync.revs.get(t.id) === t.rev) continue;
    plan.upsertTasks.push(t);
    plan.revs.push([t.id, t.rev]);
  }
  for (const id of changes.deletedTaskIds) {
    if (dDelTasks.has(id)) {
      // 両者が削除済み: 競合ではない。自分の削除は送らない。
      plan.settled.deletedTasks.push(id);
      plan.revs.push([id, null]);
    } else if (!dTasks.has(id)) {
      plan.removeTaskIds.push(id);
      plan.revs.push([id, null]);
    }
  }

  const removedTasks = new Set(plan.removeTaskIds);
  const present = new Set<string>();
  for (const t of local.tasks) if (!removedTasks.has(t.id)) present.add(t.id);
  for (const t of plan.upsertTasks) present.add(t.id);

  for (const d of changes.dependencies) {
    if (dDeps.has(d.id) || dDelDeps.has(d.id) || sync.revs.get(d.id) === d.rev) continue;
    if (!present.has(d.predecessorId) || !present.has(d.successorId)) {
      if (dDelTasks.has(d.predecessorId) || dDelTasks.has(d.successorId)) {
        plan.pushDeleteDepIds.push(d.id);
        plan.revs.push([d.id, d.rev]);
      }
      continue;
    }
    plan.upsertDeps.push(d);
    plan.revs.push([d.id, d.rev]);
  }
  for (const id of changes.deletedDepIds) {
    if (dDelDeps.has(id)) {
      plan.settled.deletedDeps.push(id);
      plan.revs.push([id, null]);
    } else if (!dDeps.has(id)) {
      plan.removeDepIds.push(id);
      plan.revs.push([id, null]);
    }
  }

  if (changes.project && sync.project === json(sharedMeta(local.project))) plan.project = changes.project;
  if (changes.calendars && sync.calendars === json(local.calendars)) plan.calendars = changes.calendars;
  if (changes.savedViews && sync.savedViews === json(local.savedViews)) plan.savedViews = changes.savedViews;
  return plan;
}

// 競合で「相手の変更を採用」を選んだ時の計画（サーバー行で置き換え／削除）。
export function planAdoptServer(conflicts: RowConflict[]): RemotePlan {
  const plan = emptyPlan();
  for (const c of conflicts) {
    const rev = c.serverRow ? c.serverRev : null;
    plan.revs.push([c.id, rev]);
    if (c.entity === 'task') {
      plan.settled.tasks.push(c.id);
      plan.settled.deletedTasks.push(c.id);
      if (c.serverRow) plan.upsertTasks.push(c.serverRow as Task);
      else plan.removeTaskIds.push(c.id);
    } else {
      plan.settled.deps.push(c.id);
      plan.settled.deletedDeps.push(c.id);
      if (c.serverRow) plan.upsertDeps.push(c.serverRow as Dependency);
      else plan.removeDepIds.push(c.id);
    }
  }
  return plan;
}

export function commitPlanRevs(sync: SyncState, plan: RemotePlan): void {
  for (const [id, rev] of plan.revs) {
    if (rev === null) sync.revs.delete(id);
    else sync.revs.set(id, rev);
  }
  if (plan.project) sync.project = json(sharedMeta(plan.project));
  if (plan.calendars) sync.calendars = json(plan.calendars);
  if (plan.savedViews) sync.savedViews = json(plan.savedViews);
}

// 「自分の変更で上書き」: サーバーの現 rev を baseRev として採用し直す（削除済みなら 0＝新規作成扱い）。
export function adoptServerRevs(sync: SyncState, conflicts: RowConflict[]): void {
  for (const c of conflicts) {
    if (c.serverRow && c.serverRev > 0) sync.revs.set(c.id, c.serverRev);
    else sync.revs.delete(c.id);
  }
}

// 行配列へ変更を適用（順序保持・置換・末尾追加・削除）。Undo 履歴の各状態にも同じ変更を重ねるために使う。
export function mergeRows<T extends { id: string }>(
  rows: readonly T[],
  upserts: ReadonlyMap<string, T>,
  removed: ReadonlySet<string>,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (removed.has(r.id)) continue;
    out.push(upserts.get(r.id) ?? r);
    seen.add(r.id);
  }
  for (const [id, u] of upserts) if (!seen.has(id)) out.push(u);
  return out;
}
