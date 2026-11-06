// ============================================================================
// WBS 階層ヘルパー（§2.7）。wbsCode（例 "1.2.3"）のプレフィックスが木を定義する。
// ============================================================================
import type { Task } from './types';

export function isWbsPrefix(prefix: string, code: string): boolean {
  if (!prefix) return false;
  return code === prefix || code.startsWith(prefix + '.');
}

// isWbsPrefix(p, code) が true になる全 p を短い順に返す（生文字列のまま・正規化しない）。
export function wbsPrefixesOf(code: string): string[] {
  const out: string[] = [];
  if (!code) return out;
  for (let i = code.indexOf('.'); i !== -1; i = code.indexOf('.', i + 1)) if (i > 0) out.push(code.slice(0, i));
  out.push(code);
  return out;
}

// 展開レベル level を超える深さのタスクを、level 段でまとめる折り畳み集合を返す。
export function collapsedForLevel(tasks: Task[], level: number): string[] {
  const set = new Set<string>();
  for (const t of tasks) {
    const segs = (t.wbsCode || '').split('.').filter(Boolean);
    if (segs.length > level) set.add(segs.slice(0, level).join('.'));
  }
  return [...set];
}

// 全トッププレフィックス（"全折り畳み" 用）。
export function allTopPrefixes(tasks: Task[]): string[] {
  const set = new Set<string>();
  for (const t of tasks) {
    const segs = (t.wbsCode || '').split('.').filter(Boolean);
    if (segs.length >= 1) set.add(segs[0]);
  }
  return [...set];
}

// パンくず用の累積プレフィックス列（"1", "1.2", "1.2.3"）。
export function wbsPath(code: string): string[] {
  const segs = (code || '').split('.').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) out.push(segs.slice(0, i + 1).join('.'));
  return out;
}

// WBSコードの自然順比較（§12.3.1 段5）。セグメントごとに数値比較（"1.10" は "1.9" の後）。
// 数値化できないセグメントは文字列比較にフォールバック。長さが短い方（＝上位/直属）が先。
export function naturalWbsCompare(a: string, b: string): number {
  const sa = (a || '').split('.').filter(Boolean);
  const sb = (b || '').split('.').filter(Boolean);
  const n = Math.min(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    const na = Number(sa[i]);
    const nb = Number(sb[i]);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else {
      const c = sa[i].localeCompare(sb[i]);
      if (c !== 0) return c;
    }
  }
  return sa.length - sb.length;
}

// ---- WBSツリー構築（§12.3.1 段3）。UI非依存。deriveTableRows から利用する ----
// wbsCode のプレフィックス（"1" → "1.2" → "1.2.3"）ごとに中間 WBS ノードを作り、
// タスクは自身の wbsCode 完全一致ノードの直属子として付く。wbsCode 未設定はルート直下。
// 既存の isWbsPrefix / collapsedForLevel 等は不変（この関数は追加のみ）。
export interface WbsTreeNode<T> {
  prefix: string; // "" はルート
  wbsChildren: WbsTreeNode<T>[];
  taskChildren: T[];
}

export function buildWbsTree<T>(items: T[], codeOf: (item: T) => string): WbsTreeNode<T> {
  const root: WbsTreeNode<T> = { prefix: '', wbsChildren: [], taskChildren: [] };
  const byPrefix = new Map<string, WbsTreeNode<T>>();
  byPrefix.set('', root);

  const ensure = (prefix: string, parent: WbsTreeNode<T>): WbsTreeNode<T> => {
    let node = byPrefix.get(prefix);
    if (!node) {
      node = { prefix, wbsChildren: [], taskChildren: [] };
      byPrefix.set(prefix, node);
      parent.wbsChildren.push(node);
    }
    return node;
  };

  for (const item of items) {
    const code = codeOf(item) || '';
    const segs = code.split('.').filter(Boolean);
    if (segs.length === 0) {
      root.taskChildren.push(item);
      continue;
    }
    let parent = root;
    let acc = '';
    for (let i = 0; i < segs.length; i++) {
      acc = i === 0 ? segs[0] : acc + '.' + segs[i];
      parent = ensure(acc, parent);
    }
    parent.taskChildren.push(item);
  }
  return root;
}
