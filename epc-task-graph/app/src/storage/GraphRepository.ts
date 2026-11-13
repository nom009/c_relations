// ============================================================================
// GraphRepository — 全フェーズ共通の永続化抽象（§6.1）。
// 「読みは全量・書きは差分（savePatch）」が基本方針（§6.1）。
// 実装は差替え可能: Phase0 LocalStorage / Phase1 DexieRepository / Phase4 ApiRepository。
// この抽象越しにするので、後の ApiRepository(Azure) 差し替えが UI/store を変えずに効く。
// ============================================================================
import type {
  Calendar,
  Dependency,
  GraphDoc,
  ProjectMeta,
  SavedView,
  Task,
  ViewState,
} from '../domain';

// 差分保存の各行に、読込時の rev（baseRev）を同梱（§7.2 楽観ロックの単位）。
export type TaskWithBaseRev = Task & { baseRev: number };
export type DepWithBaseRev = Dependency & { baseRev: number };

export interface GraphPatch {
  projectId: string;
  baseProjectVersion: number; // 参考情報（粗い錠、§6.1）
  upsertTasks: TaskWithBaseRev[];
  deleteTaskIds: { id: string; baseRev: number }[];
  upsertDeps: DepWithBaseRev[];
  deleteDepIds: { id: string; baseRev: number }[];
  // プロジェクト単位で永続化する周辺データ（§5.1: viewState/savedViews は Undo 対象外）。
  project?: Partial<ProjectMeta>;
  viewState?: ViewState;
  savedViews?: SavedView[];
  calendars?: Calendar[];
}

// 行単位の衝突（§7.2 L1。ローカル単独運用では発生しないが型は最初から持つ）。
export interface RowConflict {
  entity: 'task' | 'dep';
  id: string;
  baseRev: number;
  serverRev: number;
  serverRow: Task | Dependency;
}

export type PatchResult =
  | { ok: true; version: number; newRevs: Record<string, number> }
  | { ok: false; conflicts: RowConflict[] };

// 保存履歴（5世代、§6.1）。
export interface SnapshotMeta {
  seq: number;
  projectId: string;
  createdAt: string;
  label: string;
  taskCount: number;
}

// 読込時の検証に失敗した保存データ。doc は未検証のまま（呼び出し側が最終手段として使える）。
export class CorruptDocError extends Error {
  constructor(
    public readonly errors: string[],
    public readonly doc: GraphDoc,
  ) {
    super('保存データの検証に失敗しました: ' + errors.slice(0, 2).join(' / '));
    this.name = 'CorruptDocError';
  }
}

export interface GraphRepository {
  listProjects(): Promise<ProjectMeta[]>;
  loadGraph(projectId: string): Promise<GraphDoc>;
  savePatch(patch: GraphPatch): Promise<PatchResult>;
  saveGraph(doc: GraphDoc): Promise<{ version: number }>; // 全量保存（インポート/初回のみ）
  deleteProject(projectId: string): Promise<void>;
  // ---- 複数プロジェクト管理・保存履歴（Phase 1 で使用）----
  duplicateProject(projectId: string, newName: string): Promise<GraphDoc>;
  listSnapshots(projectId: string): Promise<SnapshotMeta[]>;
  restoreSnapshot(projectId: string, seq: number): Promise<GraphDoc>;
}
