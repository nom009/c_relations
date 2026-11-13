// ============================================================================
// 全体自動レイアウト（§2.5）: 4,000ノード全体を Web Worker で非同期整列（UIをブロックしない）。
// Worker 生成不可の環境ではメインスレッド fallback（dagre は初期バンドルに含めず遅延ロード）。
// 表示中サブグラフの同期整列は dagreCore.dagreLayout。
// ============================================================================
import type { PosMap } from './dagreCore';

export type { PosMap };

const fallback = (nodeIds: string[], edges: [string, string][]) =>
  import('./dagreCore').then((m) => m.layoutPositions(nodeIds, edges));

// 全体整列（Worker）。id 配列とエッジのペア配列を渡す。
export function runFullLayout(nodeIds: string[], edges: [string, string][]): Promise<PosMap> {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./fullLayout.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return fallback(nodeIds, edges);
  }
  return new Promise((resolve) => {
    worker.onmessage = (e: MessageEvent<{ pos: PosMap }>) => {
      resolve(e.data.pos);
      worker.terminate();
    };
    worker.onerror = () => {
      worker.terminate();
      resolve(fallback(nodeIds, edges));
    };
    worker.postMessage({ nodeIds, edges });
  });
}