// ============================================================================
// Zod スキーマ（§5.2 JSONスキーマの構造・型の真実）。交換フォーマット兼ストレージ。
// 意味的検証（ID一意・参照整合・DAG）は validate.ts で別途行う（§5.2 バリデーション①〜⑦）。
// ============================================================================
import { z } from 'zod';

// 所要日数・ラグの上限（約100年）。CPM の稼働日ループが暴走しないよう取込時に制限する。
const MAX_DAYS = 36500;

export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

// 実在する暦日の 'YYYY-MM-DD'。不正な基準日はガント描画（toISOString）で例外になるため取込時に弾く。
export const isoDateSchema = z.string().refine(isValidIsoDate, { message: 'invalid date' });

export const disciplineSchema = z.enum(['E', 'P', 'C', 'OTHER']);
export const statusSchema = z.enum(['NOT_STARTED', 'IN_PROGRESS', 'DONE', 'ON_HOLD']);
export const constraintTypeSchema = z.enum(['ASAP', 'SNET', 'FNLT']);
export const dependencyTypeSchema = z.enum(['FS', 'SS', 'FF', 'SF']);
export const displayModeSchema = z.enum(['DIM', 'ISOLATE']);

export const positionSchema = z.object({ x: z.number(), y: z.number() });

export const taskSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  wbsCode: z.string(),
  discipline: disciplineSchema,
  isMilestone: z.boolean(),
  durationDays: z.number().finite().min(0).max(MAX_DAYS),
  status: statusSchema,
  progress: z.number().int().min(0).max(100),
  assignee: z.string(),
  constraintType: constraintTypeSchema,
  constraintDate: isoDateSchema.nullable(),
  notes: z.string(),
  position: positionSchema,
  rev: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string(),
});

export const dependencySchema = z.object({
  id: z.string().min(1),
  predecessorId: z.string().min(1),
  successorId: z.string().min(1),
  type: dependencyTypeSchema,
  lagDays: z.number().finite().min(-MAX_DAYS).max(MAX_DAYS),
  rev: z.number().int(),
  updatedAt: z.string(),
  updatedBy: z.string(),
});

export const projectMetaSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  calendarId: z.string(),
  dataDate: isoDateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});

export const viewStateSchema = z.object({
  collapsedWbs: z.array(z.string()),
  expandLevel: z.number().int(),
});

export const graphFilterSchema = z.object({
  wbsPrefixes: z.array(z.string()).optional(),
  disciplines: z.array(disciplineSchema).optional(),
  assignees: z.array(z.string()).optional(),
  statuses: z.array(statusSchema).optional(),
  milestonesOnly: z.boolean().optional(),
  criticalOnly: z.boolean().optional(),
  dateRange: z.object({ from: z.string().optional(), to: z.string().optional() }).optional(),
  text: z.string().optional(),
});

export const savedViewSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  filter: graphFilterSchema,
  displayMode: displayModeSchema,
  collapsedWbs: z.array(z.string()).nullable(),
  createdBy: z.string(),
  updatedAt: z.string(),
  // PR-T2④（optional・前方互換）: テーブルのソート/表示列。key/列はゆるく検証（適用時に妥当性判定）。
  tableSort: z
    .array(z.object({ key: z.string(), dir: z.enum(['asc', 'desc']) }))
    .optional(),
  tableColumns: z.array(z.string()).optional(),
});

export const calendarSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  workingDays: z.array(z.number().int().min(0).max(6)).min(1),
  holidays: z.array(isoDateSchema),
});

export const graphDocSchema = z.object({
  schemaVersion: z.number().int(),
  project: projectMetaSchema,
  viewState: viewStateSchema,
  savedViews: z.array(savedViewSchema),
  calendars: z.array(calendarSchema),
  tasks: z.array(taskSchema),
  dependencies: z.array(dependencySchema),
});

export type GraphDocInput = z.infer<typeof graphDocSchema>;
