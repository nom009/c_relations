// ============================================================================
// 自動レイアウト（§2.5）: 左→右 DAG。
// - dagreLayout: 表示中サブグラフ（数百）をメインスレッド同期で整列。
// - runFullLayout: 4,000ノード全体を Web Worker で非同期整列（UIをブロックしない）。
//   Worker 生成不可の環境ではメインスレッド fallback。
// ============================================================================
import { layoutPositions, type PosMap } from './dagreCore';
import type { VisibleNode, VisibleEdge } from '../domain';

export type { PosMap };

export function dagreLayout(nodes: VisibleNode[], edges: VisibleEdge[]): PosMap {
  return layoutPositions(
    nodes.map((n) => n.id),
    edges.map((e) => [e.source, e.target] as const),
  );
}

// 全体整列（Worker）。id 配列とエッジのペア配列を渡す。
export function runFullLayout(nodeIds: string[], edges: [string, string][]): Promise<PosMap> {
  return new Promise((resolve) => {
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('./fullLayout.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      worker = null;
    }
    if (!worker) {
      resolve(layoutPositions(nodeIds, edges));
      return;
    }
    worker.onmessage = (e: MessageEvent<{ pos: PosMap }>) => {
      resolve(e.data.pos);
      worker!.terminate();
    };
    worker.onerror = () => {
      resolve(layoutPositions(nodeIds, edges));
      worker!.terminate();
    };
    worker.postMessage({ nodeIds, edges });
  });
}
