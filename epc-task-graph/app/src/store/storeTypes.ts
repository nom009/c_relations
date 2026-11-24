// ============================================================================
// ストアの型（§4.2 store層）: AppState と付随する型。実体は store.ts（useApp）と slices/*。
// ============================================================================
import type { StateCreator } from "zustand";
import type {
  ActiveView,
  Calendar,
  CsvMergePlan,
  Dependency,
  DisplayMode,
  GraphDoc,
  GraphFilter,
  ProjectMeta,
  SavedView,
  TableColumnKey,
  TableSort,
  TableSortKey,
  Task,
  ViewSpec,
  ViewState,
} from "../domain";
import type { RowConflict } from "../storage/GraphRepository";
import type { ProjectRole } from "../storage/apiContract";

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

// サーバー版のみ: 保存時の行競合（ConflictDialog が表示する）。
export interface ConflictState {
  conflicts: RowConflict[];
  names: string[];
}

// サーバー版（apiSync.ts）が差し込む拡張点。ローカル版では null のまま＝従来どおりの動作。
export interface ApiHooks {
  // 読込/切替/複製/復元した doc を採用: 権限と同期状態を更新する。
  adoptDoc(doc: GraphDoc): void;
  // 全量保存後: サーバー採番の rev を取り直す。まだ表示していない新規プロジェクトでは adoptNow=true。
  afterFullSave(projectId: string, adoptNow?: boolean): Promise<void>;
  // プロジェクトから離れる/削除する前: ポーリングと同期状態を切り離す。
  detach(): void;
  // 競合の解決をユーザーに選ばせ、反映して返る（返ったら flush が再試行する）。
  resolveConflicts(conflicts: RowConflict[]): Promise<void>;
  // 保存失敗の扱い。'recovered' なら flush は成功扱いで終わる。
  onSaveError(error: unknown): Promise<"recovered" | "failed">;
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
  saveStatus: "saved" | "dirty" | "error" | "conflict";
  dirty: DirtyState;
  // ---- サーバー版のみ（ローカル版は常に null）----
  role: ProjectRole | null; // null=ローカル（全権限）。viewer は閲覧のみ
  account: { email: string; name: string } | null;
  conflict: ConflictState | null;
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
  applyCsvMerge: (plan: CsvMergePlan) => void; // CSV 更新取込の反映（1回=1 Undo）
  setBaseline: (ids?: string[]) => void; // 現在の計画をベースラインとして保存（省略時は全タスク・1回=1 Undo）
  clearBaseline: () => void; // 全タスクのベースラインを消去（1回=1 Undo）
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
  setWbsName: (code: string, name: string) => void; // WBS 名称（空で削除・Undo 可）
  setWbsNames: (names: Record<string, string>) => void; // 複数コードを一括で（1 回の Undo）
  refreshProjects: () => Promise<void>;
  switchProject: (id: string) => Promise<void>;
  newProject: (name?: string) => Promise<void>;
  duplicateCurrentProject: () => Promise<void>;
  deleteCurrentProject: () => Promise<void>;
}

// スライス（slices/*）が受け取る set/get の型。store.ts の temporal(immer(...)) と同じミドルウェア構成から導く
// （set は immer の draft 更新を受け付ける）。
type AppStateCreator = StateCreator<
  AppState,
  [["temporal", unknown], ["zustand/immer", never]],
  []
>;
export type AppSet = Parameters<AppStateCreator>[0];
export type AppGet = Parameters<AppStateCreator>[1];
