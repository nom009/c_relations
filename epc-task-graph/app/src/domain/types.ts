// ============================================================================
// EPCタスク依存関係グラフ ドメイン型（設計書 §5.2 JSONスキーマに完全準拠）
// UI / React / DOM に一切依存しない。Phase 1 の domain 層の唯一の真実。
// ============================================================================

export type Discipline = 'E' | 'P' | 'C' | 'OTHER';
export type Status = 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE' | 'ON_HOLD';
export type ConstraintType = 'ASAP' | 'SNET' | 'FNLT';
export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF';
export type DisplayMode = 'DIM' | 'ISOLATE';

export interface Position {
  x: number;
  y: number;
}

export interface Task {
  id: string;
  name: string;
  wbsCode: string; // "" 可。プレフィックスが WBS 木を定義（§2.7）
  discipline: Discipline;
  isMilestone: boolean; // true なら durationDays=0 を強制
  durationDays: number;
  status: Status;
  progress: number; // 0-100 整数
  assignee: string; // 自由文字列（Phase 4 で Entra ID と突合、§7.5）
  constraintType: ConstraintType;
  constraintDate: string | null;
  notes: string;
  position: Position;
  rev: number; // 行レベル版数（更新毎に +1、衝突検知の単位、§7.2）
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  // 実績（P6 方式・任意）。暦日 'YYYY-MM-DD'。終了日はその日を含む（当日完了）。
  actualStart?: string | null;
  actualFinish?: string | null;
  // ベースライン（計画の凍結値・任意）。'YYYY-MM-DD'。終了日はその日を含む。
  baselineStart?: string | null;
  baselineFinish?: string | null;
}

export interface Dependency {
  id: string;
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  lagDays: number; // 整数、負値=リード
  rev: number;
  updatedAt: string;
  updatedBy: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  description: string;
  calendarId: string;
  dataDate: string; // 基準日＝進捗の締め日（P6 の Data Date）。残作業はこの日以降で計算する
  createdAt: string;
  updatedAt: string;
  version: number; // プロジェクト全体の単調増加版数（楽観ロックの粗い錠）
  wbsNames?: Record<string, string>; // WBS コード → 名称（任意）
}

export interface ViewState {
  collapsedWbs: string[];
  expandLevel: number;
}

export interface GraphFilter {
  wbsPrefixes?: string[];
  disciplines?: Discipline[];
  assignees?: string[]; // "@me" は現在ユーザーへ展開（§7.5）
  statuses?: Status[];
  milestonesOnly?: boolean;
  criticalOnly?: boolean; // CPM 導出値（Phase 1 前半は未計算）
  dateRange?: { from?: string; to?: string };
  text?: string;
}

export interface SavedView {
  id: string;
  name: string;
  filter: GraphFilter;
  displayMode: DisplayMode;
  collapsedWbs: string[] | null;
  createdBy: string;
  updatedAt: string;
  // 多ビュー（§12.3.8 PR-T2④・optional・前方互換）: テーブルのソート/表示列も保存できる。
  tableSort?: TableSort[];
  tableColumns?: TableColumnKey[];
}

export interface Calendar {
  id: string;
  name: string;
  workingDays: number[];
  holidays: string[];
}

export interface GraphDoc {
  schemaVersion: number;
  project: ProjectMeta;
  viewState: ViewState;
  savedViews: SavedView[];
  calendars: Calendar[];
  tasks: Task[];
  dependencies: Dependency[];
}

// ---- 表示パイプライン（§2.6）の入出力 ----

export interface FocusSpec {
  taskId: string;
  up: number;
  down: number;
  // 'isolate'=近傍だけ抽出（従来）／'highlight'=全体は残し近傍を強調・非近傍を淡色（§2.9 関係ハイライト）
  mode?: 'isolate' | 'highlight';
}

export interface ViewSpec {
  filter: GraphFilter;
  displayMode: DisplayMode;
  collapsedWbs: string[];
  focus: FocusSpec | null;
  me: string;
  // 「担当＋前後」ビュー（§2.9 拡張）: フィルタ一致タスクから前 up 世代・後 down 世代の受け渡し先を
  // 文脈として含める。0=含めない（既定・従来挙動）。focus とは独立（focus 優先）。
  boundaryUp?: number;
  boundaryDown?: number;
  // ---- CPM 導出値の受け皿（非永続・§5.1/§9.2）。derive 時に注入される ----
  criticalTasks?: Set<string>; // isCritical=true のタスク（criticalOnly フィルタ・CP強調に使用）
  criticalEdges?: Set<string>; // 駆動依存の dependency.id（CP強調に使用）
  cpHighlight?: boolean; // CP強調トグルが ON か（ON の時だけ視覚 critical フラグを立てる）
}

export interface DisciplineBreakdown {
  E: number;
  P: number;
  C: number;
  OTHER: number;
}

export interface VisibleTaskNode {
  kind: 'task';
  id: string;
  task: Task;
  position: Position;
  dim: boolean;
  outside: boolean;
  isOrigin: boolean;
  directPred: boolean;
  directSucc: boolean;
  critical: boolean; // CP強調 ON かつクリティカルなタスク（§2.11/§9.2）
  related?: boolean; // 関係ハイライト: フォーカス近傍に含まれる（§2.9）
  gen?: number; // 起点からの世代（0=起点・負=上流・正=下流）。関係ハイライトの色/バッジに使用
}

export interface VisibleAggregateNode {
  kind: 'aggregate';
  id: string;
  prefix: string;
  continuation?: boolean;
  memberIds: string[];
  position: Position;
  count: number;
  disc: DisciplineBreakdown;
  avgProgress: number;
  hasMilestone: boolean;
  hasCritical: boolean;
  dim: boolean;
}

export type VisibleNode = VisibleTaskNode | VisibleAggregateNode;

export interface VisibleEdge {
  id: string;
  source: string;
  target: string;
  aggregate: boolean;
  continuation?: boolean;
  count: number;
  highlight: boolean;
  critical: boolean; // CP強調 ON かつ駆動依存（§2.11/§9.2）
  realId?: string;
}

export interface DeriveStats {
  total: number;
  visible: number;
  aggregates: number;
  matched: number;
  edges: number;
}

export interface DeriveResult {
  visibleNodes: VisibleNode[];
  visibleEdges: VisibleEdge[];
  stats: DeriveStats;
}

export interface Adjacency {
  succ: Map<string, Set<string>>;
  pred: Map<string, Set<string>>;
}

export interface Neighborhood {
  set: Set<string>;
  directPred: Set<string>;
  directSucc: Set<string>;
  gen: Map<string, number>; // 起点からの世代（0=起点・負=上流N世代・正=下流N世代）
}

// ---- 多ビュー（§12）: テーブル/ガントの器で共有する表示状態と行導出の型 ----

export type ActiveView = 'graph' | 'table' | 'gantt';

// 表示列キー（§12.3.2）。'deps' は参照専用でソート対象外。
export type TableColumnKey =
  | 'wbsCode'
  | 'name'
  | 'wbsPath'
  | 'discipline'
  | 'assignee'
  | 'status'
  | 'progress'
  | 'durationDays'
  | 'es'
  | 'ef'
  | 'ls'
  | 'lf'
  | 'totalFloat'
  | 'critical'
  | 'deps';

export type TableSortKey = Exclude<TableColumnKey, 'deps'>;

export interface TableSort {
  key: TableSortKey;
  dir: 'asc' | 'desc';
}

// deriveTableRows（§12.3.1 段6）の出力: 木を DFS 平坦化した1次元行配列の1要素。
export interface TableRow {
  kind: 'wbs' | 'task';
  id: string; // task.id ／ 'wbs::'+prefix（グラフ集約ノードとID規約を共有）
  depth: number; // インデント段
  // kind:'wbs'
  wbsPrefix?: string;
  collapsed?: boolean;
  memberCount?: number;
  hasCritical?: boolean;
  hasMilestone?: boolean;
  avgProgress?: number;
  esMin?: string | null; // WBS配下の最早ES日付（min ES・§12.3.2／ガントのサマリバー準備）
  efMax?: string | null; // WBS配下の最遅EF日付（max EF）
  // kind:'task'
  task?: Task;
  dim?: boolean;
  outside?: boolean;
  predCount?: number;
  succCount?: number;
}

export interface TableStats {
  total: number; // 全タスク数
  rows: number; // 出力行数
  taskRows: number;
  wbsRows: number;
  matched: number; // フィルタ一致タスク数
}

export interface TableResult {
  rows: TableRow[];
  stats: TableStats;
}

export type ConnectReason = 'self' | 'duplicate' | 'cycle' | null;

export interface ConnectResult {
  ok: boolean;
  reason: ConnectReason;
  path: string[] | null;
}

export interface TopoResult {
  ok: boolean;
  order: string[];
  hasCycle: boolean;
}
