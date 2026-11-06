// ============================================================================
// 表示パイプライン（§2.6）: フィルタ判定 → WBS折り畳み → 近傍フォーカス を1本に統合。
// 「4,000を一度に描かない」性能戦略そのもの。全段 O(V+E)。UI/React Flow 非依存の純関数。
// ============================================================================
import type {
  DeriveResult,
  Dependency,
  DisciplineBreakdown,
  Task,
  VisibleEdge,
  VisibleNode,
  ViewSpec,
} from './types';
import { classify, collapsedRoot, resolveVisibility } from './visibility';

interface Candidate {
  task: Task;
  dim: boolean;
  outside: boolean;
  isOrigin?: boolean;
  directPred?: boolean;
  directSucc?: boolean;
  related?: boolean;
  gen?: number;
}

export function deriveVisibleGraph(
  tasks: Task[],
  deps: Dependency[],
  viewSpec: Partial<ViewSpec> | null | undefined,
): DeriveResult {
  const v = resolveVisibility(tasks, deps, viewSpec);
  const { taskById, succ, pred, active, matchSet, nb, criticalTasks } = v;
  const focus = v.focus;
  const criticalEdges = viewSpec?.criticalEdges ?? null;
  // CP強調は「トグル ON」かつ「criticalTasks が渡っている」時のみ視覚フラグを立てる。
  const cpHighlight = !!viewSpec?.cpHighlight && !!criticalTasks;
  // 'highlight'=近傍を強調しつつ全体を残す（非近傍は淡色）。'isolate'（既定）=近傍だけ抽出。
  const nbHighlight = !!nb && focus!.mode === 'highlight';

  const cands: Candidate[] = [];
  for (const t of tasks) {
    if (nb) {
      const inNb = nb.set.has(t.id);
      if (!inNb && !nbHighlight) continue;
      cands.push({
        task: t,
        dim: !inNb,
        outside: !nbHighlight && active && !matchSet.has(t.id),
        isOrigin: t.id === focus!.taskId,
        directPred: nb.directPred.has(t.id),
        directSucc: nb.directSucc.has(t.id),
        related: inNb,
        gen: inNb ? nb.gen.get(t.id) : undefined,
      });
    } else {
      const flags = classify(v, t.id);
      if (flags) cands.push({ task: t, ...flags });
    }
  }

  // 代表ノード: 折り畳まれた最上位祖先の集約ID、なければ自身。候補ごとに1回だけ解決する。
  const repById = new Map<string, string>();
  for (const c of cands) {
    const root = collapsedRoot(c.task.wbsCode, v.collapsed);
    repById.set(c.task.id, root == null ? c.task.id : 'wbs::' + root);
  }

  const nodeMap = new Map<string, VisibleNode>();
  const aggMembers = new Map<string, Candidate[]>();
  for (const c of cands) {
    const rep = repById.get(c.task.id)!;
    if (rep.startsWith('wbs::')) {
      if (!aggMembers.has(rep)) aggMembers.set(rep, []);
      aggMembers.get(rep)!.push(c);
    } else {
      nodeMap.set(rep, {
        kind: 'task',
        id: c.task.id,
        task: c.task,
        position: c.task.position,
        dim: c.dim,
        outside: c.outside,
        isOrigin: !!c.isOrigin,
        directPred: !!c.directPred,
        directSucc: !!c.directSucc,
        critical: cpHighlight && criticalTasks!.has(c.task.id),
        related: c.related,
        gen: c.gen,
      });
    }
  }
  for (const [aggId, members] of aggMembers) {
    const prefix = aggId.slice(5);
    let sx = 0,
      sy = 0,
      sp = 0,
      hasMs = false,
      hasCrit = false;
    const disc: DisciplineBreakdown = { E: 0, P: 0, C: 0, OTHER: 0 };
    for (const m of members) {
      sx += m.task.position.x;
      sy += m.task.position.y;
      sp += m.task.progress;
      disc[m.task.discipline] = (disc[m.task.discipline] || 0) + 1;
      if (m.task.isMilestone) hasMs = true;
      if (criticalTasks && criticalTasks.has(m.task.id)) hasCrit = true;
    }
    const n = members.length;
    nodeMap.set(aggId, {
      kind: 'aggregate',
      id: aggId,
      prefix,
      memberIds: members.map((m) => m.task.id),
      position: { x: sx / n, y: sy / n },
      count: n,
      disc,
      avgProgress: Math.round(sp / n),
      hasMilestone: hasMs,
      hasCritical: hasCrit,
      dim: members.every((m) => m.dim),
    });
  }

  const edgeMap = new Map<string, VisibleEdge>();
  for (const d of deps) {
    const a = repById.get(d.predecessorId);
    const b = repById.get(d.successorId);
    if (a === undefined || b === undefined || a === b) continue;
    if (!nodeMap.has(a) || !nodeMap.has(b)) continue;
    const key = a + '->' + b;
    const isAgg = a.startsWith('wbs::') || b.startsWith('wbs::');
    let e = edgeMap.get(key);
    if (!e) {
      e = { id: 'e::' + key, source: a, target: b, aggregate: isAgg, count: 0, highlight: false, critical: false, realId: d.id };
      edgeMap.set(key, e);
    }
    e.count++;
    if (nb && (d.predecessorId === focus!.taskId || d.successorId === focus!.taskId)) e.highlight = true;
    if (cpHighlight && criticalEdges && criticalEdges.has(d.id)) e.critical = true;
  }

  // フォーカスの continuation 集約（§2.9「折り畳み先への継続がバッジで見える」）。
  // highlight では非近傍も実ノードとして描かれるため不要（重複・偽の循環になる）。
  if (nb && !nbHighlight) {
    const level2 = (code: string): string => {
      const seg = (code || '').split('.').filter(Boolean);
      return seg.length >= 2 ? seg.slice(0, 2).join('.') : code || '（ルート）';
    };
    interface ContGroup {
      prefix: string;
      tasks: Set<string>;
      out: Set<string>;
      in: Set<string>;
      sx: number;
      sy: number;
    }
    const groups = new Map<string, ContGroup>();
    for (const c of cands) {
      const id = c.task.id;
      const repA = repById.get(id)!;
      if (!nodeMap.has(repA)) continue;
      const addCont = (otherId: string, isSucc: boolean) => {
        if (nb!.set.has(otherId)) return;
        const ot = taskById.get(otherId);
        if (!ot) return;
        // 上流/下流を別ノードにする（同じ WBS に集約すると偽の循環が描かれる）。
        const key = 'cont::' + (isSucc ? 'down' : 'up') + '::' + level2(ot.wbsCode);
        if (!groups.has(key))
          groups.set(key, { prefix: level2(ot.wbsCode), tasks: new Set(), out: new Set(), in: new Set(), sx: 0, sy: 0 });
        const g = groups.get(key)!;
        if (!g.tasks.has(otherId)) {
          g.tasks.add(otherId);
          g.sx += ot.position.x;
          g.sy += ot.position.y;
        }
        if (isSucc) g.out.add(repA);
        else g.in.add(repA);
      };
      for (const s of succ.get(id) || []) addCont(s, true);
      for (const p of pred.get(id) || []) addCont(p, false);
    }
    for (const [key, g] of groups) {
      const n = g.tasks.size;
      nodeMap.set(key, {
        kind: 'aggregate',
        id: key,
        prefix: g.prefix,
        continuation: true,
        memberIds: [...g.tasks],
        position: { x: g.sx / n, y: g.sy / n },
        count: n,
        disc: { E: 0, P: 0, C: 0, OTHER: 0 },
        avgProgress: 0,
        hasMilestone: false,
        hasCritical: false,
        dim: false,
      });
      for (const rep of g.out)
        edgeMap.set(rep + '->' + key, {
          id: 'e::' + rep + '->' + key,
          source: rep,
          target: key,
          aggregate: true,
          continuation: true,
          count: n,
          highlight: false,
          critical: false,
        });
      for (const rep of g.in)
        edgeMap.set(key + '->' + rep, {
          id: 'e::' + key + '->' + rep,
          source: key,
          target: rep,
          aggregate: true,
          continuation: true,
          count: n,
          highlight: false,
          critical: false,
        });
    }
  }

  const visibleNodes = [...nodeMap.values()];
  const visibleEdges = [...edgeMap.values()];
  return {
    visibleNodes,
    visibleEdges,
    stats: {
      total: tasks.length,
      visible: visibleNodes.length,
      aggregates: aggMembers.size,
      matched: active ? matchSet.size : tasks.length,
      edges: visibleEdges.length,
    },
  };
}
