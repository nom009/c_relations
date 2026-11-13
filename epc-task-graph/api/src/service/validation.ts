import { z } from 'zod';
import {
  dependencySchema,
  graphDocSchema,
  migrateDoc,
  parseDoc,
  projectMetaSchema,
  repairDoc,
  taskSchema,
  validateDoc,
  viewStateSchema,
} from '../domain';
import type { Calendar, Dependency, GraphDoc, SavedView, Task, ViewState } from '../domain';
import type { ProjectRole } from '../contract';
import { invalid } from '../errors';

// SQL の主キー列幅（NVARCHAR(64)）に合わせた ID 長の上限。
export const MAX_ID_LEN = 64;
const MAX_ERRORS = 50;

export function checkIdLen(kind: string, id: string): void {
  if (id.length > MAX_ID_LEN) throw invalid(`${kind} の ID が長すぎます（最大 ${MAX_ID_LEN} 文字）`);
}

// 全量ドキュメント: 移行→修復→検証（スキーマ＋DAG・参照整合）。クライアントの読込処理と同じ順序。
export function prepareDoc(raw: unknown): GraphDoc {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('GraphDoc がオブジェクトではありません');
  let migrated: unknown;
  try {
    migrated = migrateDoc(raw).doc; // 新しい schemaVersion は NewerSchemaError（422）
  } catch (e) {
    throw invalid(e instanceof Error ? e.message : '移行に失敗しました');
  }
  const repaired = repairDoc(migrated).doc;
  const v = validateDoc(repaired);
  if (!v.ok) throw invalid('ドキュメントの検証に失敗しました', v.errors.slice(0, MAX_ERRORS));
  const doc = parseDoc(repaired); // 未知のキーを落とした純粋なコピー
  if (!doc) throw invalid('ドキュメントの検証に失敗しました');
  checkIdLen('project', doc.project.id);
  for (const t of doc.tasks) checkIdLen('task', t.id);
  for (const d of doc.dependencies) checkIdLen('dependency', d.id);
  return doc;
}

export interface ParsedPatch {
  projectId?: string;
  upsertTasks: { row: Task; baseRev: number }[];
  deleteTaskIds: { id: string; baseRev: number }[];
  upsertDeps: { row: Dependency; baseRev: number }[];
  deleteDepIds: { id: string; baseRev: number }[];
  project?: Partial<Pick<GraphDoc['project'], 'name' | 'description' | 'dataDate' | 'calendarId'>>;
  viewState?: ViewState;
  savedViews?: SavedView[];
  calendars?: Calendar[];
}

// 外枠のみを api 側の zod で検証し、行本体はドメインのスキーマ（別インスタンスでも合成せず単独で）に通す。
const idRev = z.object({ id: z.string().min(1), baseRev: z.number().int().min(0) });
const patchEnvelope = z.object({
  projectId: z.string().optional(),
  upsertTasks: z.array(z.record(z.string(), z.unknown())),
  deleteTaskIds: z.array(idRev),
  upsertDeps: z.array(z.record(z.string(), z.unknown())),
  deleteDepIds: z.array(idRev),
  project: z.record(z.string(), z.unknown()).optional(),
  viewState: z.unknown().optional(),
  savedViews: z.unknown().optional(),
  calendars: z.unknown().optional(),
});

const projectPatchSchema = projectMetaSchema
  .pick({ name: true, description: true, dataDate: true, calendarId: true })
  .partial();

function fmt(prefix: string, issues: { path: PropertyKey[]; message: string }[]): string[] {
  return issues.map((i) => `${prefix}${i.path.length ? '.' + i.path.map(String).join('.') : ''}: ${i.message}`);
}

interface RowParser {
  safeParse(v: unknown):
    | { success: true; data: unknown }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

function parseRows<T>(
  kind: string,
  rows: Record<string, unknown>[],
  schema: RowParser,
  errors: string[],
): { row: T; baseRev: number }[] {
  const out: { row: T; baseRev: number }[] = [];
  rows.forEach((raw, i) => {
    const prefix = `${kind}[${i}]`;
    const baseRev = raw.baseRev;
    if (typeof baseRev !== 'number' || !Number.isInteger(baseRev) || baseRev < 0) {
      errors.push(`${prefix}.baseRev: 0 以上の整数が必要です`);
      return;
    }
    const rest: Record<string, unknown> = { ...raw };
    delete rest.baseRev;
    const r = schema.safeParse(rest);
    if (!r.success) errors.push(...fmt(prefix, r.error.issues));
    else out.push({ row: r.data as T, baseRev });
  });
  return out;
}

function dupIds(kind: string, ids: string[], errors: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) errors.push(`${kind}: ID が重複しています: ${id}`);
    seen.add(id);
  }
}

export function parsePatch(body: unknown): ParsedPatch {
  const env = patchEnvelope.safeParse(body);
  if (!env.success) throw invalid('パッチの形式が不正です', fmt('patch', env.error.issues).slice(0, MAX_ERRORS));
  const b = env.data;
  const errors: string[] = [];

  const upsertTasks = parseRows<Task>('upsertTasks', b.upsertTasks, taskSchema, errors);
  const upsertDeps = parseRows<Dependency>('upsertDeps', b.upsertDeps, dependencySchema, errors);
  dupIds('upsertTasks', upsertTasks.map((x) => x.row.id), errors);
  dupIds('deleteTaskIds', b.deleteTaskIds.map((x) => x.id), errors);
  dupIds('upsertDeps', upsertDeps.map((x) => x.row.id), errors);
  dupIds('deleteDepIds', b.deleteDepIds.map((x) => x.id), errors);
  const upT = new Set(upsertTasks.map((x) => x.row.id));
  for (const d of b.deleteTaskIds) if (upT.has(d.id)) errors.push(`task ${d.id} が upsert と delete の両方に含まれています`);
  const upD = new Set(upsertDeps.map((x) => x.row.id));
  for (const d of b.deleteDepIds) if (upD.has(d.id)) errors.push(`dependency ${d.id} が upsert と delete の両方に含まれています`);

  const out: ParsedPatch = {
    projectId: b.projectId,
    upsertTasks,
    deleteTaskIds: b.deleteTaskIds,
    upsertDeps,
    deleteDepIds: b.deleteDepIds,
  };

  if (b.project !== undefined) {
    const r = projectPatchSchema.safeParse(b.project);
    if (!r.success) errors.push(...fmt('project', r.error.issues));
    else out.project = r.data;
  }
  if (b.viewState !== undefined) {
    const r = viewStateSchema.safeParse(b.viewState);
    if (!r.success) errors.push(...fmt('viewState', r.error.issues));
    else out.viewState = r.data;
  }
  if (b.savedViews !== undefined) {
    const r = graphDocSchema.shape.savedViews.safeParse(b.savedViews);
    if (!r.success) errors.push(...fmt('savedViews', r.error.issues));
    else out.savedViews = r.data as SavedView[];
  }
  if (b.calendars !== undefined) {
    const r = graphDocSchema.shape.calendars.safeParse(b.calendars);
    if (!r.success) errors.push(...fmt('calendars', r.error.issues));
    else if (r.data.length === 0) errors.push('calendars: 1 件以上必要です');
    else out.calendars = r.data as Calendar[];
  }

  if (errors.length) throw invalid('パッチの検証に失敗しました', errors.slice(0, MAX_ERRORS));
  for (const x of upsertTasks) checkIdLen('task', x.row.id);
  for (const x of upsertDeps) checkIdLen('dependency', x.row.id);
  return out;
}

const ROLES: readonly string[] = ['owner', 'editor', 'viewer'];
export const isRole = (v: unknown): v is ProjectRole => typeof v === 'string' && ROLES.includes(v);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizeEmail(v: unknown): string {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!e || e.length > 320 || !EMAIL_RE.test(e)) throw invalid('メールアドレスの形式が不正です');
  return e;
}
