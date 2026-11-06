// ============================================================================
// グラフ演算（§2.4 循環防止 / §2.9 近傍 / §5.2 DAG検証）。UI非依存の純関数。
// 隣接リストは O(V+E)。4,000ノード・6,000エッジで頭打ちしない（§2.4 計算量）。
// ============================================================================
import type {
  Adjacency,
  ConnectResult,
  Dependency,
  Neighborhood,
  Task,
  TopoResult,
} from './types';

// 依存配列から隣接リスト（succ=後続方向 / pred=先行方向）を1パス O(E) で構築。
// 以降のグラフ演算（循環検出・トポソート・近傍）は全てこの2マップを引き回して O(1) 参照する。
export function buildAdjacency(deps: Dependency[]): Adjacency {
  const succ = new Map<string, Set<string>>(); // predecessorId → { successorId, ... }
  const pred = new Map<string, Set<string>>(); // successorId  → { predecessorId, ... }
  for (const d of deps) {
    // 初出のノードは空 Set で用意してから辺を足す（Set なので同一辺は自然に重複排除）。
    if (!succ.has(d.predecessorId)) succ.set(d.predecessorId, new Set());
    if (!pred.has(d.successorId)) pred.set(d.successorId, new Set());
    succ.get(d.predecessorId)!.add(d.successorId);
    pred.get(d.successorId)!.add(d.predecessorId);
  }
  return { succ, pred };
}

// source の祖先集合（BFS）。ドラッグ開始時に1回計算し、判定は O(1)（§2.4）。
export function ancestorsOf(sourceId: string, pred: Map<string, Set<string>>): Set<string> {
  const anc = new Set<string>();
  const q: string[] = [sourceId]; // スタック（pop）で pred 方向へ深さ優先に遡る
  while (q.length) {
    const cur = q.pop()!;
    const ps = pred.get(cur);
    if (!ps) continue;
    for (const p of ps)
      // 未訪問の先行だけを積む＝visited を兼ねる anc により各ノード1回で O(V+E)。
      if (!anc.has(p)) {
        anc.add(p);
        q.push(p);
      }
  }
  return anc;
}

// 循環になる接続の「なぜダメか」を教える経路 A → … → B を求める（§2.4）。
export function findCyclePath(
  sourceId: string,
  targetId: string,
  succ: Map<string, Set<string>>,
): string[] | null {
  // target から succ 方向へ BFS し、辿った親を prevOf に記録（最短経路の復元用）。
  // source に到達したら「source が target の後続でもある」＝この接続は循環、が確定する。
  const prevOf = new Map<string, string>(); // 子 → 親（BFS木）
  const q: string[] = [targetId];
  const seen = new Set<string>([targetId]);
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi]; // FIFO＝最短ホップ順に展開（shift() の O(n) を避け読み出し位置を進める）
    if (cur === sourceId) {
      // prevOf を source→…→target と逆に辿り直して経路を復元（表示用）。
      const path: string[] = [];
      let c: string | undefined = sourceId;
      while (c !== undefined) {
        path.push(c);
        c = prevOf.get(c);
      }
      return path.reverse(); // target → … → source の順に整える
    }
    const ss = succ.get(cur);
    if (!ss) continue;
    for (const s of ss)
      if (!seen.has(s)) {
        seen.add(s);
        prevOf.set(s, cur);
        q.push(s);
      }
  }
  return null; // source へ到達せず＝循環なし
}

// 接続可否（自己ループ・重複・循環を拒否）。§2.4 の UI 予防と同一ロジック。
export function canConnect(
  sourceId: string,
  targetId: string,
  deps: Dependency[],
): ConnectResult {
  // ① 自己ループ拒否。
  if (sourceId === targetId) return { ok: false, reason: 'self', path: null };
  // ② 既存の同一辺（重複）拒否。
  for (const d of deps) {
    if (d.predecessorId === sourceId && d.successorId === targetId)
      return { ok: false, reason: 'duplicate', path: null };
  }
  // ③ 循環拒否: target が source の祖先なら、source→target を足すと閉路になる。
  //    経路 path を添えて「なぜダメか」を UI に返す。
  const { succ, pred } = buildAdjacency(deps);
  const anc = ancestorsOf(sourceId, pred);
  if (anc.has(targetId))
    return { ok: false, reason: 'cycle', path: findCyclePath(sourceId, targetId, succ) };
  return { ok: true, reason: null, path: null };
}

// Kahn のトポロジカルソート。order.length !== tasks.length なら循環あり（§5.2 検証⑤）。
export function topoSort(tasks: Task[], deps: Dependency[]): TopoResult {
  // 各ノードの入次数（先行数）を数える。
  const indeg = new Map<string, number>();
  for (const t of tasks) indeg.set(t.id, 0);
  const { succ } = buildAdjacency(deps);
  for (const d of deps)
    if (indeg.has(d.successorId)) indeg.set(d.successorId, indeg.get(d.successorId)! + 1);
  // 入次数0（先行なし）を初期キューへ。
  const q: string[] = [];
  for (const [id, dg] of indeg) if (dg === 0) q.push(id);
  const order: string[] = [];
  // キューから取り出す度に後続の入次数を1減らし、0になったら順序が確定＝キューへ。
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    order.push(cur);
    const ss = succ.get(cur);
    if (!ss) continue;
    for (const s of ss) {
      indeg.set(s, indeg.get(s)! - 1);
      if (indeg.get(s) === 0) q.push(s);
    }
  }
  // 全ノードを並べ切れない＝入次数が0にならない環が残った＝循環あり（§5.2 検証⑤）。
  const ok = order.length === tasks.length;
  return { ok, order, hasCycle: !ok };
}

// 近傍抽出（§2.9）: 起点から上流 up 階層・下流 down 階層を BFS。直接の先行/後続も返す。
export function neighborhood(
  originId: string,
  succ: Map<string, Set<string>>,
  pred: Map<string, Set<string>>,
  up: number,
  down: number,
): Neighborhood {
  const set = new Set<string>([originId]); // 近傍に含む全ノード（起点を含む）
  const directPred = new Set<string>(); // 起点の直接先行（1つ上）
  const directSucc = new Set<string>(); // 起点の直接後続（1つ下）
  const gen = new Map<string, number>([[originId, 0]]); // 起点からの世代（0=起点）
  // 上流探索: 起点から pred 方向へ up 階層ぶん BFS（frontier=各階層の集合）。
  let frontier: string[] = [originId];
  for (let lvl = 0; lvl < up; lvl++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const ps = pred.get(cur);
      if (!ps) continue;
      for (const p of ps) {
        if (lvl === 0) directPred.add(p); // 最初の階層＝直接先行
        if (!set.has(p)) {
          set.add(p);
          gen.set(p, -(lvl + 1)); // 上流は負の世代（-1, -2, …）
          next.push(p);
        }
      }
    }
    frontier = next; // 次の階層へ
  }
  // 下流探索: 同様に succ 方向へ down 階層ぶん BFS（frontier を起点にリセット）。
  frontier = [originId];
  for (let lvl = 0; lvl < down; lvl++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const ss = succ.get(cur);
      if (!ss) continue;
      for (const s of ss) {
        if (lvl === 0) directSucc.add(s);
        if (!set.has(s)) {
          set.add(s);
          gen.set(s, lvl + 1); // 下流は正の世代
          next.push(s);
        }
      }
    }
    frontier = next;
  }
  return { set, directPred, directSucc, gen };
}

// 多起点の世代展開（§2.9 拡張・「担当＋前後」ビュー用）: origins 集合（例=自分の担当タスク）から
// 上流 up 世代・下流 down 世代ぶん、pred/succ 方向へ多起点 BFS で広げる。origins 自身は境界に含まない
// （呼び出し側が「一致＝主役／展開＝受け渡しの文脈」を区別できるよう boundary だけ返す）。
// 返り値 boundary: origins から到達したが origins 自身ではないタスク集合＝「前後の受け渡し先」。
export function expandBoundary(
  origins: Iterable<string>,
  succ: Map<string, Set<string>>,
  pred: Map<string, Set<string>>,
  up: number,
  down: number,
): Set<string> {
  const originSet = new Set(origins);
  const visited = new Set(originSet); // 二重訪問防止（origins は展開しない）
  const boundary = new Set<string>();
  const walk = (adj: Map<string, Set<string>>, depth: number) => {
    let frontier: string[] = [...originSet];
    for (let lvl = 0; lvl < depth; lvl++) {
      const next: string[] = [];
      for (const cur of frontier) {
        const ns = adj.get(cur);
        if (!ns) continue;
        for (const n of ns) {
          if (visited.has(n)) continue;
          visited.add(n);
          if (!originSet.has(n)) boundary.add(n); // origins 以外＝受け渡し先
          next.push(n);
        }
      }
      frontier = next;
    }
  };
  walk(pred, up); // 上流（前工程）へ
  // 下流探索は visited を origins だけに戻してから（上流で拾った枝を下流でも独立に辿れるように）。
  visited.clear();
  for (const o of originSet) visited.add(o);
  walk(succ, down); // 下流（後工程）へ
  return boundary;
}
