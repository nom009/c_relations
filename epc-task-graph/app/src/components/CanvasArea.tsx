// ============================================================================
// 編集キャンバス（React Flow v12）。§2.6 表示パイプラインの出力のみを描画し、
// onlyRenderVisibleElements + LOD + memo ノードで大規模を捌く。
// domain の deriveVisibleGraph が「何を載せるか」を一元決定する。
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  MiniMap,
  Controls,
  useReactFlow,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type IsValidConnection,
} from '@xyflow/react';
import {
  canConnect,
  naturalWbsCompare,
  DISC_COLOR,
  type Discipline,
  type VisibleNode,
} from '../domain';
import { toRFNodes, toRFEdges, type RFNodeData } from '../adapters/reactflow';
import { dagreLayout } from '../layout/dagreCore';
import { useApp, explainReject, nameOf } from '../store/store';
import { useCpm, useVisibleGraph } from '../store/hooks';
import { nodeTypes } from './nodes';
import { CircuitConnectionLine, edgeTypes } from './circuitFx';
import { isShortcutBlocked } from './keyboard';

// 俯瞰グリッド整列（§2.10/デザイン刷新）: 表示がすべて集約ノード（＝WBS群の俯瞰）のとき、
// LR依存チェーンだと横長になり fitView が極端に縮小→ノードが判読不能になる。WBS自然順で
// タイル状に敷き詰め、読める倍率で全群が一望できるようにする。集約は非永続の表示専用ノード
// なので座標を差し替えても実データ（タスク位置）に影響しない。タスクを含む表示は従来どおり。
const OVR_CW = 208;
const OVR_CH = 132;
const DELETE_KEYS = ['Delete', 'Backspace'];
function gridPackOverview(vnodes: VisibleNode[]): VisibleNode[] {
  if (vnodes.length < 2 || vnodes.length > 400) return vnodes;
  if (!vnodes.every((n) => n.kind === 'aggregate')) return vnodes;
  const sorted = [...vnodes].sort((a, b) => naturalWbsCompare((a as any).prefix, (b as any).prefix));
  const cols = Math.max(1, Math.round(Math.sqrt(sorted.length * 1.7))); // 横長バイアスで一望しやすく
  return sorted.map((n, i) => ({
    ...n,
    position: { x: (i % cols) * OVR_CW, y: Math.floor(i / cols) * OVR_CH },
  }));
}

// 再生成で React Flow の選択フラグが消えると onSelectionChange({}) が走り、ストアの選択まで
// 解除されるため、id が残る要素の選択状態を引き継ぐ。
function keepSelected<T extends { id: string; selected?: boolean }>(prev: T[], next: T[]): T[] {
  const sel = new Set(prev.filter((x) => x.selected).map((x) => x.id));
  return sel.size ? next.map((x) => (sel.has(x.id) ? { ...x, selected: true } : x)) : next;
}

// ノードは選択状態に加えて React Flow の測定済み寸法(measured)も引き継ぐ。再生成で寸法が消えると
// ノードが未測定扱い(visibility:hidden)になり、ResizeObserver の再通知が render にまとめられて
// 取りこぼされた場合に不可視のまま残るため。
function keepNodeRuntime(prev: Node<RFNodeData>[], next: Node<RFNodeData>[]): Node<RFNodeData>[] {
  const old = new Map(prev.map((n) => [n.id, n]));
  return next.map((n) => {
    const p = old.get(n.id);
    if (!p || (!p.measured && !p.selected)) return n;
    return { ...n, ...(p.measured ? { measured: p.measured } : {}), ...(p.selected ? { selected: true } : {}) };
  });
}

function FocusBar() {
  const focus = useApp((s) => s.viewSpec.focus);
  const name = useApp((s) => (s.viewSpec.focus ? nameOf(s.viewSpec.focus.taskId) : ''));
  if (!focus) return null;
  const mode = focus.mode || 'isolate';
  const setRange = (up: number, down: number) => useApp.getState().setFocusRange(up, down);
  const stepper = (label: string, val: number, on: (v: number) => void) => (
    <span className="focus-step">
      {label}
      <button className="btn" title="1世代減らす" onClick={() => on(Math.max(0, val - 1))}>
        −
      </button>
      <b>{val}</b>
      <button className="btn" title="1世代増やす" onClick={() => on(val + 1)}>
        ＋
      </button>
      世代
    </span>
  );
  return (
    <div className="focusbar">
      <span>
        <b>{name}</b> の関係タスク（{mode === 'highlight' ? 'ハイライト' : '抽出'}）
      </span>
      {stepper('上流', focus.up ?? 2, (v) => setRange(v, focus.down ?? 2))}
      {stepper('下流', focus.down ?? 2, (v) => setRange(focus.up ?? 2, v))}
      <span className="focus-modes">
        <button
          className={'btn' + (mode === 'highlight' ? ' on' : '')}
          title="全体を残して関係タスクを強調"
          onClick={() => useApp.getState().setFocusMode('highlight')}
        >
          ハイライト
        </button>
        <button
          className={'btn' + (mode === 'isolate' ? ' on' : '')}
          title="関係タスクだけを抽出表示"
          onClick={() => {
            useApp.getState().setFocusMode('isolate');
            useApp.getState().fit();
          }}
        >
          抽出
        </button>
      </span>
      <button className="btn" onClick={() => useApp.getState().clearFocus()}>
        解除 (Esc)
      </button>
    </div>
  );
}

// つなぐモードのツールバー＋状態ヒント（クリックで接続/切断・電撃演出つき）。
function ConnectBar() {
  const connectMode = useApp((s) => s.connectMode);
  const connectSource = useApp((s) => s.connectSource);
  const srcName = useApp((s) => (s.connectSource ? nameOf(s.connectSource) : ''));
  return (
    <div className="connectbar">
      <button
        className={'btn' + (connectMode ? ' on' : '')}
        data-testid="connect-toggle"
        onClick={() => useApp.getState().toggleConnectMode()}
        title="クリックで依存をつなぐ/切る（トラックパッド向け）"
      >
        🔗 つなぐ
      </button>
      {connectMode ? (
        <span className="connect-hint" data-testid="connect-hint">
          {connectSource ? (
            <>
              <b>{srcName}</b> から → <b>終点をクリック</b>（既に繋がっていれば切断）
            </>
          ) : (
            <>始点のタスクをクリック</>
          )}
        </span>
      ) : null}
    </div>
  );
}

export function CanvasArea() {
  const viewSpec = useApp((s) => s.viewSpec);
  const connectMode = useApp((s) => s.connectMode);
  // 非表示中（他ビュー表示時）に Delete で選択ノードが消えないよう、グラフ表示時だけ有効化。
  const graphActive = useApp((s) => s.activeView === 'graph');
  const focus = viewSpec.focus;
  const rf = useReactFlow();
  const dragSrc = useRef<string | null>(null);
  // React Flow はマウント直後にも空の選択を通知する。グラフ上で選んだものが外れた時だけ
  // ストアの選択を解除し、他ビュー/概要から来た選択（検索ジャンプ・新規追加）を消さない。
  const rfHasSelection = useRef(false);

  // 表示パイプライン（CPM 注入済み・モジュールキャッシュで左パネルと共有、§2.6/§9.2）。
  const cpm = useCpm();
  const derived = useVisibleGraph();
  const lastDerived = useRef(derived);
  lastDerived.current = derived;

  // 俯瞰（全集約）ならグリッド整列した表示用ノードを使う（座標差し替えは集約のみ・非永続）。
  const displayNodes = useMemo(() => gridPackOverview(derived.visibleNodes), [derived]);

  // 通電エフェクト: 直前に接続したエッジを一時的に「energized」にして電撃アニメを走らせる。
  const lastConnected = useApp((s) => s.lastConnected);
  const [energized, setEnergized] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!lastConnected) return;
    setEnergized((prev) => new Set(prev).add(lastConnected.id));
    const t = setTimeout(() => {
      setEnergized((prev) => {
        const n = new Set(prev);
        n.delete(lastConnected.id);
        return n;
      });
    }, 1300);
    return () => clearTimeout(t);
  }, [lastConnected]);

  const [nodes, setNodes] = useState<Node<RFNodeData>[]>(() => toRFNodes(displayNodes));
  const [edges, setEdges] = useState<Edge[]>(() => toRFEdges(derived.visibleEdges, energized));
  useEffect(() => {
    setNodes((prev) => keepNodeRuntime(prev, toRFNodes(displayNodes)));
    setEdges((prev) => keepSelected(prev, toRFEdges(derived.visibleEdges, energized)));
  }, [derived, displayNodes, energized]);

  // フィルタ/前後/表示モードが変わったら、結果へ滑らかに自動フィット（余白に迷子にならない）。
  // タスク編集では発火しない（フィルタ状態のキーだけを監視）。
  const filterKey = JSON.stringify({
    f: viewSpec.filter,
    bu: viewSpec.boundaryUp,
    bd: viewSpec.boundaryDown,
    dm: viewSpec.displayMode,
    fo: viewSpec.focus?.taskId ?? null,
  });
  const prevFilterKey = useRef(filterKey);
  useEffect(() => {
    if (prevFilterKey.current === filterKey) return;
    prevFilterKey.current = filterKey;
    const id = setTimeout(() => rf.fitView({ duration: 500, padding: 0.22 }), 90);
    return () => clearTimeout(id);
  }, [filterKey, rf]);

  // 1,500ノード超の表示は警告（§2.6 第一の防御）
  const warned = useRef(false);
  useEffect(() => {
    if (derived.stats.visible > 1500 && !warned.current) {
      warned.current = true;
      useApp
        .getState()
        .showToast(
          `この操作で${derived.stats.visible}ノードが表示されます。フィルタか下位WBS展開を推奨（性能保証外）`,
          true,
        );
    } else if (derived.stats.visible <= 1500) warned.current = false;
  }, [derived]);

  const onNodesChange = useCallback((ch: NodeChange<Node<RFNodeData>>[]) => setNodes((nds) => applyNodeChanges(ch, nds)), []);
  const onEdgesChange = useCallback((ch: EdgeChange<Edge>[]) => setEdges((eds) => applyEdgeChanges(ch, eds)), []);
  const onNodeDragStop = useCallback((_e: unknown, node: Node) => {
    if (!node.id.startsWith('wbs::')) useApp.getState().setPosition(node.id, node.position);
  }, []);

  const isValid = useCallback<IsValidConnection>(({ source, target }) => {
    if (!source || !target) return false;
    if (source.startsWith('wbs::') || target.startsWith('wbs::')) return false;
    return canConnect(source, target, useApp.getState().dependencies).ok;
  }, []);
  const onConnect = useCallback(({ source, target }: Connection) => {
    if (!source || !target) return;
    if (source.startsWith('wbs::') || target.startsWith('wbs::')) return;
    useApp.getState().addDependencyChecked(source, target);
  }, []);
  const onConnectStart = useCallback((_e: unknown, p: { nodeId: string | null }) => {
    dragSrc.current = p.nodeId;
  }, []);
  const onConnectEnd = useCallback((e: MouseEvent | TouchEvent) => {
    const src = dragSrc.current;
    dragSrc.current = null;
    if (!src) return;
    const pt = 'changedTouches' in e ? e.changedTouches[0] : e;
    const el = document.elementFromPoint(pt.clientX, pt.clientY);
    const nodeEl = el && el.closest ? el.closest('.react-flow__node') : null;
    const tgt = nodeEl && nodeEl.getAttribute('data-id');
    if (!tgt || tgt === src) return;
    const s = useApp.getState();
    if (tgt.startsWith('wbs::')) {
      s.expandAggregate(tgt);
      s.showToast('集約ノードを展開しました。実タスクへ接続してください（実エッジは実タスク間のみ）');
      return;
    }
    const chk = canConnect(src, tgt, s.dependencies);
    if (!chk.ok) s.showToast(explainReject(chk, s), true);
  }, []);

  const onSelectionChange = useCallback(({ nodes: sn, edges: se }: { nodes: Node[]; edges: Edge[] }) => {
    const empty = (!sn || !sn.length) && (!se || !se.length);
    if (empty) {
      if (rfHasSelection.current) useApp.getState().setSelection({});
      rfHasSelection.current = false;
      return;
    }
    rfHasSelection.current = true;
    if (sn && sn.length === 1) {
      const id = sn[0].id;
      if (id.startsWith('wbs::')) useApp.getState().setSelection({ aggId: id });
      else useApp.getState().setSelection({ taskId: id });
    } else if (se && se.length === 1) {
      useApp.getState().setSelection({ edgeId: se[0].id });
    }
  }, []);
  const onNodesDelete = useCallback((del: Node[]) => {
    const ids = del.filter((n) => !n.id.startsWith('wbs::')).map((n) => n.id);
    if (ids.length) useApp.getState().deleteTasks(ids);
  }, []);
  const onEdgesDelete = useCallback((del: Edge[]) => {
    const ids = del.map((e) => (e.data as { realId?: string } | undefined)?.realId).filter(Boolean) as string[];
    if (ids.length) useApp.getState().deleteDeps(ids);
  }, []);
  const onNodeDoubleClick = useCallback((_e: unknown, node: Node) => {
    if (node.id.startsWith('wbs::')) useApp.getState().expandAggregate(node.id);
    else useApp.getState().setEditing(node.id);
  }, []);
  // つなぐモード中のノードクリック＝接続/切断（通常の選択より優先）。
  const onNodeClick = useCallback((_e: unknown, node: Node) => {
    if (useApp.getState().connectMode) useApp.getState().connectClick(node.id);
  }, []);
  const onPaneDbl = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!(target.classList && target.classList.contains('react-flow__pane'))) return;
      const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      useApp.getState().addTask({ position: pos });
    },
    [rf],
  );

  // runners 登録（ツールバー/キーボードから呼ぶ）
  useEffect(() => {
    const s = useApp.getState();
    s.setRunner('fitView', () => rf.fitView({ duration: 400, padding: 0.2 }));
    s.setRunner('createAtCenter', () => {
      const pos = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      useApp.getState().addTask({ position: pos });
    });
    // 選択タスクへセンタリング（ビュー間同期・§12.2。fitView はしない＝ズーム保持）。
    s.setRunner('centerSelected', () => {
      const st = useApp.getState();
      const id = st.selection.taskId;
      if (!id) return;
      const t = st.tasks.find((x) => x.id === id);
      if (t) rf.setCenter(t.position.x + 93, t.position.y + 40, { zoom: Math.max(0.85, rf.getZoom()), duration: 400 });
    });
    s.setRunner('layoutVisible', () => {
      const der = lastDerived.current;
      const pos = dagreLayout(der.visibleNodes, der.visibleEdges);
      const st = useApp.getState();
      const byId = new Map(st.tasks.map((t) => [t.id, t]));
      const updates: Record<string, { x: number; y: number }> = {};
      for (const vn of der.visibleNodes as VisibleNode[]) {
        const np = pos[vn.id];
        if (!np) continue;
        if (vn.kind === 'task') updates[vn.id] = np;
        else {
          const dx = np.x - vn.position.x;
          const dy = np.y - vn.position.y;
          for (const mid of vn.memberIds) {
            const mt = byId.get(mid);
            if (mt) updates[mid] = { x: mt.position.x + dx, y: mt.position.y + dy };
          }
        }
      }
      st.applyPositions(updates);
      setTimeout(() => rf.fitView({ duration: 400, padding: 0.2 }), 30);
      st.showToast('表示中サブグラフを整列しました（' + der.visibleNodes.length + 'ノード）');
    });
  }, [rf]);

  // キーボード（§2.2）。インライン編集中は無効化。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isShortcutBlocked(e)) return;
      const s = useApp.getState();
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (meta && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        return;
      }
      if (meta) return;
      // 多ビュー: グラフがアクティブな時だけグラフ用ショートカットを処理（§12.2）。
      // Undo/Redo（meta+z）は上で先に処理済みなので全ビュー共通で効く。
      if (useApp.getState().activeView !== 'graph') return;
      switch (e.key) {
        case 'n':
        case 'N':
          e.preventDefault();
          s.runners.createAtCenter?.();
          break;
        case 'Tab':
          if (s.selection.taskId) {
            e.preventDefault();
            s.createSuccessor(s.selection.taskId);
          }
          break;
        case 'Enter':
          if (s.selection.taskId) {
            e.preventDefault();
            s.setEditing(s.selection.taskId);
          }
          break;
        case 'h':
        case 'H':
          if (s.selection.taskId) s.toggleFocus(s.selection.taskId);
          break;
        case 'e':
        case 'E':
          if (s.selection.aggId) s.expandAggregate(s.selection.aggId);
          break;
        case '[':
          s.incFocusDepth(-1);
          break;
        case ']':
          s.incFocusDepth(1);
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          rf.fitView({ duration: 400, padding: 0.2 });
          break;
        case '1':
          s.setExpandLevel(1);
          break;
        case '2':
          s.setExpandLevel(2);
          break;
        case '3':
          s.setExpandLevel(3);
          break;
        case 'Escape':
          if (s.connectMode) s.toggleConnectMode(); // つなぐモードを最優先で終了
          else s.escape();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rf]);

  const st = derived.stats;
  return (
    <div className={'canvas-area' + (connectMode ? ' connect-mode' : '')} onDoubleClick={onPaneDbl}>
      {focus ? <FocusBar /> : null}
      <ConnectBar />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionLineComponent={CircuitConnectionLine}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        isValidConnection={isValid}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onSelectionChange={onSelectionChange}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onlyRenderVisibleElements
        snapToGrid
        snapGrid={[15, 15]}
        connectionRadius={30}
        deleteKeyCode={graphActive ? DELETE_KEYS : null}
        multiSelectionKeyCode={['Shift']}
        minZoom={0.05}
        maxZoom={2.5}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} size={1.2} color="#d7dbe3" bgColor="#fbfbfd" />
        <MiniMap
          pannable
          zoomable
          nodeColor={(nd) => {
            const n = (nd.data as RFNodeData)?.n;
            // 俯瞰でもクリティカルパスを一目化（§2.10/§2.11）: CPタスク/CPを含む集約は赤系。
            if (n?.kind === 'task' && cpm.criticalTasks.has(n.id)) return '#ef4444';
            if (n?.kind === 'aggregate') return n.hasCritical ? '#f87171' : '#94a3b8';
            const disc =
              n?.kind === 'task' ? (n as { task: { discipline: Discipline } }).task.discipline : 'OTHER';
            return DISC_COLOR[disc] || '#64748b';
          }}
        />
        <Controls />
      </ReactFlow>
      <div className="hint">
        空白ダブルクリックで作成 · ハンドルからドラッグで接続 · N/Tab/Enter/H/F/1-3/Delete/⌘Z · 表示 {st.visible} / 全 {st.total}
      </div>
    </div>
  );
}
