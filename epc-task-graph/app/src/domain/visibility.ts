// ============================================================================
// 可視性の共通段（§2.6/§12.3.1）: フィルタ判定 → 近傍フォーカス → 前後文脈 → 実効折り畳み。
// deriveVisibleGraph（グラフ）と deriveTableRows（テーブル/ガント）が同じ規則を共有する。
// 全段 O(V+E)。折り畳み解決は WBS 深さ d に対し O(V·d)（折り畳み数に依存しない）。
// ============================================================================
import type { Dependency, DisplayMode, FocusSpec, Neighborhood, Task, ViewSpec } from './types';
import { buildAdjacency, expandBoundary, neighborhood } from './graph';
import { isFilterActive, matchesFilter } from './filter';
import { wbsPrefixesOf } from './wbs';

export interface Visibility {
  taskById: Map<string, Task>;
  succ: Map<string, Set<string>>;
  pred: Map<string, Set<string>>;
  active: boolean; // フィルタが効いているか
  matchSet: Set<string>; // フィルタ一致（active 時のみ意味を持つ）
  focus: FocusSpec | null; // 実在タスクを起点とする時のみ非 null
  nb: Neighborhood | null;
  isoRemove: boolean; // ISOLATE で非一致を除去するか（フォーカス中は無効）
  boundarySet: Set<string> | null; // 「担当＋前後」の受け渡し先
  displayMode: DisplayMode;
  collapsed: Set<string>; // 実効折り畳みプレフィックス
  criticalTasks: Set<string> | null;
}

export interface VisibilityFlags {
  dim: boolean;
  outside: boolean;
}

export function resolveVisibility(
  tasks: Task[],
  deps: Dependency[],
  viewSpec: Partial<ViewSpec> | null | undefined,
): Visibility {
  const spec = viewSpec ?? {};
  const filter = spec.filter ?? {};
  const displayMode = spec.displayMode ?? 'DIM';
  const criticalTasks = spec.criticalTasks ?? null;
  const boundaryUp = spec.boundaryUp ?? 0;
  const boundaryDown = spec.boundaryDown ?? 0;

  const taskById = new Map<string, Task>();
  for (const t of tasks) taskById.set(t.id, t);
  const { succ, pred } = buildAdjacency(deps);

  const active = isFilterActive(filter);
  const matchSet = new Set<string>();
  if (active) {
    const me = spec.me ?? '';
    for (const t of tasks) if (matchesFilter(t, filter, me, criticalTasks)) matchSet.add(t.id);
  }

  const focus = spec.focus && spec.focus.taskId && taskById.has(spec.focus.taskId) ? spec.focus : null;
  const nb = focus ? neighborhood(focus.taskId, succ, pred, focus.up ?? 2, focus.down ?? 2) : null;
  const isoRemove = active && displayMode === 'ISOLATE' && !nb;
  const boundarySet =
    active && !nb && (boundaryUp > 0 || boundaryDown > 0)
      ? expandBoundary(matchSet, succ, pred, boundaryUp, boundaryDown)
      : null;

  return {
    taskById,
    succ,
    pred,
    active,
    matchSet,
    focus,
    nb,
    isoRemove,
    boundarySet,
    displayMode,
    collapsed: effectiveCollapsed(spec.collapsedWbs ?? [], isoRemove, nb, taskById),
    criticalTasks,
  };
}

// ISOLATE は全展開。フォーカス中は近傍タスクを含む枝だけ自動展開（近傍を実タスクとして見せる、§2.9）。
function effectiveCollapsed(
  collapsedWbs: string[],
  isoRemove: boolean,
  nb: Neighborhood | null,
  taskById: Map<string, Task>,
): Set<string> {
  if (isoRemove) return new Set();
  let opened: Set<string> | null = null;
  if (nb) {
    opened = new Set();
    for (const id of nb.set) {
      const t = taskById.get(id);
      if (t) for (const p of wbsPrefixesOf(t.wbsCode)) opened.add(p);
    }
  }
  const out = new Set<string>();
  for (const p of collapsedWbs) if (p && !opened?.has(p)) out.add(p);
  return out;
}

// 近傍の内外で判定する（グラフの「関係ハイライト」は呼び出し側で別扱い）。null＝描画対象外。
export function classify(v: Visibility, id: string): VisibilityFlags | null {
  if (v.nb) return v.nb.set.has(id) ? { dim: false, outside: v.active && !v.matchSet.has(id) } : null;
  const isMatch = !v.active || v.matchSet.has(id);
  const isBoundary = !!v.boundarySet && v.boundarySet.has(id);
  if (v.isoRemove) return isMatch || isBoundary ? { dim: false, outside: !isMatch } : null;
  return {
    dim: v.active && v.displayMode === 'DIM' && !isMatch && !isBoundary,
    outside: v.active && !isMatch && isBoundary,
  };
}

// 最上位の折り畳み祖先（なければ null）。wbsPrefixesOf は短い順なので最初の一致が最上位。
export function collapsedRoot(code: string, collapsed: Set<string>): string | null {
  if (!collapsed.size) return null;
  for (const p of wbsPrefixesOf(code)) if (collapsed.has(p)) return p;
  return null;
}
