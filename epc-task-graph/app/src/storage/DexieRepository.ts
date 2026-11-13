// ============================================================================
// DexieRepository — IndexedDB 実装（§3.2/§6.1）。
// ・行単位テーブル（tasks/dependencies）＋ 差分書き savePatch（ダーティ行だけを put/delete）。
// ・各行に rev/updatedBy を記録（§5.1）。ローカル単独運用のため衝突は起きないが、
//   savePatch は baseRev を検査して PatchResult の形（衝突リスト）を最初から満たす（§7.2 L1）。
// ・保存履歴: 直近5件＋それより古いものは日ごとに最新1件（最大7日分）。savePatch/ saveGraph 後に全量スナップショットを追加し、剪定。
// ・「読みは全量・書きは差分」（§6.1）。DDL（§5.3）と同一セマンティクスを Dexie 上で再現。
// ============================================================================
import Dexie, { type Table } from 'dexie';
import {
  cloneDocWithNewIds,
  defaultCalendar,
  migrateDoc,
  repairDoc,
  validateDoc,
  type Calendar,
  type Dependency,
  type GraphDoc,
  type ProjectMeta,
  type SavedView,
  type Task,
  type ViewState,
} from '../domain';
import { selectSnapshotsToKeep } from '../domain/snapshotRetention';
import {
  CorruptDocError,
  type GraphPatch,
  type GraphRepository,
  type PatchResult,
  type RowConflict,
  type SnapshotMeta,
} from './GraphRepository';

// プロジェクトのメタ行（tasks/deps は別テーブル。§5.3 の projects 相当＋周辺JSON）。
interface ProjectRow extends ProjectMeta {
  schemaVersion: number;
  viewState: ViewState;
  savedViews: SavedView[];
  calendars: Calendar[];
}
interface TaskRow extends Task {
  projectId: string;
}
interface DepRow extends Dependency {
  projectId: string;
}
interface SnapshotRow {
  seq?: number;
  projectId: string;
  createdAt: string;
  label: string;
  taskCount: number;
  doc: GraphDoc; // 全量（軽い方針、§6.1）
}

const AUTOSAVE_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

// 剪定規則はサーバー API と共有する純関数（domain/snapshotRetention.ts）。既存テスト互換のため再エクスポート。
export { selectSnapshotsToKeep };

class EpcDexie extends Dexie {
  projects!: Table<ProjectRow, string>;
  tasks!: Table<TaskRow, string>;
  dependencies!: Table<DepRow, string>;
  snapshots!: Table<SnapshotRow, number>;
  constructor() {
    super('epc-task-graph');
    // 主キー + 二次インデックス（§5.3 idx_* に対応）。
    this.version(1).stores({
      projects: 'id, updatedAt',
      tasks: 'id, projectId, [projectId+wbsCode], [projectId+assignee]',
      dependencies: 'id, projectId, successorId',
      snapshots: '++seq, projectId, createdAt',
    });
  }
}

function stripProjectRow(row: ProjectRow): ProjectMeta {
  const { id, name, description, calendarId, dataDate, createdAt, updatedAt, version } = row;
  return { id, name, description, calendarId, dataDate, createdAt, updatedAt, version };
}

// 移行→修復→検証。不正なら CorruptDocError（doc は移行・修復済み・未検証）。
function migrateAndValidate(raw: GraphDoc): { doc: GraphDoc; migrated: boolean; repaired: boolean } {
  const m = migrateDoc(raw);
  const r = repairDoc(m.doc);
  const doc = r.doc as GraphDoc;
  const v = validateDoc(doc);
  if (!v.ok) throw new CorruptDocError(v.errors, doc);
  return { doc, migrated: m.migrated, repaired: r.repaired };
}

function docToRows(doc: GraphDoc): { project: ProjectRow; tasks: TaskRow[]; deps: DepRow[] } {
  const pid = doc.project.id;
  return {
    project: {
      ...doc.project,
      schemaVersion: doc.schemaVersion,
      viewState: doc.viewState,
      savedViews: doc.savedViews,
      calendars: doc.calendars,
    },
    tasks: doc.tasks.map((t) => ({ ...t, projectId: pid })),
    deps: doc.dependencies.map((d) => ({ ...d, projectId: pid })),
  };
}

export class DexieRepository implements GraphRepository {
  private db = new EpcDexie();
  private sessionSnapshotted = new Set<string>();

  async listProjects(): Promise<ProjectMeta[]> {
    const rows = await this.db.projects.orderBy('updatedAt').reverse().toArray();
    return rows.map(stripProjectRow);
  }

  async loadGraph(projectId: string): Promise<GraphDoc> {
    const raw = await this.readDoc(projectId);
    const { doc, migrated, repaired } = migrateAndValidate(raw);
    if (migrated || repaired) {
      // 移行/修復後の形式を行にも反映する（savePatch は schemaVersion を更新しないため）。元の形も履歴に残す。
      await this.snapshot(raw, migrated ? 'pre-migration' : 'pre-repair');
      await this.saveGraph(doc);
    }
    await this.ensureSessionSnapshot(doc);
    return doc;
  }

  // セッション（ページ読込）ごとに、各プロジェクトの最初の読込時点の状態を履歴に1件残す。
  // 直近の履歴が自動保存間隔内ならそれで足りるため追加しない。失敗しても読込は妨げない。
  private async ensureSessionSnapshot(doc: GraphDoc): Promise<void> {
    const pid = doc.project.id;
    if (this.sessionSnapshotted.has(pid)) return;
    this.sessionSnapshotted.add(pid);
    try {
      const last = await this.db.snapshots.where('projectId').equals(pid).reverse().first();
      if (!last || Date.now() - Date.parse(last.createdAt) >= AUTOSAVE_SNAPSHOT_INTERVAL_MS)
        await this.snapshot(doc, 'session-start');
    } catch {
      /* 履歴の追加失敗は無視 */
    }
  }

  // 行から GraphDoc を組み立てるだけ（移行・検証なし）。スナップショット採取にも使う。
  private async readDoc(projectId: string): Promise<GraphDoc> {
    const p = await this.db.projects.get(projectId);
    if (!p) throw new Error(`project not found: ${projectId}`);
    const [tasks, deps] = await Promise.all([
      this.db.tasks.where('projectId').equals(projectId).toArray(),
      this.db.dependencies.where('projectId').equals(projectId).toArray(),
    ]);
    const taskIds = new Set(tasks.map((t) => t.id));
    return {
      schemaVersion: p.schemaVersion ?? 1,
      project: stripProjectRow(p),
      viewState: p.viewState ?? { collapsedWbs: [], expandLevel: 2 },
      savedViews: p.savedViews ?? [],
      calendars: p.calendars && p.calendars.length ? p.calendars : [defaultCalendar()],
      // projectId フィールドは剥がして返す（GraphDoc は純粋な domain 型）。
      tasks: tasks.map(({ projectId: _pid, ...t }) => t as Task),
      // 端点タスクが消えた依存（旧版の削除で残った行）は読み飛ばす。
      dependencies: deps
        .filter((d) => taskIds.has(d.predecessorId) && taskIds.has(d.successorId))
        .map(({ projectId: _pid, ...d }) => d as Dependency),
    };
  }

  async saveGraph(doc: GraphDoc): Promise<{ version: number }> {
    const { project, tasks, deps } = docToRows(doc);
    await this.db.transaction('rw', this.db.projects, this.db.tasks, this.db.dependencies, async () => {
      // 主キーは id 単独のため、他プロジェクトの行を上書きしないよう衝突を先に拒否する。
      const foreignTask = (await this.db.tasks.bulkGet(tasks.map((t) => t.id))).find(
        (r) => r && r.projectId !== project.id,
      );
      const foreignDep = (await this.db.dependencies.bulkGet(deps.map((d) => d.id))).find(
        (r) => r && r.projectId !== project.id,
      );
      if (foreignTask || foreignDep) throw new Error('ID collision with another project');
      // 全量置換（インポート/初回・§6.2）。既存の当該プロジェクト行を消してから入れ直す。
      await this.db.tasks.where('projectId').equals(project.id).delete();
      await this.db.dependencies.where('projectId').equals(project.id).delete();
      await this.db.projects.put(project);
      if (tasks.length) await this.db.tasks.bulkPut(tasks);
      if (deps.length) await this.db.dependencies.bulkPut(deps);
    });
    await this.snapshot(doc, 'saveGraph');
    return { version: project.version };
  }

  async savePatch(patch: GraphPatch): Promise<PatchResult> {
    const pid = patch.projectId;
    const conflicts: RowConflict[] = [];
    const newRevs: Record<string, number> = {};
    let version = patch.baseProjectVersion;

    await this.db.transaction(
      'rw',
      this.db.projects,
      this.db.tasks,
      this.db.dependencies,
      async () => {
        // ---- 行単位の衝突検査（§7.2 L1）。ローカルでは通常一致する ----
        for (const t of patch.upsertTasks) {
          const cur = await this.db.tasks.get(t.id);
          if (cur && cur.rev !== t.baseRev && t.baseRev !== 0) {
            conflicts.push({ entity: 'task', id: t.id, baseRev: t.baseRev, serverRev: cur.rev, serverRow: stripTaskRow(cur) });
          }
        }
        for (const d of patch.upsertDeps) {
          const cur = await this.db.dependencies.get(d.id);
          if (cur && cur.rev !== d.baseRev && d.baseRev !== 0) {
            conflicts.push({ entity: 'dep', id: d.id, baseRev: d.baseRev, serverRev: cur.rev, serverRow: stripDepRow(cur) });
          }
        }
        if (conflicts.length) return; // 全体を中断（部分適用は Phase 4 で対応）

        // ---- 差分適用: ダーティ行だけを put / delete（§6.1）----
        if (patch.upsertTasks.length) {
          await this.db.tasks.bulkPut(
            patch.upsertTasks.map(({ baseRev: _b, ...t }) => ({ ...(t as Task), projectId: pid })),
          );
          for (const t of patch.upsertTasks) newRevs[t.id] = t.rev;
        }
        if (patch.upsertDeps.length) {
          await this.db.dependencies.bulkPut(
            patch.upsertDeps.map(({ baseRev: _b, ...d }) => ({ ...(d as Dependency), projectId: pid })),
          );
          for (const d of patch.upsertDeps) newRevs[d.id] = d.rev;
        }
        if (patch.deleteTaskIds.length) await this.db.tasks.bulkDelete(patch.deleteTaskIds.map((x) => x.id));
        if (patch.deleteDepIds.length) await this.db.dependencies.bulkDelete(patch.deleteDepIds.map((x) => x.id));

        // ---- プロジェクト行の周辺データ＋version++ ----
        const p = await this.db.projects.get(pid);
        // 削除済みプロジェクトへの書込は孤児行を生むため、トランザクションごと中断する。
        if (!p) throw new Error('project not found: ' + pid);
        version = (p.version || 0) + 1;
        await this.db.projects.put({
          ...p,
          ...(patch.project || {}),
          version,
          updatedAt: new Date().toISOString(),
          viewState: patch.viewState ?? p.viewState,
          savedViews: patch.savedViews ?? p.savedViews,
          calendars: patch.calendars ?? p.calendars,
        } satisfies ProjectRow);
      },
    );

    if (conflicts.length) return { ok: false, conflicts };
    // 保存履歴: 自動保存は一定間隔ごとにだけ全量スナップショットを残す。
    // 500msデバウンスの保存ごとに撮ると5世代が数秒で埋まり、履歴として機能しない上に重い。
    try {
      const last = await this.db.snapshots.where('projectId').equals(pid).reverse().first();
      const stale = !last || Date.now() - Date.parse(last.createdAt) >= AUTOSAVE_SNAPSHOT_INTERVAL_MS;
      if (stale) await this.snapshot(await this.readDoc(pid), 'autosave');
    } catch {
      /* スナップショット失敗は保存本体を妨げない */
    }
    return { ok: true, version, newRevs };
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.db.transaction(
      'rw',
      this.db.projects,
      this.db.tasks,
      this.db.dependencies,
      this.db.snapshots,
      async () => {
        await this.db.tasks.where('projectId').equals(projectId).delete();
        await this.db.dependencies.where('projectId').equals(projectId).delete();
        await this.db.snapshots.where('projectId').equals(projectId).delete();
        await this.db.projects.delete(projectId);
      },
    );
  }

  async duplicateProject(projectId: string, newName: string): Promise<GraphDoc> {
    const src = await this.loadGraph(projectId);
    const doc = cloneDocWithNewIds(src, newName);
    await this.saveGraph(doc);
    return doc;
  }

  async listSnapshots(projectId: string): Promise<SnapshotMeta[]> {
    const rows = await this.db.snapshots.where('projectId').equals(projectId).reverse().sortBy('seq');
    return rows.map((r) => ({
      seq: r.seq!,
      projectId: r.projectId,
      createdAt: r.createdAt,
      label: r.label,
      taskCount: r.taskCount,
    }));
  }

  async restoreSnapshot(projectId: string, seq: number): Promise<GraphDoc> {
    const row = await this.db.snapshots.get(seq);
    if (!row || row.projectId !== projectId) throw new Error('snapshot not found');
    // 壊れた履歴で現在のデータを上書きしないよう、検証に通ったものだけ保存する。
    const { doc } = migrateAndValidate(row.doc);
    await this.saveGraph(doc);
    return doc;
  }

  // ---- 内部: 全量スナップショットを追加し、古い物を5世代に剪定 ----
  private async snapshot(doc: GraphDoc, label: string): Promise<void> {
    const pid = doc.project.id;
    await this.db.snapshots.add({
      projectId: pid,
      createdAt: new Date().toISOString(),
      label,
      taskCount: doc.tasks.length,
      // 参照ではなくディープコピーを保存（後続編集の影響を受けない）。
      doc: JSON.parse(JSON.stringify(doc)) as GraphDoc,
    });
    // 本体（doc）を読まないよう、キーだけで createdAt と seq を突き合わせる。
    const own = new Set((await this.db.snapshots.where('projectId').equals(pid).primaryKeys()) as number[]);
    const byTime = this.db.snapshots.orderBy('createdAt');
    const [times, seqs] = await Promise.all([byTime.keys(), byTime.primaryKeys()]);
    const rows = seqs
      .map((seq, i) => ({ seq: seq as number, createdAt: String(times[i]) }))
      .filter((r) => own.has(r.seq));
    const keep = selectSnapshotsToKeep(rows);
    const drop = rows.filter((r) => !keep.has(r.seq)).map((r) => r.seq);
    if (drop.length) await this.db.snapshots.bulkDelete(drop);
  }
}

function stripTaskRow(r: TaskRow): Task {
  const clone: Partial<TaskRow> = { ...r };
  delete clone.projectId;
  return clone as Task;
}
function stripDepRow(r: DepRow): Dependency {
  const clone: Partial<DepRow> = { ...r };
  delete clone.projectId;
  return clone as Dependency;
}

// シングルトン（アプリ全体で1接続）。
let singleton: DexieRepository | null = null;
export function getRepository(): DexieRepository {
  if (!singleton) singleton = new DexieRepository();
  return singleton;
}
