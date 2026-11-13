// 左→右 DAG の dagre レイアウト本体（§2.5）。DOM 非依存＝メインスレッドと Worker で共用。
import * as dagreNS from '@dagrejs/dagre';
import type { VisibleNode, VisibleEdge } from '../domain';

const dagre: typeof import('@dagrejs/dagre') = (dagreNS as any).default || dagreNS;

const NODE_W = 186;
const NODE_H = 64;

export type PosMap = Record<string, { x: number; y: number }>;

export function layoutPositions(nodeIds: Iterable<string>, edges: Iterable<readonly [string, string]>): PosMap {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', ranksep: 80, nodesep: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of nodeIds) g.setNode(id, { width: NODE_W, height: NODE_H });
  for (const [a, b] of edges) if (g.hasNode(a) && g.hasNode(b)) g.setEdge(a, b);
  dagre.layout(g);
  const pos: PosMap = {};
  for (const id of g.nodes()) {
    const nn = g.node(id);
    pos[id] = { x: nn.x - NODE_W / 2, y: nn.y - NODE_H / 2 };
  }
  return pos;
}

// 表示中サブグラフ（数百）をメインスレッド同期で整列。
export function dagreLayout(nodes: VisibleNode[], edges: VisibleEdge[]): PosMap {
  return layoutPositions(
    nodes.map((n) => n.id),
    edges.map((e) => [e.source, e.target] as const),
  );
}
