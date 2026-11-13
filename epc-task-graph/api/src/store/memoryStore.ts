import type { Dependency, Task, ViewState } from '../domain';
import type { ProjectRole, SnapshotMeta } from '../contract';
import { DuplicateKeyError } from '../errors';
import type {
  ChangedRows,
  Entity,
  MemberRow,
  NewSnapshot,
  ProjectListItem,
  ProjectRecord,
  ServerStore,
  SnapshotRow,
  Tx,
} from './types';

// テスト・開発サーバー用のインメモリ実装。再起動でデータは消える（本番では使わない）。
// 行オブジェクトは不変として扱う（更新は常に新しいオブジェクトで置換）ため、コピーオンライトは Map の複製だけでよい。
interface ProjectData {
  record: ProjectRecord;
  tasks: Map<string, Task>;
  deps: Map<string, Dependency>;
  taskVer: Map<string, number>;
  depVer: Map<string, number>;
  taskTomb: Map<string, number>;
  depTomb: Map<string, number>;
  members: Map<string, MemberRow>;
  viewStates: Map<string, ViewState>;
  snapshots: SnapshotRow[];
}

function cloneData(d: ProjectData): ProjectData {
  return {
    record: d.record,
    tasks: new Map(d.tasks),
    deps: new Map(d.deps),
    taskVer: new Map(d.taskVer),
    depVer: new Map(d.depVer),
    taskTomb: new Map(d.taskTomb),
    depTomb: new Map(d.depTomb),
    members: new Map(d.members),
    viewStates: new Map(d.viewStates),
    snapshots: [...d.snapshots],
  };
}

export class MemoryStore implements ServerStore {
  private projects = new Map<string, ProjectData>();
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const tx = new MemoryTx(this.projects, () => ++this.seq);
      const result = await fn(tx);
      tx.commit();
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

class MemoryTx implements Tx {
  private work = new Map<string, ProjectData | null>();

  constructor(
    private committed: Map<string, ProjectData>,
    private nextSeq: () => number,
  ) {}

  commit(): void {
    for (const [id, d] of this.work) {
      if (d) this.committed.set(id, d);
      else this.committed.delete(id);
    }
  }

  private read(id: string): ProjectData | undefined {
    return this.work.has(id) ? (this.work.get(id) ?? undefined) : this.committed.get(id);
  }

  private write(id: string): ProjectData {
    const w = this.work.get(id);
    if (w) return w;
    const base = this.committed.get(id);
    if (!base) throw new Error(`project not found: ${id}`);
    const copy = cloneData(base);
    this.work.set(id, copy);
    return copy;
  }

  private ids(): string[] {
    const s = new Set(this.committed.keys());
    for (const [id, d] of this.work) {
      if (d) s.add(id);
      else s.delete(id);
    }
    return [...s];
  }

  async listProjectsFor(email: string): Promise<ProjectListItem[]> {
    const out: ProjectListItem[] = [];
    for (const id of this.ids()) {
      const d = this.read(id);
      const m = d?.members.get(email);
      if (d && m) out.push({ record: d.record, role: m.role, taskCount: d.tasks.size });
    }
    return out.sort((a, b) => (a.record.updatedAt < b.record.updatedAt ? 1 : a.record.updatedAt > b.record.updatedAt ? -1 : 0));
  }

  async recordIdentity(email: string, userId: string, name: string): Promise<void> {
    for (const id of this.ids()) {
      const m = this.read(id)?.members.get(email);
      if (m && (m.userId !== userId || m.name !== name)) this.write(id).members.set(email, { ...m, userId, name });
    }
  }

  async getProject(id: string): Promise<ProjectRecord | null> {
    return this.read(id)?.record ?? null;
  }

  async insertProject(rec: ProjectRecord): Promise<void> {
    if (this.read(rec.id)) throw new DuplicateKeyError(`project exists: ${rec.id}`);
    this.work.set(rec.id, {
      record: rec,
      tasks: new Map(),
      deps: new Map(),
      taskVer: new Map(),
      depVer: new Map(),
      taskTomb: new Map(),
      depTomb: new Map(),
      members: new Map(),
      viewStates: new Map(),
      snapshots: [],
    });
  }

  async updateProject(rec: ProjectRecord): Promise<void> {
    this.write(rec.id).record = rec;
  }

  async deleteProject(id: string): Promise<void> {
    this.work.set(id, null);
  }

  async getMember(projectId: string, email: string): Promise<MemberRow | null> {
    return this.read(projectId)?.members.get(email) ?? null;
  }

  async listMembers(projectId: string): Promise<MemberRow[]> {
    return [...(this.read(projectId)?.members.values() ?? [])];
  }

  async insertMember(projectId: string, m: MemberRow): Promise<void> {
    this.write(projectId).members.set(m.email, m);
  }

  async setMemberRole(projectId: string, email: string, role: ProjectRole): Promise<void> {
    const d = this.write(projectId);
    const m = d.members.get(email);
    if (m) d.members.set(email, { ...m, role });
  }

  async setMemberIdentity(projectId: string, email: string, userId: string, name: string): Promise<void> {
    const d = this.write(projectId);
    const m = d.members.get(email);
    if (m) d.members.set(email, { ...m, userId, name });
  }

  async deleteMember(projectId: string, email: string): Promise<void> {
    this.write(projectId).members.delete(email);
  }

  async listTasks(projectId: string): Promise<Task[]> {
    return [...(this.read(projectId)?.tasks.values() ?? [])];
  }

  async listDeps(projectId: string): Promise<Dependency[]> {
    return [...(this.read(projectId)?.deps.values() ?? [])];
  }

  async putTasks(projectId: string, rows: Task[], changedVersion: number): Promise<void> {
    const d = this.write(projectId);
    for (const r of rows) {
      d.tasks.set(r.id, r);
      d.taskVer.set(r.id, changedVersion);
      d.taskTomb.delete(r.id);
    }
  }

  async putDeps(projectId: string, rows: Dependency[], changedVersion: number): Promise<void> {
    const d = this.write(projectId);
    for (const r of rows) {
      d.deps.set(r.id, r);
      d.depVer.set(r.id, changedVersion);
      d.depTomb.delete(r.id);
    }
  }

  async deleteRows(projectId: string, entity: Entity, ids: string[], version: number): Promise<void> {
    const d = this.write(projectId);
    for (const id of ids) {
      if (entity === 'task') {
        d.tasks.delete(id);
        d.taskVer.delete(id);
        d.taskTomb.set(id, version);
      } else {
        d.deps.delete(id);
        d.depVer.delete(id);
        d.depTomb.set(id, version);
      }
    }
  }

  async changesSince(projectId: string, since: number): Promise<ChangedRows> {
    const d = this.read(projectId);
    if (!d) return { tasks: [], deps: [], deletedTaskIds: [], deletedDepIds: [] };
    return {
      tasks: [...d.tasks.values()].filter((t) => (d.taskVer.get(t.id) ?? 0) > since),
      deps: [...d.deps.values()].filter((x) => (d.depVer.get(x.id) ?? 0) > since),
      deletedTaskIds: [...d.taskTomb].filter(([, v]) => v > since).map(([id]) => id),
      deletedDepIds: [...d.depTomb].filter(([, v]) => v > since).map(([id]) => id),
    };
  }

  async getViewState(projectId: string, userId: string): Promise<ViewState | null> {
    return this.read(projectId)?.viewStates.get(userId) ?? null;
  }

  async setViewState(projectId: string, userId: string, vs: ViewState): Promise<void> {
    this.write(projectId).viewStates.set(userId, vs);
  }

  async listSnapshots(projectId: string): Promise<SnapshotMeta[]> {
    const rows = this.read(projectId)?.snapshots ?? [];
    return rows
      .map(({ seq, projectId: projectId2, createdAt, label, taskCount }) => ({
        seq,
        projectId: projectId2,
        createdAt,
        label,
        taskCount,
      }))
      .sort((a, b) => b.seq - a.seq);
  }

  async getSnapshot(projectId: string, seq: number): Promise<SnapshotRow | null> {
    return this.read(projectId)?.snapshots.find((s) => s.seq === seq) ?? null;
  }

  async insertSnapshot(projectId: string, s: NewSnapshot): Promise<number> {
    const seq = this.nextSeq();
    this.write(projectId).snapshots.push({ seq, projectId, ...s, doc: structuredClone(s.doc) });
    return seq;
  }

  async deleteSnapshots(projectId: string, seqs: number[]): Promise<void> {
    const d = this.write(projectId);
    const drop = new Set(seqs);
    d.snapshots = d.snapshots.filter((s) => !drop.has(s.seq));
  }
}
