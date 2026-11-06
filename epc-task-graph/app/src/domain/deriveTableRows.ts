// ============================================================================
// テーブル行導出（§12.3.1）: deriveVisibleGraph と「対」になる UI非依存の純関数。
// 6段パイプライン: フィルタ → 近傍focus → WBSツリー化 → 折り畳み →
//   兄弟集合内ソート（木を壊さない） → DFS平坦化。
// 共有する下位純関数: matchesFilter / neighborhood / wbs.ts ヘルパー / cpmByTask。
// グラフの deriveVisibleGraph には依存しない（出力の形が違う）。全段 O(V log V)（ソート支配）。
// ============================================================================
import type {
  Dependency,
  Task,
  TableResult,
  TableRow,
  TableSort,
  TableSortKey,
  ViewSpec,
} from './types';
import type { CpmTaskResult } from './cpm';
import { classify, resolveVisibility } from './visibility';
import { buildWbsTree, naturalWbsCompare, type WbsTreeNode } from './wbs';

// 候補タスク（段1-2の結果）: 描画対象に残るタスク＋その表示フラグ。
interface Cand {
  task: Task;
  dim: boolean;
  outside: boolean;
}

// WBSノードごとの集計（集約行の表示＋WBS行ソートに使用。§2.7 と同じ意味論）。
interface Agg {
  count: number; // フィルタ後の子孫タスク件数
  sumProgress: number;
  hasCritical: boolean;
  hasMilestone: boolean;
  minEs: number | null; // 最早ES（日オフセット・WBS行ソート＋日付表示に使用）
  maxEf: number | null; // 最遅EF（日オフセット・WBS行ソート＋日付表示に使用）
  esMinDate: string | null; // minEs に対応する暦日（WBS行の「min ES」表示・§12.3.2）
  efMaxDate: string | null; // maxEf に対応する暦日（WBS行の「max EF」表示）
  minLs: number | null;
  minLf: number | null;
  minTf: number | null;
}

const cpmVal = (
  cpm: Map<string, CpmTaskResult> | null | undefined,
  id: string,
  key: 'es' | 'ef' | 'ls' | 'lf' | 'totalFloat',
): number | null => {
  const r = cpm && cpm.get(id);
  return r ? r[key] : null;
};

const cpmDateStr = (
  cpm: Map<string, CpmTaskResult> | null | undefined,
  id: string,
  key: 'esDate' | 'efDate',
): string | null => {
  const r = cpm && cpm.get(id);
  return r ? r[key] : null;
};

const minN = (a: number | null, b: number | null): number | null => {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
};

export function deriveTableRows(
  tasks: Task[],
  deps: Dependency[],
  viewSpec: Partial<ViewSpec> | null | undefined,
  sort: TableSort[] | null | undefined,
  cpmByTask: Map<string, CpmTaskResult> | null | undefined,
): TableResult {
  const sortSpec = sort && sort.length ? sort : [];

  // ---- 段1-2: フィルタ判定・近傍フォーカス・実効折り畳み（グラフと共通の規則・visibility.ts）----
  // テーブルは関係ハイライトでも近傍だけを行にする（全行を残すと淡色行が埋もれるため）。
  const v = resolveVisibility(tasks, deps, viewSpec);
  const { succ, pred, active, matchSet, criticalTasks } = v;
  const collapsedSet = v.collapsed;

  const cands: Cand[] = [];
  for (const t of tasks) {
    const flags = classify(v, t.id);
    if (flags) cands.push({ task: t, ...flags });
  }

  // ---- 段3: WBSツリー化（buildWbsTree・wbs.ts）----
  const tree = buildWbsTree(cands, (c) => c.task.wbsCode);

  // ---- WBSノード集計を後順で1回計算（集約行表示＋WBS行ソート用）----
  const aggByNode = new Map<WbsTreeNode<Cand>, Agg>();
  const computeAgg = (node: WbsTreeNode<Cand>): Agg => {
    const agg: Agg = {
      count: 0,
      sumProgress: 0,
      hasCritical: false,
      hasMilestone: false,
      minEs: null,
      maxEf: null,
      esMinDate: null,
      efMaxDate: null,
      minLs: null,
      minLf: null,
      minTf: null,
    };
    // 最早ES/最遅EF を暦日つきで畳み込む（オフセットで比較・一致した端点の日付文字列を保持）。
    const considerEs = (off: number | null, date: string | null): void => {
      if (off == null) return;
      if (agg.minEs == null || off < agg.minEs) {
        agg.minEs = off;
        agg.esMinDate = date;
      }
    };
    const considerEf = (off: number | null, date: string | null): void => {
      if (off == null) return;
      if (agg.maxEf == null || off > agg.maxEf) {
        agg.maxEf = off;
        agg.efMaxDate = date;
      }
    };
    for (const c of node.taskChildren) {
      const t = c.task;
      agg.count += 1;
      agg.sumProgress += t.progress;
      if (criticalTasks && criticalTasks.has(t.id)) agg.hasCritical = true;
      if (t.isMilestone) agg.hasMilestone = true;
      considerEs(cpmVal(cpmByTask, t.id, 'es'), cpmDateStr(cpmByTask, t.id, 'esDate'));
      considerEf(cpmVal(cpmByTask, t.id, 'ef'), cpmDateStr(cpmByTask, t.id, 'efDate'));
      agg.minLs = minN(agg.minLs, cpmVal(cpmByTask, t.id, 'ls'));
      agg.minLf = minN(agg.minLf, cpmVal(cpmByTask, t.id, 'lf'));
      agg.minTf = minN(agg.minTf, cpmVal(cpmByTask, t.id, 'totalFloat'));
    }
    for (const child of node.wbsChildren) {
      const ca = computeAgg(child);
      agg.count += ca.count;
      agg.sumProgress += ca.sumProgress;
      agg.hasCritical = agg.hasCritical || ca.hasCritical;
      agg.hasMilestone = agg.hasMilestone || ca.hasMilestone;
      considerEs(ca.minEs, ca.esMinDate);
      considerEf(ca.maxEf, ca.efMaxDate);
      agg.minLs = minN(agg.minLs, ca.minLs);
      agg.minLf = minN(agg.minLf, ca.minLf);
      agg.minTf = minN(agg.minTf, ca.minTf);
    }
    aggByNode.set(node, agg);
    return agg;
  };
  computeAgg(tree);

  // ---- 段5: 兄弟集合内ソート（木は保持）。default は wbsCode 自然順 ----
  type Entry =
    | { kind: 'wbs'; node: WbsTreeNode<Cand>; code: string }
    | { kind: 'task'; cand: Cand; code: string };

  const sortValue = (e: Entry, key: TableSortKey): { v: number | string; missing: boolean } => {
    if (e.kind === 'task') {
      const t = e.cand.task;
      switch (key) {
        case 'wbsCode':
        case 'wbsPath':
          return { v: t.wbsCode, missing: false };
        case 'name':
          return { v: t.name || '', missing: false };
        case 'discipline':
          return { v: t.discipline, missing: false };
        case 'assignee':
          return { v: t.assignee || '', missing: false };
        case 'status':
          return { v: t.status, missing: false };
        case 'progress':
          return { v: t.progress, missing: false };
        case 'durationDays':
          return { v: t.isMilestone ? 0 : t.durationDays, missing: false };
        case 'es':
        case 'ef':
        case 'ls':
        case 'lf':
        case 'totalFloat': {
          const val = cpmVal(cpmByTask, t.id, key);
          return { v: val ?? 0, missing: val == null };
        }
        case 'critical':
          return { v: criticalTasks && criticalTasks.has(t.id) ? 1 : 0, missing: false };
        default:
          return { v: '', missing: false };
      }
    }
    // WBS行: 集計値をソート値に（属性を持たない列は prefix/0 にフォールバック）。
    const agg = aggByNode.get(e.node)!;
    switch (key) {
      case 'wbsCode':
      case 'wbsPath':
      case 'name':
      case 'discipline':
      case 'assignee':
      case 'status':
        return { v: e.node.prefix, missing: false };
      case 'progress':
        return { v: agg.count ? agg.sumProgress / agg.count : 0, missing: false };
      case 'durationDays':
        return { v: 0, missing: false };
      case 'es':
        return { v: agg.minEs ?? 0, missing: agg.minEs == null };
      case 'ef':
        return { v: agg.maxEf ?? 0, missing: agg.maxEf == null };
      case 'ls':
        return { v: agg.minLs ?? 0, missing: agg.minLs == null };
      case 'lf':
        return { v: agg.minLf ?? 0, missing: agg.minLf == null };
      case 'totalFloat':
        return { v: agg.minTf ?? 0, missing: agg.minTf == null };
      case 'critical':
        return { v: agg.hasCritical ? 1 : 0, missing: false };
      default:
        return { v: e.node.prefix, missing: false };
    }
  };

  const compareEntries = (a: Entry, b: Entry): number => {
    for (const s of sortSpec) {
      const va = sortValue(a, s.key);
      const vb = sortValue(b, s.key);
      // 未計算（null）は方向に関わらず末尾（§12.3.1 段5「null時は末尾」）。
      if (va.missing || vb.missing) {
        if (va.missing && vb.missing) continue;
        return va.missing ? 1 : -1;
      }
      let c: number;
      if (s.key === 'wbsCode' || s.key === 'wbsPath') {
        c = naturalWbsCompare(String(va.v), String(vb.v));
      } else if (typeof va.v === 'number' && typeof vb.v === 'number') {
        c = va.v - vb.v;
      } else {
        c = String(va.v).localeCompare(String(vb.v));
      }
      if (c !== 0) return s.dir === 'desc' ? -c : c;
    }
    // 既定/最終タイブレーク: wbsCode 自然順 → name → id で決定的に。
    const nat = naturalWbsCompare(a.code, b.code);
    if (nat !== 0) return nat;
    const an = a.kind === 'task' ? a.cand.task.name : a.node.prefix;
    const bn = b.kind === 'task' ? b.cand.task.name : b.node.prefix;
    const nc = an.localeCompare(bn);
    if (nc !== 0) return nc;
    const ai = a.kind === 'task' ? a.cand.task.id : a.node.prefix;
    const bi = b.kind === 'task' ? b.cand.task.id : b.node.prefix;
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  };

  // ---- 段4＋段6: 折り畳みを反映しつつ DFS で平坦化 ----
  const rows: TableRow[] = [];
  let taskRows = 0;
  let wbsRows = 0;

  const emit = (node: WbsTreeNode<Cand>, depth: number): void => {
    const entries: Entry[] = [];
    for (const child of node.wbsChildren) entries.push({ kind: 'wbs', node: child, code: child.prefix });
    for (const c of node.taskChildren) entries.push({ kind: 'task', cand: c, code: c.task.wbsCode });
    entries.sort(compareEntries);

    for (const e of entries) {
      if (e.kind === 'wbs') {
        const agg = aggByNode.get(e.node)!;
        // 段4: 空枝（フィルタ後に子孫タスクゼロ）は除去。ISOLATE/DIM 双方で無意味な行を出さない。
        if (agg.count === 0) continue;
        const collapsed = collapsedSet.has(e.node.prefix);
        rows.push({
          kind: 'wbs',
          id: 'wbs::' + e.node.prefix,
          depth,
          wbsPrefix: e.node.prefix,
          collapsed,
          memberCount: agg.count,
          hasCritical: agg.hasCritical,
          hasMilestone: agg.hasMilestone,
          avgProgress: agg.count ? Math.round(agg.sumProgress / agg.count) : 0,
          esMin: agg.esMinDate,
          efMax: agg.efMaxDate,
        });
        wbsRows += 1;
        if (!collapsed) emit(e.node, depth + 1);
      } else {
        const c = e.cand;
        rows.push({
          kind: 'task',
          id: c.task.id,
          depth,
          task: c.task,
          dim: c.dim,
          outside: c.outside,
          predCount: pred.get(c.task.id)?.size || 0,
          succCount: succ.get(c.task.id)?.size || 0,
        });
        taskRows += 1;
      }
    }
  };
  emit(tree, 0);

  return {
    rows,
    stats: {
      total: tasks.length,
      rows: rows.length,
      taskRows,
      wbsRows,
      matched: active ? matchSet.size : tasks.length,
    },
  };
}
