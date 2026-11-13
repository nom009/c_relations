import * as mssqlNs from 'mssql';
import type { Calendar, Dependency, SavedView, Task, ViewState } from '../domain';
import type { ProjectRole, SnapshotMeta } from '../contract';
import { DuplicateKeyError } from '../errors';
import { retryTransient, sqlErrNumber } from './retry';
import { SCHEMA_STATEMENTS } from './schema';
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

// mssql は CommonJS。ESM 相互運用の差（named / default）を吸収する。
const mssql = ((mssqlNs as unknown as { default?: typeof mssqlNs }).default ?? mssqlNs) as typeof mssqlNs;

type SqlType = mssqlNs.ISqlType | (() => mssqlNs.ISqlType);
interface Param {
  name: string;
  type: SqlType;
  value: unknown;
}
const p = (name: string, type: SqlType, value: unknown): Param => ({ name, type, value });

const T_ID = mssql.NVarChar(64);
const T_EMAIL = mssql.NVarChar(320);
const T_USER = mssql.NVarChar(128);
const T_TEXT = mssql.NVarChar(mssql.MAX);
const T_INT = mssql.Int;

// SQL Server のパラメータ上限は 2100。チャンクごとに十分余裕を持たせる。
const REQUEST_TIMEOUT_MS = 30_000;
const PUT_CHUNK = 200; // 1 行 3 パラメータ
const ID_CHUNK = 500;

// テーブル名・entity は内部の固定リテラルのみから作る（ユーザー入力は常にパラメータ）。
const TABLE: Record<Entity, string> = { task: 'dbo.tasks', dep: 'dbo.dependencies' };

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface ProjectSqlRow {
  id: string;
  name: string;
  description: string;
  dataDate: string;
  calendarId: string;
  schemaVersion: number;
  version: number;
  metaVersion: number;
  calendars: string;
  savedViews: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

function toRecord(r: ProjectSqlRow): ProjectRecord {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    dataDate: r.dataDate,
    calendarId: r.calendarId,
    schemaVersion: r.schemaVersion,
    version: r.version,
    metaVersion: r.metaVersion,
    calendars: JSON.parse(r.calendars) as Calendar[],
    savedViews: JSON.parse(r.savedViews) as SavedView[],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  };
}

const PROJECT_COLUMNS =
  'id, name, description, dataDate, calendarId, schemaVersion, version, metaVersion, calendars, savedViews, createdAt, updatedAt, updatedBy';

interface MemberSqlRow {
  email: string;
  role: string;
  userId: string | null;
  name: string | null;
  addedAt: string;
  addedBy: string;
}
const toMember = (r: MemberSqlRow): MemberRow => ({
  email: r.email,
  role: r.role as ProjectRole,
  userId: r.userId,
  name: r.name,
  addedAt: r.addedAt,
  addedBy: r.addedBy,
});

interface RowSql {
  data: string;
  rev: number;
}
const toRow = <T extends { rev: number }>(r: RowSql): T => ({ ...(JSON.parse(r.data) as T), rev: r.rev });

export class SqlStore implements ServerStore {
  private poolPromise: Promise<mssqlNs.ConnectionPool> | null = null;

  constructor(private readonly connectionString: string) {}

  private getPool(): Promise<mssqlNs.ConnectionPool> {
    if (!this.poolPromise) {
      const pp = retryTransient(async () => {
        const pool = new mssql.ConnectionPool(this.connectionString);
        // 既定 15 秒だと再開直後の初回クエリが切れる。接続文字列に明示が無ければ延ばす（型定義に無い内部設定）。
        const cfg = (pool as unknown as { config?: { requestTimeout?: number } }).config;
        if (cfg && !/request\s*timeout/i.test(this.connectionString)) cfg.requestTimeout = REQUEST_TIMEOUT_MS;
        pool.on('error', (e: unknown) => console.error('[sql] pool error', e));
        try {
          await pool.connect();
          for (const stmt of SCHEMA_STATEMENTS) {
            try {
              await pool.request().batch(stmt);
            } catch (e) {
              // 並行コールドスタートでの作成競合（既存オブジェクト）は無視。
              const n = sqlErrNumber(e);
              if (n !== 2714 && n !== 1913 && n !== 2705) throw e;
            }
          }
        } catch (e) {
          await pool.close().catch(() => undefined);
          throw e;
        }
        return pool;
      });
      pp.catch(() => {
        if (this.poolPromise === pp) this.poolPromise = null; // 次回呼び出しで再接続
      });
      this.poolPromise = pp;
    }
    return this.poolPromise;
  }

  async close(): Promise<void> {
    const pp = this.poolPromise;
    this.poolPromise = null;
    if (pp) await (await pp).close();
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const pool = await this.getPool();
    for (let attempt = 0; ; attempt++) {
      const t = new mssql.Transaction(pool);
      await t.begin();
      try {
        const result = await fn(new SqlTx(t));
        await t.commit();
        return result;
      } catch (e) {
        try {
          await t.rollback();
        } catch {
          /* 既に中断済み */
        }
        if (attempt < 2 && sqlErrNumber(e) === 1205) continue; // デッドロック被害者は再実行
        throw e;
      }
    }
  }
}

class SqlTx implements Tx {
  constructor(private readonly t: mssqlNs.Transaction) {}

  private async q<R = Record<string, unknown>>(text: string, params: Param[] = []): Promise<R[]> {
    const req = new mssql.Request(this.t);
    for (const x of params) req.input(x.name, x.type, x.value);
    const res = await req.query(text);
    return (res.recordset ?? []) as unknown as R[];
  }

  async listProjectsFor(email: string): Promise<ProjectListItem[]> {
    const rows = await this.q<ProjectSqlRow & { role: string; taskCount: number }>(
      `SELECT ${PROJECT_COLUMNS.split(', ')
        .map((c) => 'p.' + c)
        .join(', ')}, m.role AS role,
        (SELECT COUNT(*) FROM dbo.tasks t WHERE t.projectId = p.id) AS taskCount
       FROM dbo.members m JOIN dbo.projects p ON p.id = m.projectId
       WHERE m.email = @email
       ORDER BY p.updatedAt DESC`,
      [p('email', T_EMAIL, email)],
    );
    return rows.map((r) => ({ record: toRecord(r), role: r.role as ProjectRole, taskCount: r.taskCount }));
  }

  async recordIdentity(email: string, userId: string, name: string): Promise<void> {
    await this.q(
      `UPDATE dbo.members SET userId = @userId, name = @name
       WHERE email = @email AND (userId IS NULL OR userId <> @userId OR name IS NULL OR name <> @name)`,
      [p('email', T_EMAIL, email), p('userId', T_USER, userId), p('name', T_TEXT, name)],
    );
  }

  async getProject(id: string, lock: boolean): Promise<ProjectRecord | null> {
    const hint = lock ? 'WITH (UPDLOCK, ROWLOCK)' : '';
    const rows = await this.q<ProjectSqlRow>(`SELECT ${PROJECT_COLUMNS} FROM dbo.projects ${hint} WHERE id = @id`, [
      p('id', T_ID, id),
    ]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  private projectParams(rec: ProjectRecord): Param[] {
    return [
      p('id', T_ID, rec.id),
      p('name', T_TEXT, rec.name),
      p('description', T_TEXT, rec.description),
      p('dataDate', mssql.NVarChar(32), rec.dataDate),
      p('calendarId', T_TEXT, rec.calendarId),
      p('schemaVersion', T_INT, rec.schemaVersion),
      p('version', T_INT, rec.version),
      p('metaVersion', T_INT, rec.metaVersion),
      p('calendars', T_TEXT, JSON.stringify(rec.calendars)),
      p('savedViews', T_TEXT, JSON.stringify(rec.savedViews)),
      p('createdAt', T_TEXT, rec.createdAt),
      p('updatedAt', mssql.NVarChar(64), rec.updatedAt),
      p('updatedBy', T_EMAIL, rec.updatedBy),
    ];
  }

  async insertProject(rec: ProjectRecord): Promise<void> {
    try {
      await this.q(
        `INSERT INTO dbo.projects (${PROJECT_COLUMNS})
         VALUES (@id, @name, @description, @dataDate, @calendarId, @schemaVersion, @version, @metaVersion, @calendars, @savedViews, @createdAt, @updatedAt, @updatedBy)`,
        this.projectParams(rec),
      );
    } catch (e) {
      const n = sqlErrNumber(e);
      if (n === 2627 || n === 2601) throw new DuplicateKeyError(`project exists: ${rec.id}`);
      throw e;
    }
  }

  async updateProject(rec: ProjectRecord): Promise<void> {
    await this.q(
      `UPDATE dbo.projects SET name = @name, description = @description, dataDate = @dataDate, calendarId = @calendarId,
         schemaVersion = @schemaVersion, version = @version, metaVersion = @metaVersion, calendars = @calendars,
         savedViews = @savedViews, createdAt = @createdAt, updatedAt = @updatedAt, updatedBy = @updatedBy
       WHERE id = @id`,
      this.projectParams(rec),
    );
  }

  async deleteProject(id: string): Promise<void> {
    await this.q(
      `DELETE FROM dbo.tasks WHERE projectId = @id;
       DELETE FROM dbo.dependencies WHERE projectId = @id;
       DELETE FROM dbo.tombstones WHERE projectId = @id;
       DELETE FROM dbo.members WHERE projectId = @id;
       DELETE FROM dbo.user_view_state WHERE projectId = @id;
       DELETE FROM dbo.snapshots WHERE projectId = @id;
       DELETE FROM dbo.projects WHERE id = @id;`,
      [p('id', T_ID, id)],
    );
  }

  async getMember(projectId: string, email: string): Promise<MemberRow | null> {
    const rows = await this.q<MemberSqlRow>(
      `SELECT email, role, userId, name, addedAt, addedBy FROM dbo.members WHERE projectId = @pid AND email = @email`,
      [p('pid', T_ID, projectId), p('email', T_EMAIL, email)],
    );
    return rows[0] ? toMember(rows[0]) : null;
  }

  async listMembers(projectId: string): Promise<MemberRow[]> {
    const rows = await this.q<MemberSqlRow>(
      `SELECT email, role, userId, name, addedAt, addedBy FROM dbo.members WHERE projectId = @pid`,
      [p('pid', T_ID, projectId)],
    );
    return rows.map(toMember);
  }

  async insertMember(projectId: string, m: MemberRow): Promise<void> {
    await this.q(
      `INSERT INTO dbo.members (projectId, email, role, userId, name, addedAt, addedBy)
       VALUES (@pid, @email, @role, @userId, @name, @addedAt, @addedBy)`,
      [
        p('pid', T_ID, projectId),
        p('email', T_EMAIL, m.email),
        p('role', mssql.NVarChar(16), m.role),
        p('userId', T_USER, m.userId),
        p('name', T_TEXT, m.name),
        p('addedAt', mssql.NVarChar(64), m.addedAt),
        p('addedBy', T_EMAIL, m.addedBy),
      ],
    );
  }

  async setMemberRole(projectId: string, email: string, role: ProjectRole): Promise<void> {
    await this.q(`UPDATE dbo.members SET role = @role WHERE projectId = @pid AND email = @email`, [
      p('pid', T_ID, projectId),
      p('email', T_EMAIL, email),
      p('role', mssql.NVarChar(16), role),
    ]);
  }

  async setMemberIdentity(projectId: string, email: string, userId: string, name: string): Promise<void> {
    await this.q(`UPDATE dbo.members SET userId = @userId, name = @name WHERE projectId = @pid AND email = @email`, [
      p('pid', T_ID, projectId),
      p('email', T_EMAIL, email),
      p('userId', T_USER, userId),
      p('name', T_TEXT, name),
    ]);
  }

  async deleteMember(projectId: string, email: string): Promise<void> {
    await this.q(`DELETE FROM dbo.members WHERE projectId = @pid AND email = @email`, [
      p('pid', T_ID, projectId),
      p('email', T_EMAIL, email),
    ]);
  }

  async listTasks(projectId: string): Promise<Task[]> {
    const rows = await this.q<RowSql>(`SELECT data, rev FROM dbo.tasks WHERE projectId = @pid ORDER BY id`, [
      p('pid', T_ID, projectId),
    ]);
    return rows.map((r) => toRow<Task>(r));
  }

  async listDeps(projectId: string): Promise<Dependency[]> {
    const rows = await this.q<RowSql>(`SELECT data, rev FROM dbo.dependencies WHERE projectId = @pid ORDER BY id`, [
      p('pid', T_ID, projectId),
    ]);
    return rows.map((r) => toRow<Dependency>(r));
  }

  private async putRows(
    entity: Entity,
    projectId: string,
    rows: { id: string; rev: number }[],
    changedVersion: number,
  ): Promise<void> {
    const table = TABLE[entity];
    for (const chunk of chunks(rows, PUT_CHUNK)) {
      const params: Param[] = [p('pid', T_ID, projectId), p('cv', T_INT, changedVersion)];
      const values: string[] = [];
      chunk.forEach((r, i) => {
        params.push(p(`i${i}`, T_ID, r.id), p(`d${i}`, T_TEXT, JSON.stringify(r)), p(`r${i}`, T_INT, r.rev));
        values.push(`(@i${i}, @d${i}, @r${i})`);
      });
      await this.q(
        `DECLARE @s TABLE (id NVARCHAR(64) NOT NULL PRIMARY KEY, data NVARCHAR(MAX) NOT NULL, rev INT NOT NULL);
         INSERT INTO @s (id, data, rev) VALUES ${values.join(', ')};
         UPDATE t SET t.data = s.data, t.rev = s.rev, t.changedVersion = @cv
           FROM ${table} t JOIN @s s ON s.id = t.id WHERE t.projectId = @pid;
         INSERT INTO ${table} (projectId, id, data, rev, changedVersion)
           SELECT @pid, s.id, s.data, s.rev, @cv FROM @s s
           WHERE NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.projectId = @pid AND t.id = s.id);
         DELETE tb FROM dbo.tombstones tb JOIN @s s ON s.id = tb.id
           WHERE tb.projectId = @pid AND tb.entity = '${entity}';`,
        params,
      );
    }
  }

  putTasks(projectId: string, rows: Task[], changedVersion: number): Promise<void> {
    return this.putRows('task', projectId, rows, changedVersion);
  }

  putDeps(projectId: string, rows: Dependency[], changedVersion: number): Promise<void> {
    return this.putRows('dep', projectId, rows, changedVersion);
  }

  async deleteRows(projectId: string, entity: Entity, ids: string[], version: number): Promise<void> {
    const table = TABLE[entity];
    for (const chunk of chunks(ids, ID_CHUNK)) {
      const params: Param[] = [p('pid', T_ID, projectId), p('v', T_INT, version)];
      chunk.forEach((id, i) => params.push(p(`i${i}`, T_ID, id)));
      const list = chunk.map((_, i) => `@i${i}`).join(', ');
      const tomb = chunk.map((_, i) => `(@pid, '${entity}', @i${i}, @v)`).join(', ');
      await this.q(
        `DELETE FROM ${table} WHERE projectId = @pid AND id IN (${list});
         DELETE FROM dbo.tombstones WHERE projectId = @pid AND entity = '${entity}' AND id IN (${list});
         INSERT INTO dbo.tombstones (projectId, entity, id, version) VALUES ${tomb};`,
        params,
      );
    }
  }

  async changesSince(projectId: string, since: number): Promise<ChangedRows> {
    const params = [p('pid', T_ID, projectId), p('since', T_INT, since)];
    const tasks = await this.q<RowSql>(
      `SELECT data, rev FROM dbo.tasks WHERE projectId = @pid AND changedVersion > @since`,
      params,
    );
    const deps = await this.q<RowSql>(
      `SELECT data, rev FROM dbo.dependencies WHERE projectId = @pid AND changedVersion > @since`,
      params,
    );
    const tombs = await this.q<{ entity: string; id: string }>(
      `SELECT entity, id FROM dbo.tombstones WHERE projectId = @pid AND version > @since`,
      params,
    );
    return {
      tasks: tasks.map((r) => toRow<Task>(r)),
      deps: deps.map((r) => toRow<Dependency>(r)),
      deletedTaskIds: tombs.filter((x) => x.entity.trim() === 'task').map((x) => x.id),
      deletedDepIds: tombs.filter((x) => x.entity.trim() === 'dep').map((x) => x.id),
    };
  }

  async getViewState(projectId: string, userId: string): Promise<ViewState | null> {
    const rows = await this.q<{ viewState: string }>(
      `SELECT viewState FROM dbo.user_view_state WHERE projectId = @pid AND userId = @uid`,
      [p('pid', T_ID, projectId), p('uid', T_USER, userId)],
    );
    return rows[0] ? (JSON.parse(rows[0].viewState) as ViewState) : null;
  }

  async setViewState(projectId: string, userId: string, vs: ViewState): Promise<void> {
    await this.q(
      `UPDATE dbo.user_view_state SET viewState = @vs WHERE projectId = @pid AND userId = @uid;
       IF @@ROWCOUNT = 0
         INSERT INTO dbo.user_view_state (projectId, userId, viewState) VALUES (@pid, @uid, @vs);`,
      [p('pid', T_ID, projectId), p('uid', T_USER, userId), p('vs', T_TEXT, JSON.stringify(vs))],
    );
  }

  async listSnapshots(projectId: string): Promise<SnapshotMeta[]> {
    return this.q<SnapshotMeta>(
      `SELECT seq, projectId, createdAt, label, taskCount FROM dbo.snapshots WHERE projectId = @pid ORDER BY seq DESC`,
      [p('pid', T_ID, projectId)],
    );
  }

  async getSnapshot(projectId: string, seq: number): Promise<SnapshotRow | null> {
    const rows = await this.q<SnapshotMeta & { doc: string }>(
      `SELECT seq, projectId, createdAt, label, taskCount, doc FROM dbo.snapshots WHERE projectId = @pid AND seq = @seq`,
      [p('pid', T_ID, projectId), p('seq', T_INT, seq)],
    );
    const r = rows[0];
    return r ? { ...r, doc: JSON.parse(r.doc) as SnapshotRow['doc'] } : null;
  }

  async insertSnapshot(projectId: string, s: NewSnapshot): Promise<number> {
    const rows = await this.q<{ seq: number }>(
      `INSERT INTO dbo.snapshots (projectId, createdAt, label, taskCount, doc)
       OUTPUT INSERTED.seq
       VALUES (@pid, @createdAt, @label, @taskCount, @doc)`,
      [
        p('pid', T_ID, projectId),
        p('createdAt', mssql.NVarChar(64), s.createdAt),
        p('label', mssql.NVarChar(64), s.label),
        p('taskCount', T_INT, s.taskCount),
        p('doc', T_TEXT, JSON.stringify(s.doc)),
      ],
    );
    return rows[0].seq;
  }

  async deleteSnapshots(projectId: string, seqs: number[]): Promise<void> {
    for (const chunk of chunks(seqs, ID_CHUNK)) {
      const params: Param[] = [p('pid', T_ID, projectId)];
      chunk.forEach((s, i) => params.push(p(`s${i}`, T_INT, s)));
      await this.q(
        `DELETE FROM dbo.snapshots WHERE projectId = @pid AND seq IN (${chunk.map((_, i) => `@s${i}`).join(', ')})`,
        params,
      );
    }
  }
}
