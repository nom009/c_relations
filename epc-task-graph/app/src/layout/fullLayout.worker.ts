// 全体整列 Worker（§2.5）。4,000ノードの dagre レイアウトをメインスレッド外で実行。
import { layoutPositions } from './dagreCore';

interface Req {
  nodeIds: string[];
  edges: [string, string][];
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { nodeIds, edges } = e.data;
  (self as unknown as Worker).postMessage({ pos: layoutPositions(nodeIds, edges) });
};
