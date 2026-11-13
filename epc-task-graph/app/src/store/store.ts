import { normalizeTaskPatch } from "../domain/taskEditing";
import { showcaseDoc } from "../domain/showcase";
// ============================================================================
// zustand ストア（§4.2 store層）: domain を包み、Undo/永続化/表示状態を管理。
// - zundo(temporal) + diff（差分保存、§2.3）: JSON.stringify 丸ごと保存は禁止。
// - immer: 不変更新で未変更オブジェクトを参照共有（履歴メモリ対策、§2.3）。
// - ダーティ追跡（§6.1/§7.2 L1の土台）: 変更/削除した行IDを保持し、後PRの savePatch へ渡す。
// 状態のうち temporal が追跡するのは { tasks, dependencies } のみ（partialize）。
// viewSpec/selection/collapsed/focus/filter は履歴に含めない（§2.3）。
// ============================================================================
import { create } from "zustand";
import { temporal } from "zundo";
import { immer } from "zustand/middleware/immer";
import { enableMapSet } from "immer";
import {
  type ActiveView,
  type Calendar,
  type Dependency,
  type DisplayMode,
  type GraphDoc,
  type GraphFilter,
  type ProjectMeta,
  type SavedView,
  type TableColumnKey,
  type TableSort,
  type TableSortKey,
  type Task,
  type ViewSpec,
  type ViewState,
  canConnect,
  clampLagDays,
  isValidIsoDate,
  makeDep,
  makeTask,
  nowISO,
  newId,
  seedDemo,
  collapsedForLevel,
  allTopPrefixes,
  emptyDoc,
  wbsPath,
  NewerSchemaError,
} from "../domain";
import { runFullLayout } from "../layout/layout";
import { CorruptDocError } from "../storage/GraphRepository";
import { backupReminderMessage, downloadJson, requestPersistentStorage } from "./backup";
import { isWriterTab } from "./writerLock";
import {
  getCurrentProjectId,
  getRepo,
  persistPatch,
  setCurrentProjectId,
  type DirtySnapshot,
} from "./persistence";

enableMapSet();

const LS_ME = "epc-app-me";
const LS_ACTIVE_VIEW = "epc-app-active-view";
const LS_TABLE_COLUMNS = "epc-app-table-columns";
const LS_DEFAULT_VIEW = "epc-app-default-view"; // 起動時に自動適用する保存ビューID（実用化の入口）

// localStorage は無効化/容量超過で例外を投げうる。UI設定の記憶は失敗しても無視してよい。
function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

// 表示列の正準順（§12.3.2）。TableView はこの順で、tableColumns に含まれる列だけを描画する。
export const ALL_TABLE_COLUMNS: TableColumnKey[] = [
  "wbsCode",
  "name",
  "wbsPath",
  "discipline",
  "assignee",
  "status",
  "progress",
  "durationDays",
  "es",
  "ef",
  "ls",
  "lf",
  "totalFloat",
  "critical",
  "deps",
];

// 既定表示列（§12.3.2 「既定」列）。wbsPath / ls / lf は既定非表示。
const DEFAULT_TABLE_COLUMNS: TableColumnKey[] = [
  "wbsCode",
  "name",
  "discipline",
  "assignee",
  "status",
  "progress",
  "durationDays",
  "es",
  "ef",
  "totalFloat",
  "critical",
  "deps",
];

export interface Selection {
  taskId: string | null;
  edgeId: string | null;
  aggId: string | null;
}

export interface ToastItem {
  id: string;
  msg: string;
  err: boolean;
}

export interface DirtyState {
  tasks: Set<string>;
  deps: Set<string>;
  deletedTasks: Set<string>;
  deletedDeps: Set<string>;
}

const emptyDirty = (): DirtyState => ({
  tasks: new Set(),
  deps: new Set(),
  deletedTasks: new Set(),
  deletedDeps: new Set(),
});

const noSelection = (): Selection => ({ taskId: null, edgeId: null, aggId: null });

// 折り畳み状態は表示（viewSpec）と永続（viewState）の両方へ同じ値を書く。
function setCollapsedWbs(
  s: { viewSpec: { collapsedWbs: string[] }; viewState: { collapsedWbs: string[] } },
  collapsedWbs: string[],
): void {
  s.viewSpec.collapsedWbs = collapsedWbs;
  s.viewState.collapsedWbs = collapsedWbs;
}

export interface Runners {
  fitView?: () => void;
  createAtCenter?: () => void;
  layoutVisible?: () => void;
  centerSelected?: () => void; // 選択タスクへパン（センタリングのみ・fitViewはしない、§12.2）
}

export interface AppState {
  // ---- ドキュメント（永続化対象・§5.2）----
  schemaVersion: number;
  project: ProjectMeta;
  viewState: ViewState;
  savedViews: SavedView[];
  calendars: Calendar[];
  tasks: Task[]; // temporal 追跡対象
  dependencies: Dependency[]; // temporal 追跡対象

  // ---- 表示状態（履歴対象外）----
  me: string;
  viewSpec: ViewSpec;
  expandLevel: number;
  selection: Selection;
  // 複数行選択（§12.3.5 PR-T2・テーブル限定）。空=単一選択モード（selection.taskId にフォールバック）。
  // selection.taskId は常に「アンカー（範囲選択の基点・右パネル/グラフが読む主選択）」を指す。
  selectedIds: string[];
  editingId: string | null;
  toast: ToastItem[];
  saveStatus: "saved" | "dirty" | "error";
  dirty: DirtyState;
  runners: Runners;
  cpHighlight: boolean; // CP強調トグル（§2.11/§9.2）。非永続・Undo対象外
  connectMode: boolean; // 「つなぐモード」: クリックで依存を接続/切断（トラックパッド向けの直感操作）
  connectSource: string | null; // つなぐモードで選んだ始点タスクID
  lastConnected: { id: string; at: number } | null; // 直前に接続した依存ID（通電エフェクト用・非永続）
  burst: { source: string; target: string } | null; // 直前の接続の両端（回路エフェクト用・一瞬だけ）
  projectList: ProjectMeta[]; // 複数プロジェクト一覧（§6.1）
  storagePersisted: boolean | null; // 永続ストレージの保護状況（null=未確認/非対応）。非永続

  // ---- 多ビュー表示状態（§12.2・Undo対象外・Dexie非永続）----
  activeView: ActiveView; // localStorage 記憶
  tableSort: TableSort[]; // 多重ソート（PR-T1は単一キー運用）。既定 []＝WBS自然順
  tableColumns: TableColumnKey[]; // 表示列。localStorage 記憶
  defaultViewId: string | null; // 起動時に自動適用する保存ビューID（localStorage 記憶）

  // ---- アクション ----
  setRunner: (name: keyof Runners, fn: () => void) => void;
  fit: (delay?: number) => void;
  setMe: (me: string) => void;
  showToast: (msg: string, err?: boolean) => void;

  addTask: (p?: Partial<Task>, opts?: { edit?: boolean }) => Task;
  updateTask: (id: string, patch: Partial<Task>) => void;
  setPosition: (id: string, pos: { x: number; y: number }) => void;
  applyPositions: (map: Record<string, { x: number; y: number }>) => void;
  deleteTasks: (ids: string[]) => void;
  addDependencyChecked: (source: string, target: string) => boolean;
  updateDep: (id: string, patch: Partial<Dependency>) => void; // 依存タイプ/ラグの編集（CPM連動）
  deleteDeps: (ids: string[]) => void;
  createSuccessor: (sourceId: string) => void;

  setEditing: (id: string | null) => void;
  setSelection: (sel: Partial<Selection>) => void;
  // ---- 複数行選択・一括操作（§12.3.5 PR-T2）----
  setSelectedIds: (ids: string[], anchor?: string) => void; // 範囲選択の確定（ids＋アンカー）
  toggleSelectedId: (id: string) => void; // Cmd/Ctrl+クリックのトグル
  bulkUpdateTasks: (ids: string[], patch: Partial<Task>) => void; // 一括更新（1確定=1 Undo）
  setFilter: (patch: Partial<GraphFilter>) => void;
  clearFilter: () => void;
  setBoundary: (up: number, down: number) => void; // 「担当＋前後」の受け渡し世代（前up/後down）
  setDisplayMode: (m: DisplayMode) => void;
  toggleArrayFilter: (
    key: "disciplines" | "statuses" | "assignees" | "wbsPrefixes",
    val: string,
  ) => void;
  setExpandLevel: (n: number) => void;
  collapseAll: () => void;
  expandAggregate: (aggId: string) => void;
  toggleCollapse: (prefix: string) => void;
  toggleFocus: (taskId: string) => void;
  clearFocus: () => void;
  incFocusDepth: (delta: number) => void;
  setFocusRange: (up: number, down: number) => void; // 上流/下流の世代数を個別に設定（§2.9）
  setFocusMode: (mode: "isolate" | "highlight") => void; // 抽出↔関係ハイライト
  escape: () => void;
  quickMyTasks: () => void;
  quickCriticalOnly: () => void;
  toggleCpHighlight: () => void;
  // ---- つなぐモード（クリックで接続/切断）----
  toggleConnectMode: () => void;
  connectClick: (id: string) => void; // モード中にノードをクリックした時の処理
  // ---- 保存ビュー（§2.8/§12.3.8 PR-T2④）----
  saveCurrentView: (name: string) => void; // 現在のフィルタ/表示/折り畳み/テーブル状態を保存
  applyView: (id: string) => void; // 保存ビューを適用
  deleteView: (id: string) => void;
  setDefaultView: (id: string | null) => void; // 起動時に自動適用する既定ビューを指定/解除

  // ---- 多ビュー（§12.2）: 新設アクション ----
  setActiveView: (v: ActiveView) => void;
  setTableSort: (sort: TableSort[]) => void;
  toggleTableSort: (key: TableSortKey, additive: boolean) => void;
  toggleTableColumn: (key: TableColumnKey) => void;
  revealTask: (taskId: string) => void;

  undo: () => void;
  redo: () => void;

  toDoc: () => GraphDoc;
  loadDoc: (doc: GraphDoc, opts?: { persist?: boolean }) => void;
  generateDemo: () => void;
  layoutAll: () => void;

  // ---- 複数プロジェクト管理（§6.1）----
  renameProject: (name: string) => void;
  setDataDate: (d: string) => void;
  updateCalendar: (patch: Partial<Calendar>) => void; // 稼働曜日/祝日の編集（CPM連動・§9.1 Phase2）
  refreshProjects: () => Promise<void>;
  switchProject: (id: string) => Promise<void>;
  newProject: (name?: string) => Promise<void>;
  duplicateCurrentProject: () => Promise<void>;
  deleteCurrentProject: () => Promise<void>;
}

// ---- 永続化（Dexie・デバウンス500ms差分保存、§6.1）----
// ダーティ集合から GraphPatch を組み、DexieRepository.savePatch（差分書き）へ渡す。
// ハイドレーション中（起動時の Dexie 読込）は保存を抑止する。
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let hydrating = false;

function snapshotDirty(d: DirtyState): DirtySnapshot {
  return {
    tasks: [...d.tasks],
    deps: [...d.deps],
    deletedTasks: [...d.deletedTasks],
    deletedDeps: [...d.deletedDeps],
  };
}

let saveGeneration = 0;
let writeQueue: Promise<unknown> = Promise.resolve();
let activeFlush: Promise<void> | null = null;
// Imports must keep retrying a full replacement until it succeeds.
let pendingFullSave: symbol | null = null;
function enqueueWrite<T>(write: () => Promise<T>): Promise<T> {
  if (!isWriterTab()) return Promise.reject(new Error("別のタブが書き込み中です"));
  const result = writeQueue.then(write);
  writeQueue = result.catch(() => undefined);
  return result;
}

// Serialize writes; retain dirty rows if another edit happens during a save.
export function flushPersistence(): Promise<void> {
  if (!isWriterTab()) return Promise.resolve(); // 別タブが書込権を持つ間は書かない
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (activeFlush) return activeFlush;
  activeFlush = (async () => {
    await writeQueue;
    while (useApp.getState().saveStatus !== "saved") {
      const state = useApp.getState();
      const generation = saveGeneration;
      const doc = state.toDoc();
      const dirty = snapshotDirty(state.dirty);
      const fullSave = pendingFullSave;
      if (fullSave) {
        await enqueueWrite(() => getRepo().saveGraph(doc));
        if (pendingFullSave === fullSave) pendingFullSave = null;
        if (useApp.getState().project.id === doc.project.id)
          setCurrentProjectId(doc.project.id);
        void useApp.getState().refreshProjects();
      } else {
        const result = await enqueueWrite(() => persistPatch(doc, dirty));
        if (!result.ok) throw new Error("保存の競合を検知しました");
      }
      if (useApp.getState().project.id !== doc.project.id) continue;
      if (generation === saveGeneration) {
        useApp.setState((s) => {
          s.dirty = emptyDirty();
          s.saveStatus = "saved";
        });
      }
    }
  })()
    .catch((error) => {
      useApp.setState({ saveStatus: "error" });
      useApp
        .getState()
        .showToast(
          "保存できませんでした。データを書き出して保管してください。",
          true,
        );
      throw error;
    })
    .finally(() => {
      activeFlush = null;
    });
  return activeFlush;
}
function scheduleSave() {
  saveGeneration++;
  useApp.setState({ saveStatus: "dirty" });
  if (hydrating || !isWriterTab()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void flushPersistence().catch(() => undefined);
  }, 500);
}

function restoreHistory(direction: "undo" | "redo") {
  const before = useApp.getState();
  const beforeTasks = new Map(before.tasks.map((t) => [t.id, t]));
  const beforeDeps = new Map(before.dependencies.map((d) => [d.id, d]));
  useApp.temporal.getState()[direction]();
  // 変わった行だけをダーティにする（immer の構造共有により未変更行は同一参照）。
  // 参照比較は draft ではなく確定済み状態で行う。
  const after = useApp.getState();
  const currentTasks = new Map(after.tasks.map((t) => [t.id, t]));
  const currentDeps = new Map(after.dependencies.map((d) => [d.id, d]));
  const changedTasks: string[] = [];
  const removedTasks: string[] = [];
  for (const id of new Set([...beforeTasks.keys(), ...currentTasks.keys()])) {
    if (!currentTasks.has(id)) removedTasks.push(id);
    else if (beforeTasks.get(id) !== currentTasks.get(id)) changedTasks.push(id);
  }
  const changedDeps: string[] = [];
  const removedDeps: string[] = [];
  for (const id of new Set([...beforeDeps.keys(), ...currentDeps.keys()])) {
    if (!currentDeps.has(id)) removedDeps.push(id);
    else if (beforeDeps.get(id) !== currentDeps.get(id)) changedDeps.push(id);
  }
  useApp.setState((s) => {
    for (const id of changedTasks) {
      s.dirty.tasks.add(id);
      s.dirty.deletedTasks.delete(id);
    }
    for (const id of removedTasks) {
      s.dirty.tasks.delete(id);
      s.dirty.deletedTasks.add(id);
    }
    for (const id of changedDeps) {
      s.dirty.deps.add(id);
      s.dirty.deletedDeps.delete(id);
    }
    for (const id of removedDeps) {
      s.dirty.deps.delete(id);
      s.dirty.deletedDeps.add(id);
    }
    s.selectedIds = s.selectedIds.filter((id) => currentTasks.has(id));
    if (s.connectSource && !currentTasks.has(s.connectSource))
      s.connectSource = null;
    if (s.selection.taskId && !currentTasks.has(s.selection.taskId))
      s.selection.taskId = null;
  });
  scheduleSave();
}

// 読込時に不整合（CorruptDocError）を検出したら、新しい履歴から順に復元を試みる。
// どれも使えなければ、ユーザーのデータを塞がないよう未検証のまま開いて警告する。
// 復元は現在のデータを上書きするため、直前の未検証データをファイルに退避してから行う。
// notified: 呼び出し側が他の通知（バックアップ促し等）を重ねる必要がないよう、トーストを出したか返す。
async function loadGraphWithRecovery(id: string): Promise<{ doc: GraphDoc; notified: boolean }> {
  const repo = getRepo();
  try {
    return { doc: await repo.loadGraph(id), notified: false };
  } catch (err) {
    if (!(err instanceof CorruptDocError)) throw err;
    let saved = false;
    try {
      const snaps = await repo.listSnapshots(id);
      if (snaps.length) {
        try {
          downloadJson(err.doc, { recordBackup: false, suffix: "broken" });
          saved = true;
        } catch {
          /* 退避に失敗しても復元自体は続行する */
        }
      }
      for (const snap of snaps) {
        try {
          const doc = await repo.restoreSnapshot(id, snap.seq);
          useApp
            .getState()
            .showToast(
              `保存データの不整合を検出したため、${new Date(snap.createdAt).toLocaleString()}の履歴から復元しました` +
                (saved ? "（復元前のデータはファイルに保存しました）" : ""),
            );
          return { doc, notified: true };
        } catch {
          /* この履歴も使えない。次に新しい履歴へ */
        }
      }
    } catch {
      /* 履歴を読めない場合も未検証のデータで続行する */
    }
    useApp
      .getState()
      .showToast(
        `保存データに不整合があります（${err.errors[0] ?? "不明"}）。JSONエクスポートでバックアップしてください`,
        true,
      );
    return { doc: err.doc, notified: true };
  }
}

// 起動時: まず starter を同期表示 → Dexie から現在プロジェクトへ非同期ハイドレート（§6.1）。
// 空DBの初回は「現在の starter を初回プロジェクトとして保存」するだけで loadDoc しない
// （同期表示済みの state をクロバーしない）。既存プロジェクトがある時のみ読み込んで差し替える。
export async function bootstrapStore(): Promise<void> {
  hydrating = true;
  const persistedReq = requestPersistentStorage().then((persisted) => {
    useApp.setState({ storagePersisted: persisted });
    return persisted;
  });
  try {
    const repo = getRepo();
    const list = await repo.listProjects();
    if (!list.length) {
      const doc = useApp.getState().toDoc();
      await repo.saveGraph(doc);
      setCurrentProjectId(doc.project.id);
    } else {
      const cur = getCurrentProjectId();
      const targetId = cur && list.some((p) => p.id === cur) ? cur : list[0].id;
      setCurrentProjectId(targetId);
      const { doc, notified } = await loadGraphWithRecovery(targetId);
      useApp.getState().loadDoc(doc, { persist: false });
      // 永続化の結果は待たせずに起動し、判明後（遅くとも1.5秒後）にリマインドを判定する。
      if (!notified)
        void Promise.race([
          persistedReq,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
        ]).then((persisted) => {
          const reminder = backupReminderMessage(list, Date.now(), persisted);
          if (reminder) useApp.getState().showToast(reminder);
        });
    }
    await useApp.getState().refreshProjects();
  } catch (err) {
    useApp.setState({ saveStatus: "error" });
    useApp
      .getState()
      .showToast(
        err instanceof NewerSchemaError
          ? err.message
          : "保存領域を開けませんでした。ブラウザの設定を確認してください。",
        true,
      );
  } finally {
    hydrating = false;
    // 既定ビューが指定されていて現プロジェクトに実在すれば、起動直後に自動適用（実用化の入口）。
    // loadDoc が viewSpec を既定へ戻した後に適用するので順序が正しい。
    const st = useApp.getState();
    if (
      st.defaultViewId &&
      st.savedViews.some((v) => v.id === st.defaultViewId)
    ) {
      st.applyView(st.defaultViewId);
    }
    // ハイドレーション中に行われた編集（保存が抑止されていた分）を吐き出す。
    const d = useApp.getState().dirty;
    if (
      d.tasks.size ||
      d.deps.size ||
      d.deletedTasks.size ||
      d.deletedDeps.size
    )
      scheduleSave();
  }
}

function initialMe(): string {
  return readPref(LS_ME) || "私";
}

function initialActiveView(): ActiveView {
  const v = readPref(LS_ACTIVE_VIEW);
  return v === "graph" || v === "table" || v === "gantt" ? v : "graph";
}

function initialTableColumns(): TableColumnKey[] {
  try {
    const raw = readPref(LS_TABLE_COLUMNS);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const valid = parsed.filter((k): k is TableColumnKey =>
          (ALL_TABLE_COLUMNS as string[]).includes(k as string),
        );
        if (valid.length) return valid;
      }
    }
  } catch {
    /* ignore */
  }
  return [...DEFAULT_TABLE_COLUMNS];
}

function currentWbsContext(): string {
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

const doc0 = showcaseDoc();
const me0 = initialMe();

export const useApp = create<AppState>()(
  temporal(
    immer((set, get) => ({
      schemaVersion: doc0.schemaVersion,
      project: doc0.project,
      viewState: doc0.viewState,
      savedViews: doc0.savedViews,
      calendars: doc0.calendars,
      tasks: doc0.tasks,
      dependencies: doc0.dependencies,

      me: me0,
      viewSpec: {
        filter: {},
        displayMode: "DIM",
        collapsedWbs: doc0.viewState.collapsedWbs || [],
        focus: null,
        me: me0,
      },
      expandLevel: doc0.viewState.expandLevel || 2,
      selection: noSelection(),
      selectedIds: [],
      editingId: null,
      toast: [],
      saveStatus: "saved",
      dirty: emptyDirty(),
      runners: {},
      cpHighlight: false,
      connectMode: false,
      connectSource: null,
      lastConnected: null,
      burst: null,
      projectList: [],
      storagePersisted: null,
      activeView: initialActiveView(),
      tableSort: [],
      tableColumns: initialTableColumns(),
      defaultViewId: readPref(LS_DEFAULT_VIEW) || null,

      setRunner: (name, fn) =>
        set((s) => {
          s.runners[name] = fn;
        }),
      fit: (delay = 160) =>
        setTimeout(() => {
          get().runners.fitView?.();
        }, delay),
      setMe: (me) => {
        writePref(LS_ME, me);
        set((s) => {
          s.me = me;
          s.viewSpec.me = me;
        });
      },

      showToast: (msg, err = false) => {
        const id = newId();
        set((s) => {
          s.toast.push({ id, msg, err });
        });
        setTimeout(
          () =>
            set((s) => {
              s.toast = s.toast.filter((t) => t.id !== id);
            }),
          5200,
        );
      },

      // ---- タスク/依存 CRUD（ダーティ追跡付き）----
      addTask: (p = {}, { edit = true } = {}) => {
        const t = makeTask(
          {
            ...p,
            wbsCode: p.wbsCode != null ? p.wbsCode : currentWbsContext() || "",
            updatedBy: get().me,
          },
          get().me,
        );
        set((s) => {
          s.tasks.push(t);
          s.dirty.tasks.add(t.id);
          s.selection = { taskId: t.id, edgeId: null, aggId: null };
          s.selectedIds = [];
          s.editingId = edit ? t.id : null;
        });
        scheduleSave();
        return t;
      },
      updateTask: (id, patch) => {
        set((s) => {
          const t = s.tasks.find((x) => x.id === id);
          if (!t) return;
          Object.assign(t, normalizeTaskPatch(t, patch));
          t.rev += 1;
          t.updatedAt = nowISO();
          t.updatedBy = s.me;
          s.dirty.tasks.add(id);
        });
        scheduleSave();
      },
      setPosition: (id, pos) => {
        set((s) => {
          const t = s.tasks.find((x) => x.id === id);
          if (!t) return;
          t.position = pos;
          s.dirty.tasks.add(id);
        });
        scheduleSave();
      },
      applyPositions: (map) => {
        set((s) => {
          for (const t of s.tasks) {
            if (map[t.id]) {
              t.position = map[t.id];
              s.dirty.tasks.add(t.id);
            }
          }
        });
        scheduleSave();
      },
      deleteTasks: (ids) => {
        const idset = new Set(ids);
        set((s) => {
          s.tasks = s.tasks.filter((t) => !idset.has(t.id));
          // 付随する依存も削除として記録する（DB 側に連鎖削除はない）。
          s.dependencies = s.dependencies.filter((d) => {
            const keep =
              !idset.has(d.predecessorId) && !idset.has(d.successorId);
            if (!keep) s.dirty.deletedDeps.add(d.id);
            return keep;
          });
          for (const id of ids) s.dirty.deletedTasks.add(id);
          s.selectedIds = s.selectedIds.filter((id) => !idset.has(id));
          if (s.connectSource && idset.has(s.connectSource))
            s.connectSource = null;
          if (s.selection.taskId && idset.has(s.selection.taskId))
            s.selection = {
              taskId: s.selectedIds[s.selectedIds.length - 1] || null,
              edgeId: null,
              aggId: null,
            };
        });
        scheduleSave();
        if (ids.length > 1)
          get().showToast(
            ids.length + "件削除しました（Cmd+Z で元に戻せます）",
          );
      },
      addDependencyChecked: (source, target) => {
        const tasks = get().tasks;
        if (
          !tasks.some((t) => t.id === source) ||
          !tasks.some((t) => t.id === target)
        )
          return false; // 削除済みタスクへの依存（孤児行）を作らない
        const chk = canConnect(source, target, get().dependencies);
        if (!chk.ok) {
          get().showToast(explainReject(chk, get()), true);
          return false;
        }
        const dep = makeDep(source, target, {}, get().me);
        set((s) => {
          s.dependencies.push(dep);
          s.dirty.deps.add(dep.id);
          s.lastConnected = { id: dep.id, at: Date.now() }; // 通電エフェクトのトリガ
          s.burst = { source, target }; // 両端ノードに回路が走る演出のトリガ
        });
        // ワンショット。終点側の発光が終わる頃に消す（その後に別の接続をしていなければ）。
        setTimeout(() => {
          const b = get().burst;
          if (b && b.source === source && b.target === target)
            set((s) => {
              s.burst = null;
            });
        }, 1500);
        scheduleSave();
        return true;
      },
      updateDep: (id, patch) => {
        set((s) => {
          const d = s.dependencies.find((x) => x.id === id);
          if (!d) return;
          const next =
            patch.lagDays === undefined
              ? patch
              : { ...patch, lagDays: clampLagDays(patch.lagDays) };
          Object.assign(d, next);
          d.rev += 1;
          d.updatedAt = nowISO();
          d.updatedBy = s.me;
          s.dirty.deps.add(id);
        });
        scheduleSave();
      },
      deleteDeps: (ids) => {
        const idset = new Set(ids);
        set((s) => {
          s.dependencies = s.dependencies.filter((d) => !idset.has(d.id));
          for (const id of ids) s.dirty.deletedDeps.add(id);
        });
        scheduleSave();
      },
      createSuccessor: (sourceId) => {
        const src = get().tasks.find((t) => t.id === sourceId);
        if (!src) return;
        const pos = { x: src.position.x + 220, y: src.position.y };
        const t = makeTask(
          { wbsCode: src.wbsCode, discipline: src.discipline, position: pos },
          get().me,
        );
        const dep = makeDep(sourceId, t.id, {}, get().me);
        set((s) => {
          s.tasks.push(t);
          s.dependencies.push(dep);
          s.dirty.tasks.add(t.id);
          s.dirty.deps.add(dep.id);
          s.selection = { taskId: t.id, edgeId: null, aggId: null };
          s.selectedIds = [];
          s.editingId = t.id;
        });
        scheduleSave();
      },

      // ---- 表示状態（Undo対象外）----
      setEditing: (id) =>
        set((s) => {
          s.editingId = id;
        }),
      setSelection: (sel) =>
        set((s) => {
          s.selection = { ...noSelection(), ...sel };
          s.selectedIds = []; // 単一選択に戻す（多選択はテーブルの明示操作でのみ張る）
        }),
      // 範囲選択の確定（Shift+クリック等）: ids をそのまま多選択とし、アンカーを selection.taskId に。
      setSelectedIds: (ids, anchor) =>
        set((s) => {
          const uniq = [...new Set(ids)];
          s.selectedIds = uniq.length > 1 ? uniq : [];
          s.selection = {
            taskId: anchor ?? uniq[uniq.length - 1] ?? null,
            edgeId: null,
            aggId: null,
          };
        }),
      // Cmd/Ctrl+クリックのトグル: id を多選択に足す/外す。アンカーは操作した id（外した時は残りの末尾）。
      toggleSelectedId: (id) =>
        set((s) => {
          const base = s.selectedIds.length
            ? [...s.selectedIds]
            : s.selection.taskId
              ? [s.selection.taskId]
              : [];
          const idx = base.indexOf(id);
          let anchor: string | null;
          if (idx >= 0) {
            base.splice(idx, 1);
            anchor = base[base.length - 1] ?? null;
          } else {
            base.push(id);
            anchor = id;
          }
          s.selectedIds = base.length > 1 ? base : [];
          s.selection = { taskId: anchor, edgeId: null, aggId: null };
        }),
      // 一括更新（削除/ステータス/担当/工種）: 1回の set() ＝ 1 Undo単位（zundo は状態差分で1エントリ）。
      bulkUpdateTasks: (ids, patch) => {
        const idset = new Set(ids);
        set((s) => {
          const now = nowISO();
          for (const t of s.tasks) {
            if (!idset.has(t.id)) continue;
            Object.assign(t, normalizeTaskPatch(t, patch));
            t.rev += 1;
            t.updatedAt = now;
            t.updatedBy = s.me;
            s.dirty.tasks.add(t.id);
          }
        });
        scheduleSave();
      },
      setFilter: (patch) =>
        set((s) => {
          Object.assign(s.viewSpec.filter, patch);
        }),
      clearFilter: () =>
        set((s) => {
          s.viewSpec.filter = {};
          s.viewSpec.boundaryUp = 0;
          s.viewSpec.boundaryDown = 0;
        }),
      // 前後の受け渡し世代を設定（0-9でクランプ）。フィルタ有効時に文脈として前後を含める。
      setBoundary: (up, down) =>
        set((s) => {
          s.viewSpec.boundaryUp = Math.max(0, Math.min(9, Math.round(up)));
          s.viewSpec.boundaryDown = Math.max(0, Math.min(9, Math.round(down)));
        }),
      setDisplayMode: (m) => {
        set((s) => {
          s.viewSpec.displayMode = m;
        });
        if (m === "ISOLATE") get().fit();
      },
      toggleArrayFilter: (key, val) =>
        set((s) => {
          const cur = (s.viewSpec.filter[key] as string[] | undefined) || [];
          const next = cur.includes(val)
            ? cur.filter((x) => x !== val)
            : [...cur, val];
          (s.viewSpec.filter as any)[key] = next;
        }),
      setExpandLevel: (n) => {
        set((s) => {
          s.expandLevel = n;
          setCollapsedWbs(s, collapsedForLevel(s.tasks, n));
          s.viewState.expandLevel = n;
        });
        scheduleSave();
      },
      collapseAll: () => {
        set((s) => {
          s.expandLevel = 1;
          setCollapsedWbs(s, allTopPrefixes(s.tasks));
          s.viewState.expandLevel = 1;
        });
        scheduleSave();
      },
      expandAggregate: (aggId) => {
        set((s) => {
          const prefix = aggId.startsWith("wbs::") ? aggId.slice(5) : aggId;
          setCollapsedWbs(s, s.viewSpec.collapsedWbs.filter((p) => p !== prefix));
          s.selection = noSelection();
          s.selectedIds = [];
        });
        scheduleSave();
      },
      toggleCollapse: (prefix) => {
        set((s) => {
          const cur = s.viewSpec.collapsedWbs;
          setCollapsedWbs(
            s,
            cur.includes(prefix) ? cur.filter((p) => p !== prefix) : [...cur, prefix],
          );
        });
        scheduleSave();
      },
      toggleFocus: (taskId) => {
        set((s) => {
          const cur = s.viewSpec.focus;
          if (cur && cur.taskId === taskId) {
            s.viewSpec.focus = null;
          } else {
            // 既定は「関係ハイライト」（全体を残し近傍を強調・§2.9 ユーザー要望2026-07-22）。
            s.viewSpec.focus = { taskId, up: 2, down: 2, mode: "highlight" };
          }
        });
        // ハイライトは文脈を保ちたいので起点センタリングのみ（fitはしない）。
        if (get().viewSpec.focus)
          setTimeout(() => get().runners.centerSelected?.(), 30);
      },
      clearFocus: () =>
        set((s) => {
          s.viewSpec.focus = null;
        }),
      incFocusDepth: (delta) =>
        set((s) => {
          if (!s.viewSpec.focus) return;
          const f = s.viewSpec.focus;
          f.up = Math.max(0, (f.up ?? 2) + delta);
          f.down = Math.max(0, (f.down ?? 2) + delta);
        }),
      setFocusRange: (up, down) =>
        set((s) => {
          if (!s.viewSpec.focus) return;
          s.viewSpec.focus.up = Math.max(0, Math.min(9, Math.round(up)));
          s.viewSpec.focus.down = Math.max(0, Math.min(9, Math.round(down)));
        }),
      setFocusMode: (mode) =>
        set((s) => {
          if (!s.viewSpec.focus) return;
          s.viewSpec.focus.mode = mode;
        }),
      escape: () =>
        set((s) => {
          if (s.viewSpec.focus) {
            s.viewSpec.focus = null;
          } else if (s.selectedIds.length) {
            // 多選択中の Esc は単一（アンカー）へ戻す（選択自体は残す）。
            s.selectedIds = [];
          } else if (
            s.selection.taskId ||
            s.selection.edgeId ||
            s.selection.aggId
          ) {
            s.selection = noSelection();
          }
        }),
      // 「自分のタスク」＝担当で絞る＋前後1世代の受け渡し先を文脈表示（担当＋前後ビューの既定）。
      quickMyTasks: () => {
        set((s) => {
          s.viewSpec.displayMode = "ISOLATE";
          s.viewSpec.focus = null;
          s.viewSpec.filter = { assignees: ["@me"] };
          s.viewSpec.boundaryUp = 1;
          s.viewSpec.boundaryDown = 1;
        });
        get().fit();
      },
      // 「CPのみ表示」組込みビュー（§2.8）: criticalOnly + ISOLATE で背骨チェーンを抽出。
      quickCriticalOnly: () => {
        set((s) => {
          s.viewSpec.displayMode = "ISOLATE";
          s.viewSpec.focus = null;
          s.viewSpec.filter = { criticalOnly: true };
          s.viewSpec.boundaryUp = 0;
          s.viewSpec.boundaryDown = 0;
          s.cpHighlight = true;
        });
        get().fit();
      },
      toggleCpHighlight: () =>
        set((s) => {
          s.cpHighlight = !s.cpHighlight;
        }),

      // ---- つなぐモード（クリックで接続/切断・トラックパッド向けの直感操作）----
      toggleConnectMode: () => {
        const on = !get().connectMode;
        set((s) => {
          s.connectMode = on;
          s.connectSource = null;
        });
        get().showToast(
          on
            ? "つなぐモード: 始点→終点の順にクリック（もう一度で切断・Escで終了）"
            : "つなぐモードを終了しました",
        );
      },
      connectClick: (id) => {
        const s = get();
        if (!s.connectMode) return;
        if (id.startsWith("wbs::")) {
          s.showToast("集約ノードは接続できません。展開してから", true);
          return;
        }
        const src = s.connectSource;
        if (!src) {
          // 始点を選ぶ。
          set((st) => {
            st.connectSource = id;
            st.selection = { taskId: id, edgeId: null, aggId: null };
          });
          return;
        }
        if (src === id) {
          // 始点を再クリック＝選び直し（解除）。
          set((st) => {
            st.connectSource = null;
          });
          return;
        }
        // 既に src→id があれば切断、なければ接続（循環は addDependencyChecked が拒否）。
        const existing = s.dependencies.find(
          (d) => d.predecessorId === src && d.successorId === id,
        );
        if (existing) {
          s.deleteDeps([existing.id]);
          s.showToast("依存を切断しました（Cmd+Z で戻せます）");
        } else {
          if (s.addDependencyChecked(src, id))
            s.showToast("依存を接続しました");
        }
        // 始点は保持＝A→B, A→C と連続で繋げる。
      },

      // ---- 保存ビュー（§2.8/§12.3.8 PR-T2④）----
      saveCurrentView: (name) => {
        const s = get();
        const view: SavedView = {
          id: newId(),
          name: name.trim() || "無題ビュー",
          filter: JSON.parse(JSON.stringify(s.viewSpec.filter)),
          displayMode: s.viewSpec.displayMode,
          collapsedWbs: [...s.viewSpec.collapsedWbs],
          createdBy: s.me,
          updatedAt: nowISO(),
          tableSort: s.tableSort.length
            ? s.tableSort.map((t) => ({ ...t }))
            : undefined,
          tableColumns: [...s.tableColumns],
        };
        set((st) => {
          st.savedViews.push(view);
        });
        scheduleSave();
        get().showToast("ビューを保存しました: " + view.name);
      },
      applyView: (id) => {
        const v = get().savedViews.find((x) => x.id === id);
        if (!v) return;
        set((s) => {
          s.viewSpec.filter = JSON.parse(JSON.stringify(v.filter));
          s.viewSpec.displayMode = v.displayMode;
          setCollapsedWbs(s, [...(v.collapsedWbs ?? [])]);
          s.viewSpec.focus = null;
          if (v.tableSort) {
            s.tableSort = v.tableSort.filter(
              (t) =>
                String(t.key) !== "deps" &&
                (ALL_TABLE_COLUMNS as string[]).includes(t.key),
            ) as TableSort[];
          }
          if (v.tableColumns && v.tableColumns.length) {
            const valid = ALL_TABLE_COLUMNS.filter((k) =>
              v.tableColumns!.includes(k),
            );
            if (valid.length) s.tableColumns = valid;
          }
        });
        writePref(LS_TABLE_COLUMNS, JSON.stringify(get().tableColumns));
        get().fit();
        get().showToast("ビューを適用しました: " + v.name);
      },
      deleteView: (id) => {
        set((s) => {
          s.savedViews = s.savedViews.filter((v) => v.id !== id);
          if (s.defaultViewId === id) s.defaultViewId = null; // 既定だったビューを消したら既定も解除
        });
        if (get().defaultViewId === null) writePref(LS_DEFAULT_VIEW, null);
        scheduleSave();
      },
      // 既定ビュー: 同じIDを再指定したら解除（トグル）。起動時に bootstrapStore が自動適用する。
      setDefaultView: (id) => {
        set((s) => {
          s.defaultViewId = s.defaultViewId === id ? null : id;
        });
        writePref(LS_DEFAULT_VIEW, get().defaultViewId);
      },

      // ---- 多ビュー（§12.2）: 表示状態アクション（Undo対象外・Dexie非永続）----
      setActiveView: (v) => {
        writePref(LS_ACTIVE_VIEW, v);
        set((s) => {
          s.activeView = v;
        });
      },
      setTableSort: (sort) =>
        set((s) => {
          s.tableSort = sort;
        }),
      // ヘッダクリック=単独 asc→desc→解除／Shift+クリック=キー追加（PR-T1は単一運用が主）。
      toggleTableSort: (key, additive) =>
        set((s) => {
          const cur = s.tableSort;
          const idx = cur.findIndex((x) => x.key === key);
          if (!additive) {
            if (idx === -1) {
              s.tableSort = [{ key, dir: "asc" }];
            } else if (cur[idx].dir === "asc") {
              s.tableSort = [{ key, dir: "desc" }];
            } else {
              s.tableSort = []; // desc の次は解除（＝WBS自然順へ戻る）
            }
            return;
          }
          // 追加（Shift+クリック）: 既存キーはトグル、無ければ末尾に追加（最大3キー）。
          const next = [...cur];
          if (idx === -1) {
            if (next.length < 3) next.push({ key, dir: "asc" });
          } else if (next[idx].dir === "asc") {
            next[idx] = { key, dir: "desc" };
          } else {
            next.splice(idx, 1);
          }
          s.tableSort = next;
        }),
      toggleTableColumn: (key) => {
        set((s) => {
          const has = s.tableColumns.includes(key);
          s.tableColumns = has
            ? s.tableColumns.filter((k) => k !== key)
            : ALL_TABLE_COLUMNS.filter(
                (k) => k === key || s.tableColumns.includes(k),
              );
        });
        writePref(LS_TABLE_COLUMNS, JSON.stringify(get().tableColumns));
      },
      // 選択対象を必ず見せる（§12.2）: 祖先WBSプレフィックスを collapsedWbs から除去＋選択。
      // 'wbs::'+prefix のID規約は集約ノードと共有。検索ジャンプ（§2.6）にも将来流用。
      revealTask: (taskId) =>
        set((s) => {
          const t = s.tasks.find((x) => x.id === taskId);
          if (!t) return;
          const ancestors = new Set(wbsPath(t.wbsCode));
          setCollapsedWbs(s, s.viewSpec.collapsedWbs.filter((p) => !ancestors.has(p)));
          s.selection = { ...noSelection(), taskId };
          s.selectedIds = [];
        }),

      // ---- Undo / Redo（zundo temporal 経由。戻した行もダーティ扱い、§2.3）----
      undo: () => restoreHistory("undo"),
      redo: () => restoreHistory("redo"),

      // ---- ドキュメント（doc化・差替え）----
      toDoc: () => {
        const s = get();
        return {
          schemaVersion: s.schemaVersion,
          project: s.project,
          viewState: s.viewState,
          savedViews: s.savedViews,
          calendars: s.calendars,
          tasks: s.tasks,
          dependencies: s.dependencies,
        };
      },
      loadDoc: (doc, opts) => {
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        saveGeneration++;
        pendingFullSave = opts?.persist === false || hydrating ? null : Symbol();
        set((s) => {
          s.schemaVersion = doc.schemaVersion;
          s.project = doc.project;
          s.viewState = doc.viewState;
          s.savedViews = doc.savedViews;
          s.calendars = doc.calendars;
          s.tasks = doc.tasks;
          s.dependencies = doc.dependencies;
          s.selection = noSelection();
          s.selectedIds = [];
          s.editingId = null;
          s.connectMode = false;
          s.connectSource = null;
          s.viewSpec = {
            filter: {},
            displayMode: "DIM",
            collapsedWbs: doc.viewState.collapsedWbs || [],
            focus: null,
            me: s.me,
          };
          s.expandLevel = doc.viewState.expandLevel || 2;
          s.dirty = emptyDirty();
          s.saveStatus = pendingFullSave ? "dirty" : "saved";
        });
        useApp.temporal.getState().clear(); // 新ドキュメントは履歴を持ち越さない
        // loadDoc は「全量差替え」（デモ生成・インポート等）。差分ではなく全量 saveGraph で
        // 永続化する。persist:false（起動時ハイドレート・切替/複製/復元の自前保存）では保存しない。
        if (pendingFullSave)
          void flushPersistence().catch(() => undefined);
      },
      generateDemo: () => {
        void flushPersistence()
          .then(() => {
            const doc = seedDemo({ count: 4000 });
            get().loadDoc(doc);
            get().fit(200);
            get().showToast("4,000タスクのデモプロジェクトを開きました");
          })
          .catch(() => undefined);
      },

      // ---- 全体整列（Worker、§2.5）----
      layoutAll: () => {
        get().showToast(
          "全体整列を実行中…（Web Workerで非同期。UIはブロックしません）",
        );
        const s = get();
        runFullLayout(
          s.tasks.map((t) => t.id),
          s.dependencies.map(
            (d) => [d.predecessorId, d.successorId] as [string, string],
          ),
        )
          .then((posMap) => {
            get().applyPositions(posMap);
            get().showToast("全体整列が完了しました（左→右 DAGレイアウト）");
            get().runners.fitView?.();
          })
          .catch(() => get().showToast("全体整列に失敗しました", true));
      },

      // ---- 複数プロジェクト管理（§6.1）----
      renameProject: (name) => {
        set((s) => {
          s.project.name = name;
          s.project.updatedAt = nowISO();
        });
        scheduleSave();
      },
      setDataDate: (d) => {
        if (!isValidIsoDate(d)) return; // 空欄・不正値は描画/CPM を壊すため無視
        set((s) => {
          s.project.dataDate = d;
          s.project.updatedAt = nowISO();
        });
        scheduleSave();
      },
      updateCalendar: (patch) => {
        set((s) => {
          const cal =
            s.calendars.find((c) => c.id === s.project.calendarId) ??
            s.calendars[0];
          if (!cal) return;
          Object.assign(cal, patch);
          s.project.updatedAt = nowISO();
        });
        scheduleSave();
      },
      refreshProjects: async () => {
        try {
          const list = await getRepo().listProjects();
          set((s) => {
            s.projectList = list;
          });
        } catch {
          /* ignore */
        }
      },
      switchProject: async (id) => {
        try {
          await flushPersistence();
          const { doc, notified } = await loadGraphWithRecovery(id);
          await flushPersistence(); // 読込中の編集を旧プロジェクトへ吐き出してから差し替える
          setCurrentProjectId(id);
          get().loadDoc(doc, { persist: false });
          get().fit(200);
          if (!notified) get().showToast("プロジェクトを切り替えました: " + doc.project.name);
        } catch {
          get().showToast("プロジェクトの読込に失敗しました", true);
        }
      },
      newProject: async (name) => {
        const doc = emptyDoc(name || "新規プロジェクト");
        try {
          await flushPersistence();
          await enqueueWrite(() => getRepo().saveGraph(doc));
          await flushPersistence();
          setCurrentProjectId(doc.project.id);
          get().loadDoc(doc, { persist: false });
          await get().refreshProjects();
          get().showToast("新規プロジェクトを作成しました");
        } catch {
          get().showToast("プロジェクト作成に失敗しました", true);
        }
      },
      duplicateCurrentProject: async () => {
        const cur = get().project;
        try {
          await flushPersistence();
          const dup = await getRepo().duplicateProject(
            cur.id,
            cur.name + "（複製）",
          );
          await flushPersistence();
          setCurrentProjectId(dup.project.id);
          get().loadDoc(dup, { persist: false });
          await get().refreshProjects();
          get().fit(200);
          get().showToast("プロジェクトを複製しました");
        } catch {
          get().showToast("複製に失敗しました", true);
        }
      },
      deleteCurrentProject: async () => {
        const curId = get().project.id;
        try {
          await flushPersistence();
          await getRepo().deleteProject(curId);
          // 削除待ちの間の編集は書込先が無いので破棄する（保存エラーで切替が止まるのを防ぐ）。
          if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
          }
          saveGeneration++;
          set((s) => {
            s.dirty = emptyDirty();
            s.saveStatus = "saved";
          });
          const list = await getRepo().listProjects();
          if (list.length) {
            await get().switchProject(list[0].id);
          } else {
            await get().newProject("新規プロジェクト");
          }
          await get().refreshProjects();
          get().showToast("プロジェクトを削除しました");
        } catch {
          get().showToast("削除に失敗しました", true);
        }
      },
    })),
    {
      // temporal 追跡は tasks/dependencies のみ（§2.3）。
      partialize: (state): Pick<AppState, "tasks" | "dependencies"> => ({
        tasks: state.tasks,
        dependencies: state.dependencies,
      }),
      limit: 100,
      // 差分保存（§2.3）: 参照が変わったキーだけを、その「変更前の値」で保存する。
      // immer の構造共有により未変更 Task/Dep オブジェクトは参照共有され、メモリ膨張しない。
      diff: (pastState, currentState) => {
        const delta: Partial<Pick<AppState, "tasks" | "dependencies">> = {};
        let changed = false;
        if (pastState.tasks !== currentState.tasks) {
          delta.tasks = pastState.tasks;
          changed = true;
        }
        if (pastState.dependencies !== currentState.dependencies) {
          delta.dependencies = pastState.dependencies;
          changed = true;
        }
        return changed ? delta : null;
      },
    },
  ),
);

export function nameOf(id: string): string {
  return nameOfState(useApp.getState(), id);
}

// 現在の稼働カレンダー（project.calendarId で参照。無ければ先頭）。selectCpm に渡す。
// 参照は immer が変更時のみ差し替えるため、全コンポーネントで同一参照＝selectCpm のキャッシュが効く。
export const selectActiveCalendar = (s: AppState): Calendar | null =>
  s.calendars.find((c) => c.id === s.project.calendarId) ??
  s.calendars[0] ??
  null;
