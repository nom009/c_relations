// ============================================================================
// ドキュメント検証（§5.2 バリデーション①〜⑦）。UI/データの二重防御（§2.4）。
// 構造・型は Zod、意味的整合（ID一意・参照実在・DAG）は行番号つきエラーで報告。
// ============================================================================
import type { GraphDoc } from './types';
import { graphDocSchema } from './schema';
import { topoSort } from './graph';

export interface ValidateResult {
  ok: boolean;
  errors: string[];
}

// 意味的検証（§5.2 ①〜⑦のうち Zod で表現できないもの）。
// mock の validateDoc と同一挙動＋DAG検証を保持。unknown を受け取り緩く走査する（例外を投げない）。
type Loose = Record<string, unknown>;
// 配列でなければ空、要素がオブジェクトでなければ空オブジェクトとして扱う。
const looseList = (v: unknown): Loose[] =>
  Array.isArray(v) ? v.map((x): Loose => (x && typeof x === 'object' ? (x as Loose) : {})) : [];
const key = (v: unknown): string => String(v);

export function validateSemantics(doc: unknown): ValidateResult {
  const errors: string[] = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['ルートがオブジェクトではありません'] };
  const root = doc as Loose;
  const tasks = looseList(root.tasks);
  const deps = looseList(root.dependencies);

  const ids = new Set<unknown>();
  tasks.forEach((t, i) => {
    if (ids.has(t.id)) errors.push(`tasks[${i}] ID重複: ${key(t.id)}`);
    ids.add(t.id);
    if (t.isMilestone && t.durationDays !== 0) errors.push(`tasks[${i}] milestoneはduration=0が必要`);
    const p = t.progress;
    if (typeof p === 'number' && (p < 0 || p > 100)) errors.push(`tasks[${i}] progressが0-100外`);
  });

  const depIds = new Set<unknown>();
  deps.forEach((d, i) => {
    if (depIds.has(d.id)) errors.push(`dependencies[${i}] ID重複: ${key(d.id)}`);
    depIds.add(d.id);
    if (!ids.has(d.predecessorId)) errors.push(`dependencies[${i}] predecessor不明`);
    if (!ids.has(d.successorId)) errors.push(`dependencies[${i}] successor不明`);
    if (d.predecessorId === d.successorId) errors.push(`dependencies[${i}] 自己ループ`);
  });

  const pairSeen = new Set<string>();
  deps.forEach((d, i) => {
    const k = key(d.predecessorId) + '>' + key(d.successorId);
    if (pairSeen.has(k)) errors.push(`dependencies[${i}] 重複エッジ`);
    pairSeen.add(k);
  });

  const topo = topoSort(
    tasks.map((t) => ({ id: key(t.id) })),
    deps.map((d) => ({ predecessorId: key(d.predecessorId), successorId: key(d.successorId) })),
  );
  if (!topo.ok) errors.push('DAG違反: 循環が存在します');
  return { ok: errors.length === 0, errors };
}

// 完全検証: Zod（構造・型）→ 意味的検証（整合・DAG）。インポート/読込時に実行（§5.2）。
export function validateDoc(doc: unknown): ValidateResult {
  const parsed = graphDocSchema.safeParse(doc);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`);
    return { ok: false, errors };
  }
  return validateSemantics(parsed.data);
}

// 型付きでパース（成功時 GraphDoc を返す）。失敗時は例外を投げず null。
export function parseDoc(doc: unknown): GraphDoc | null {
  const parsed = graphDocSchema.safeParse(doc);
  if (!parsed.success) return null;
  const sem = validateSemantics(parsed.data);
  if (!sem.ok) return null;
  return parsed.data as GraphDoc;
}
