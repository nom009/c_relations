// ============================================================================
// adapters（§4.2 隔離点・§3.1 撤退可能性の担保）:
// domain の visibleNodes/visibleEdges を React Flow v12 の nodes/edges へ変換する。
// React Flow への依存はこの層とコンポーネントに閉じ込め、domain/store は非依存を保つ。
// ============================================================================
import type { Edge, Node } from '@xyflow/react';
import { DISC_COLOR, type VisibleEdge, type VisibleNode } from '../domain';

export type RFNodeData = { n: VisibleNode };

export function toRFNodes(vnodes: VisibleNode[]): Node<RFNodeData>[] {
  return vnodes.map((n) => ({
    id: n.id,
    type: n.kind === 'aggregate' ? 'aggregate' : n.task.isMilestone ? 'milestone' : 'task',
    position: n.position,
    data: { n },
    deletable: n.kind !== 'aggregate',
    draggable: true,
  }));
}

// energized: 直前に「つなぐ」で接続したエッジの realId 集合。回路エフェクト（circuit エッジ）で描く。
export function toRFEdges(vedges: VisibleEdge[], energized?: Set<string> | null): Edge[] {
  return vedges.map((e) => {
    const hot = !!energized && (energized.has(e.realId ?? '') || energized.has(e.id));
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: hot ? 'circuit' : 'smoothstep',
      deletable: !e.aggregate,
      data: { realId: e.realId, aggregate: e.aggregate },
      className: hot ? 'energized' : undefined,
      label: e.aggregate && e.count > 1 ? String(e.count) : undefined,
      // クリティカル（駆動依存）は赤系太線で最優先強調（§2.11）。次いでフォーカス強調。
      style: e.critical
        ? { stroke: '#dc2626', strokeWidth: 3 }
        : e.highlight
          ? { stroke: '#f97316', strokeWidth: 2.4 }
          : e.aggregate
            ? { stroke: '#94a3b8', strokeDasharray: '6 4' }
            : { stroke: '#64748b' },
    };
  });
}

export { DISC_COLOR };
