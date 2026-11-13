import type { Calendar, Dependency, GraphDoc, SavedView, Task, ViewState } from '../domain';
import type { ProjectRole as MemberRole, SnapshotMeta } from '../contract';

export interface ProjectRecord {
  id: string;
  name: string;
  description: string;
  dataDate: string;
  calendarId: string;
  schemaVersion: number;
  version: number; // 行・メタいずれかの変更で +1（changes の since 基準）
  metaVersion: number; // project/calendars/savedViews を最後に変更した version
  calendars: Calendar[];
  savedViews: SavedView[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface MemberRow {
  email: string;
  role: MemberRole;
  userId: string | null;
  name: string | null;
  addedAt: string;
  addedBy: string;
}

export interface ProjectListItem {
  record: ProjectRecord;
  role: MemberRole;
  taskCount: number;
}

export interface SnapshotRow {
  seq: number;
  projectId: string;
  createdAt: string;
  label: string;
  taskCount: number;
  doc: GraphDoc;
}

export interface NewSnapshot {
  createdAt: string;
  label: string;
  taskCount: number;
  doc: GraphDoc;
}

export type Entity = 'task' | 'dep';

export interface ChangedRows {
  tasks: Task[];
  deps: Dependency[];
  deletedTaskIds: string[];
  deletedDepIds: string[];
}

// 1 トランザクション内の操作。例外を投げるとロールバックされる。
// 行（Task/Dependency）の rev はストアに保存された値がサーバー rev。
export interface Tx {
  listProjectsFor(email: string): Promise<ProjectListItem[]>;
  recordIdentity(email: string, userId: string, name: string): Promise<void>;

  // lock=true はプロジェクト単位の書込み直列化（SQL: UPDLOCK）。
  getProject(id: string, lock: boolean): Promise<ProjectRecord | null>;
  insertProject(rec: ProjectRecord): Promise<void>; // 主キー重複は DuplicateKeyError
  updateProject(rec: ProjectRecord): Promise<void>;
  deleteProject(id: string): Promise<void>; // 全関連データを削除

  getMember(projectId: string, email: string): Promise<MemberRow | null>;
  listMembers(projectId: string): Promise<MemberRow[]>;
  insertMember(projectId: string, m: MemberRow): Promise<void>;
  setMemberRole(projectId: string, email: string, role: MemberRole): Promise<void>;
  setMemberIdentity(projectId: string, email: string, userId: string, name: string): Promise<void>;
  deleteMember(projectId: string, email: string): Promise<void>;

  listTasks(projectId: string): Promise<Task[]>;
  listDeps(projectId: string): Promise<Dependency[]>;
  // 行の書込み（既存は置換）。changedVersion を付与し、同 id の墓標は消す。
  putTasks(projectId: string, rows: Task[], changedVersion: number): Promise<void>;
  putDeps(projectId: string, rows: Dependency[], changedVersion: number): Promise<void>;
  // 行を削除し墓標（version 付き）を残す。
  deleteRows(projectId: string, entity: Entity, ids: string[], version: number): Promise<void>;
  changesSince(projectId: string, since: number): Promise<ChangedRows>;

  getViewState(projectId: string, userId: string): Promise<ViewState | null>;
  setViewState(projectId: string, userId: string, vs: ViewState): Promise<void>;

  listSnapshots(projectId: string): Promise<SnapshotMeta[]>; // 新しい順
  getSnapshot(projectId: string, seq: number): Promise<SnapshotRow | null>;
  insertSnapshot(projectId: string, s: NewSnapshot): Promise<number>;
  deleteSnapshots(projectId: string, seqs: number[]): Promise<void>;
}

export interface ServerStore {
  // fn が例外を投げたらロールバック。戻り値を返せばコミット。
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
