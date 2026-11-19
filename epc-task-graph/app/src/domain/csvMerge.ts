// ============================================================================
// CSV 更新取込: 現在のプロジェクトに CSV の内容を反映する計画を作る（UI非依存の純関数）。
// タスクは ID で突き合わせる。一致 → CSV の列の値で更新、一致しない行 → 追加、
// CSV に無い既存タスク → 削除。依存は CSV の先行タスクに置き換える（同じ組は ID を保つ）。
// ============================================================================
import type { Dependency, Task } from './types';
import { CSV_TASK_FIELDS, type CsvTaskField } from './csv';
import { newId } from './factory';
import { normalizeTaskPatch } from './taskEditing';

export interface CsvMergeSummary {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  depsAdded: number;
  depsRemoved: number;
  depsKept: number;
  // depsKept のうち種類・ラグが変わるもの。
  depsUpdated: number;
}

export interface CsvMergePlan {
  tasks: Task[];
  dependencies: Dependency[];
  addedIds: string[];
  removedTasks: Task[];
  // 削除される既存依存の ID。
  removedDepIds: string[];
  summary: CsvMergeSummary;
}

export interface CsvMergeInput {
  tasks: Task[];
  dependencies: Dependency[];
  // CSV に列があった項目（省略時は全項目）。無い列の項目は既存値を保つ。
  fields?: readonly CsvTaskField[];
  // false なら先行タスク列が無い → 既存の依存を保つ。
  hasPredecessors?: boolean;
}

// CSV が持つ項目が等しいか。ASAP の制約日は意味を持たないので比べない。
export function csvFieldsEqual(a: Task, b: Task, fields: readonly CsvTaskField[] = CSV_TASK_FIELDS): boolean {
  return fields.every((f) => {
    if (f === 'constraintDate' && a.constraintType === 'ASAP' && b.constraintType === 'ASAP') return true;
    return (a[f] ?? null) === (b[f] ?? null);
  });
}

// CSV が持つ項目だけを取り出す（store が既存行へ上書きする用）。
export function pickCsvFields(t: Task): Pick<Task, CsvTaskField> {
  return {
    name: t.name,
    wbsCode: t.wbsCode,
    discipline: t.discipline,
    isMilestone: t.isMilestone,
    durationDays: t.durationDays,
    status: t.status,
    progress: t.progress,
    assignee: t.assignee,
    constraintType: t.constraintType,
    constraintDate: t.constraintDate,
    notes: t.notes,
    actualStart: t.actualStart ?? null,
    actualFinish: t.actualFinish ?? null,
  };
}

function copyField<K extends CsvTaskField>(to: Task, from: Task, f: K): void {
  to[f] = from[f];
}

function mergeTask(cur: Task, imp: Task, fields: readonly CsvTaskField[]): Task {
  const next: Task = { ...cur };
  for (const f of fields) {
    if (f === 'actualStart' || f === 'actualFinish') next[f] = imp[f] ?? null;
    else copyField(next, imp, f);
  }
  // ステータス/進捗の片方だけ列がある場合は、もう片方を編集時と同じ規則で整える。
  const ownsStatus = fields.includes('status');
  const ownsProgress = fields.includes('progress');
  if (ownsStatus !== ownsProgress) {
    const patch = normalizeTaskPatch(cur, ownsStatus ? { status: imp.status } : { progress: imp.progress });
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.progress !== undefined) next.progress = patch.progress;
  }
  if (next.isMilestone) next.durationDays = 0;
  return csvFieldsEqual(cur, next) ? cur : next;
}

const pairKey = (d: Pick<Dependency, 'predecessorId' | 'successorId'>) => d.predecessorId + '>' + d.successorId;

export function planCsvMerge(
  current: { tasks: Task[]; dependencies: Dependency[] },
  imported: CsvMergeInput,
): CsvMergePlan {
  const fields = imported.fields ?? CSV_TASK_FIELDS;
  const curById = new Map(current.tasks.map((t) => [t.id, t]));
  const matched = new Set<string>();
  // CSV 側の ID → 結果の ID。
  const idMap = new Map<string, string>();
  const tasks: Task[] = [];
  const addedIds: string[] = [];
  let updated = 0;
  let unchanged = 0;
  for (const imp of imported.tasks) {
    const cur = curById.get(imp.id);
    if (cur && !matched.has(cur.id)) {
      matched.add(cur.id);
      idMap.set(imp.id, cur.id);
      const next = mergeTask(cur, imp, fields);
      if (next === cur) unchanged++;
      else updated++;
      tasks.push(next);
    } else {
      // 一致しない行は新しい ID で追加（他プロジェクトの ID と衝突させない）。位置は呼び出し側で整列。
      const id = newId();
      idMap.set(imp.id, id);
      addedIds.push(id);
      tasks.push({ ...imp, id, position: { x: 0, y: 0 } });
    }
  }
  const removedTasks = current.tasks.filter((t) => !matched.has(t.id));

  const keptDepIds = new Set<string>();
  let dependencies: Dependency[];
  let depsAdded = 0;
  let depsUpdated = 0;
  if (imported.hasPredecessors !== false) {
    const curByPair = new Map(current.dependencies.map((d) => [pairKey(d), d]));
    const seen = new Set<string>();
    dependencies = [];
    for (const d of imported.dependencies) {
      const predecessorId = idMap.get(d.predecessorId);
      const successorId = idMap.get(d.successorId);
      if (!predecessorId || !successorId) continue;
      const k = pairKey({ predecessorId, successorId });
      if (seen.has(k)) continue;
      seen.add(k);
      const cur = curByPair.get(k);
      if (cur) {
        keptDepIds.add(cur.id);
        if (cur.type === d.type && cur.lagDays === d.lagDays) dependencies.push(cur);
        else {
          depsUpdated++;
          dependencies.push({ ...cur, type: d.type, lagDays: d.lagDays });
        }
      } else {
        depsAdded++;
        dependencies.push({ ...d, predecessorId, successorId });
      }
    }
  } else {
    const alive = new Set(tasks.map((t) => t.id));
    dependencies = current.dependencies.filter((d) => alive.has(d.predecessorId) && alive.has(d.successorId));
    for (const d of dependencies) keptDepIds.add(d.id);
  }
  const removedDepIds = current.dependencies.filter((d) => !keptDepIds.has(d.id)).map((d) => d.id);

  return {
    tasks,
    dependencies,
    addedIds,
    removedTasks,
    removedDepIds,
    summary: {
      added: addedIds.length,
      updated,
      unchanged,
      removed: removedTasks.length,
      depsAdded,
      depsRemoved: removedDepIds.length,
      depsKept: keptDepIds.size,
      depsUpdated,
    },
  };
}
