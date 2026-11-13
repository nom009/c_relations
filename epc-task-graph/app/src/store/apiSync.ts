// ============================================================================
// サーバー版（VITE_STORAGE=api）専用の同期層。main.tsx が API_MODE の時だけ動的 import する。
//   ・store.ts へ ApiHooks を差し込む（競合解決・保存エラー処理・同期状態の採用）。
//   ・changes ポーリングで他メンバーの変更を取り込む（Undo 履歴・ダーティ・保存を汚さない）。
//   ・E2E/DEV ビルドでは window.__SYNC を公開する。
// 純粋ロジック（パッチ生成・取込計画）は sync.ts。ここは副作用（fetch・ストア更新・タイマー）だけ。
// ============================================================================
import type { Dependency, GraphDoc, Task } from '../domain';
import {
  AuthRequiredError,
  ForbiddenError,
  NotFoundError,
  ServerValidationError,
  getApiRepository,
  redirectToLogin,
} from '../storage/ApiRepository';
import type { RowConflict } from '../storage/GraphRepository';
import { downloadJson } from './backup';
import {
  flushPersistence,
  installApiHooks,
  isFlushing,
  useApp,
  type ApiHooks,
  type AppState,
} from './store';
import {
  adoptServerRevs,
  commitPlanRevs,
  detachSync,
  mergeRows,
  planAdoptServer,
  planRemoteChanges,
  resetSync,
  syncState,
  type RemotePlan,
} from './sync';
import type { DirtySnapshot } from './persistence';

const repo = getApiRepository();

const POLL_INTERVAL_MS = 10_000;
const ROLE_REFRESH_EVERY = 6; // 6回に1回（約1分）プロジェクト一覧と権限を取り直す
const RETRY_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000];

type HistoryEntry = Partial<Pick<AppState, 'tasks' | 'dependencies'>>;

function dirtySnapshot(): DirtySnapshot {
  const d = useApp.getState().dirty;
  return {
    tasks: [...d.tasks],
    deps: [...d.deps],
    deletedTasks: [...d.deletedTasks],
    deletedDeps: [...d.deletedDeps],
  };
}

// ---------------------------------------------------------------------------
// 取込: 計画をストアへ反映（Undo 履歴に積まない・ダーティにしない・保存を起動しない）
// ---------------------------------------------------------------------------
function applyPlan(plan: RemotePlan): void {
  const upT = new Map(plan.upsertTasks.map((t) => [t.id, t] as const));
  const rmT = new Set(plan.removeTaskIds);
  const upD = new Map(plan.upsertDeps.map((d) => [d.id, d] as const));
  const rmD = new Set(plan.removeDepIds);
  const tasksTouched = upT.size > 0 || rmT.size > 0;
  const depsTouched = upD.size > 0 || rmD.size > 0 || tasksTouched;

  const temporal = useApp.temporal.getState();
  temporal.pause();
  try {
    const st = useApp.getState();
    const tasks: Task[] = tasksTouched ? mergeRows(st.tasks, upT, rmT) : st.tasks;
    const taskIds = new Set(tasks.map((t) => t.id));
    let deps: Dependency[] = st.dependencies;
    let cascaded = false;
    if (depsTouched) {
      const merged = mergeRows(st.dependencies, upD, rmD);
      deps = merged.filter((d) => taskIds.has(d.predecessorId) && taskIds.has(d.successorId));
      cascaded = deps.length !== merged.length;
    }
    useApp.setState((s) => {
      if (tasksTouched) s.tasks = tasks;
      if (depsTouched) s.dependencies = deps;
      if (tasksTouched || cascaded) {
        s.selectedIds = s.selectedIds.filter((id) => taskIds.has(id));
        if (s.connectSource && !taskIds.has(s.connectSource)) s.connectSource = null;
        if (s.selection.taskId && !taskIds.has(s.selection.taskId)) s.selection.taskId = null;
        if (s.editingId && !taskIds.has(s.editingId)) s.editingId = null;
      }
      if (s.selection.edgeId && !deps.some((d) => d.id === s.selection.edgeId)) s.selection.edgeId = null;
      for (const id of plan.settled.tasks) s.dirty.tasks.delete(id);
      for (const id of plan.settled.deletedTasks) s.dirty.deletedTasks.delete(id);
      for (const id of plan.settled.deps) s.dirty.deps.delete(id);
      for (const id of plan.settled.deletedDeps) s.dirty.deletedDeps.delete(id);
      for (const id of plan.pushDeleteDepIds) s.dirty.deletedDeps.add(id);
      if (plan.project) s.project = { ...s.project, ...plan.project };
      if (plan.calendars) s.calendars = plan.calendars;
      if (plan.savedViews) s.savedViews = plan.savedViews;
    });

    // 履歴の各状態にも同じ変更を重ねる（Undo が他者の変更を黙って巻き戻さないように）。
    if (tasksTouched || depsTouched) {
      const rebase = (e: HistoryEntry): HistoryEntry => ({
        ...e,
        ...(e.tasks ? { tasks: mergeRows(e.tasks, upT, rmT) } : {}),
        ...(e.dependencies
          ? {
              dependencies: mergeRows(e.dependencies, upD, rmD).filter(
                (d) => !rmT.has(d.predecessorId) && !rmT.has(d.successorId),
              ),
            }
          : {}),
      });
      const h = useApp.temporal.getState();
      if (h.pastStates.length || h.futureStates.length)
        useApp.temporal.setState({
          pastStates: h.pastStates.map(rebase),
          futureStates: h.futureStates.map(rebase),
        });
    }
  } finally {
    temporal.resume();
  }
}

// ---------------------------------------------------------------------------
// 競合ダイアログ
// ---------------------------------------------------------------------------
let pendingConflict: { conflicts: RowConflict[]; resolve: () => void } | null = null;

function describeConflict(c: RowConflict, st: AppState): string {
  if (c.entity === 'task') {
    const local = st.tasks.find((t) => t.id === c.id);
    const server = c.serverRow as Task | null;
    return `タスク: ${local?.name ?? server?.name ?? c.id.slice(0, 6)}${c.serverRow ? '' : '（相手が削除）'}`;
  }
  const dep = st.dependencies.find((d) => d.id === c.id) ?? (c.serverRow as Dependency | null);
  const nameOf = (id: string) => st.tasks.find((t) => t.id === id)?.name ?? id.slice(0, 6);
  return dep
    ? `依存関係: ${nameOf(dep.predecessorId)} → ${nameOf(dep.successorId)}${c.serverRow ? '' : '（相手が削除）'}`
    : `依存関係: ${c.id.slice(0, 6)}`;
}

function resolveConflicts(conflicts: RowConflict[]): Promise<void> {
  const st = useApp.getState();
  const names = conflicts.map((c) => describeConflict(c, st));
  return new Promise<void>((resolve) => {
    pendingConflict = { conflicts, resolve };
    useApp.setState({ conflict: { conflicts, names }, saveStatus: 'conflict' });
  });
}

// ConflictDialog から呼ぶ。theirs=相手の変更を採用 / mine=自分の変更で上書き。
export function chooseConflict(choice: 'theirs' | 'mine'): void {
  const pending = pendingConflict;
  if (!pending) return;
  pendingConflict = null;
  if (choice === 'theirs') {
    const plan = planAdoptServer(pending.conflicts);
    applyPlan(plan);
    commitPlanRevs(syncState, plan);
  } else {
    adoptServerRevs(syncState, pending.conflicts);
    // 相手が削除したタスクを自分の編集で再作成する場合、その依存も作り直す（相手側では消えている）。
    const recreated = new Set(
      pending.conflicts.filter((c) => c.entity === 'task' && !c.serverRow).map((c) => c.id),
    );
    if (recreated.size) {
      const deps = useApp
        .getState()
        .dependencies.filter((d) => recreated.has(d.predecessorId) || recreated.has(d.successorId));
      for (const d of deps) syncState.revs.delete(d.id);
      useApp.setState((s) => {
        for (const d of deps) s.dirty.deps.add(d.id);
      });
    }
  }
  const d = useApp.getState().dirty;
  const empty = !d.tasks.size && !d.deps.size && !d.deletedTasks.size && !d.deletedDeps.size;
  useApp.setState({ conflict: null, saveStatus: empty ? 'saved' : 'dirty' });
  pending.resolve();
}

// ---------------------------------------------------------------------------
// 保存エラー
// ---------------------------------------------------------------------------
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryCount = 0;
let networkErrorToasted = false;

function scheduleRetry(): void {
  if (retryTimer) return;
  const delay = RETRY_BACKOFF_MS[Math.min(retryCount, RETRY_BACKOFF_MS.length - 1)];
  retryCount += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flushPersistence().catch(() => undefined);
  }, delay);
}

function resetRetry(): void {
  retryCount = 0;
  networkErrorToasted = false;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

// ローカルの未保存変更を破棄してサーバーの内容を読み直す（退避ファイルは呼び出し側が先に書き出す）。
async function reloadFromServer(): Promise<void> {
  const id = useApp.getState().project.id;
  try {
    const doc = await repo.loadGraph(id);
    useApp.getState().loadDoc(doc, { persist: false });
    adoptDoc(doc);
  } catch (e) {
    if (e instanceof NotFoundError) await handleProjectGone();
    else if (e instanceof AuthRequiredError) redirectToLogin();
  }
}

function backupUnsaved(): void {
  try {
    downloadJson(useApp.getState().toDoc(), { recordBackup: false, suffix: 'unsaved' });
  } catch {
    /* 退避に失敗しても読み直しは続行する */
  }
}

let goneHandling = false;
async function handleProjectGone(): Promise<void> {
  if (goneHandling) return;
  goneHandling = true;
  try {
    detachSync(syncState);
    resetRetry();
    useApp.getState().showToast('このプロジェクトは削除されたか、アクセスできなくなりました', true);
    useApp.setState((s) => {
      s.dirty.tasks.clear();
      s.dirty.deps.clear();
      s.dirty.deletedTasks.clear();
      s.dirty.deletedDeps.clear();
      s.saveStatus = 'saved';
      s.conflict = null;
    });
    const list = await repo.listProjects();
    useApp.setState({ projectList: list });
    if (list.length) await useApp.getState().switchProject(list[0].id);
    else await useApp.getState().newProject('新規プロジェクト');
  } catch (e) {
    if (e instanceof AuthRequiredError) redirectToLogin();
  } finally {
    goneHandling = false;
  }
}

async function onSaveError(error: unknown): Promise<'recovered' | 'failed'> {
  if (error instanceof AuthRequiredError) {
    redirectToLogin();
    return 'failed';
  }
  if (error instanceof ForbiddenError) {
    useApp.getState().showToast('閲覧権限のみのため保存できません', true);
    backupUnsaved();
    useApp.setState({ role: 'viewer' });
    await reloadFromServer();
    return 'recovered';
  }
  if (error instanceof ServerValidationError) {
    useApp.getState().showToast('サーバーに保存できない内容でした: ' + (error.details[0] ?? error.message), true);
    backupUnsaved();
    await reloadFromServer();
    return 'recovered';
  }
  if (error instanceof NotFoundError) {
    await handleProjectGone();
    return 'recovered';
  }
  // ネットワーク断・5xx: 未保存のまま保持し、間隔を延ばしながら再試行する。
  if (!networkErrorToasted) {
    networkErrorToasted = true;
    useApp.getState().showToast('サーバーに保存できません。接続が戻ると自動で再保存します', true);
  }
  scheduleRetry();
  return 'failed';
}

// ---------------------------------------------------------------------------
// 同期状態の採用
// ---------------------------------------------------------------------------
function adoptDoc(doc: GraphDoc): void {
  resetSync(syncState, doc);
  useApp.setState({ role: repo.getRole(doc.project.id) ?? 'editor' });
}

async function afterFullSave(projectId: string, adoptNow = false): Promise<void> {
  try {
    const doc = await repo.loadGraph(projectId);
    if (adoptNow || useApp.getState().project.id === projectId) adoptDoc(doc);
  } catch {
    // rev を取り直せなかった場合は同期を外す（次の保存で競合として検出され、利用者が選べる）。
    if (useApp.getState().project.id === projectId) detachSync(syncState);
  }
}

const hooks: ApiHooks = {
  adoptDoc,
  afterFullSave,
  detach: () => detachSync(syncState),
  resolveConflicts,
  onSaveError,
};

// ---------------------------------------------------------------------------
// ポーリング
// ---------------------------------------------------------------------------
let polling = false;
let paused = false; // E2E 用（__SYNC.pause）
let pollCount = 0;
let timer: ReturnType<typeof setInterval> | null = null;

async function refreshRole(projectId: string): Promise<void> {
  const list = await repo.listProjects();
  const mine = list.find((p) => p.id === projectId);
  if (!mine) {
    await handleProjectGone();
    return;
  }
  const prev = useApp.getState().role;
  useApp.setState({ projectList: list, role: mine.role });
  if (prev && prev !== mine.role)
    useApp.getState().showToast(mine.role === 'viewer' ? '権限が変更されました（閲覧のみ）' : '権限が変更されました');
}

export async function pollOnce(force = false): Promise<void> {
  if (polling || (paused && !force)) return;
  if (!force && document.visibilityState !== 'visible') return;
  const st = useApp.getState();
  const projectId = syncState.projectId;
  if (!projectId || st.project.id !== projectId) return;
  if (isFlushing() || st.conflict || st.saveStatus === 'conflict') return;
  polling = true;
  const epoch = syncState.epoch;
  try {
    const changes = await repo.getChanges(projectId, syncState.lastVersion);
    const now = useApp.getState();
    // 待っている間に保存・切替・競合が起きていたら、この応答は捨てる（次回の取得で追いつく）。
    if (syncState.epoch !== epoch || isFlushing() || now.conflict || now.project.id !== projectId) return;
    if (changes.version !== syncState.lastVersion) {
      const plan = planRemoteChanges(
        changes,
        {
          tasks: now.tasks,
          dependencies: now.dependencies,
          project: now.project,
          calendars: now.calendars,
          savedViews: now.savedViews,
        },
        dirtySnapshot(),
        syncState,
      );
      applyPlan(plan);
      commitPlanRevs(syncState, plan);
      syncState.lastVersion = changes.version;
    }
    pollCount += 1;
    if (pollCount % ROLE_REFRESH_EVERY === 0) await refreshRole(projectId);
  } catch (e) {
    if (e instanceof NotFoundError) await handleProjectGone();
    else if (e instanceof AuthRequiredError) redirectToLogin();
    // その他（一時的な通信エラー）は黙って次回に回す
  } finally {
    polling = false;
  }
}

let started = false;
export function startApiSync(): void {
  if (started) return;
  started = true;
  timer = setInterval(() => void pollOnce(false), POLL_INTERVAL_MS);
  window.addEventListener('focus', () => void pollOnce(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void pollOnce(false);
  });
  // 保存に成功したら再試行の状態を戻す。
  useApp.subscribe((s, prev) => {
    if (s.saveStatus === 'saved' && prev.saveStatus !== 'saved') resetRetry();
  });
  if (import.meta.env.DEV || import.meta.env.VITE_E2E === 'true') {
    (window as unknown as { __SYNC: unknown }).__SYNC = {
      pause: () => {
        paused = true;
      },
      resume: () => {
        paused = false;
      },
      pollNow: () => pollOnce(true),
      state: () => ({
        projectId: syncState.projectId,
        lastVersion: syncState.lastVersion,
        revs: Object.fromEntries(syncState.revs),
        polling,
        paused,
      }),
    };
  }
}

export function stopApiSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---------------------------------------------------------------------------
// 起動時: フックを差し込み、ログイン状態（/me）を確認する。
// 戻り値 false = 未ログインでログイン画面へ遷移中（エディタを描画しない）。
// ---------------------------------------------------------------------------
export async function initApiSession(): Promise<boolean> {
  installApiHooks(hooks);
  try {
    const me = await repo.me();
    useApp.setState({ account: { email: me.email, name: me.name } });
    return true;
  } catch (e) {
    if (e instanceof AuthRequiredError) {
      redirectToLogin();
      return false;
    }
    throw e;
  }
}
