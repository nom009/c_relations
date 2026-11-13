// ============================================================================
// カスタムノード（§2.11 EPC視覚規約）。すべて memo・LOD分岐（zoom<0.4で矩形化、§2.6）。
// React Flow 依存はこのコンポーネント層に閉じ込める（domain/store は非依存）。
// ============================================================================
import { memo } from 'react';
import { Handle, Position, useStore as useRFStore, type NodeProps } from '@xyflow/react';
import { DISC_COLOR } from '../adapters/reactflow';
import { DISC_COLOR_ON, type VisibleAggregateNode, type VisibleTaskNode } from '../domain';
import { useApp } from '../store/store';
import { CircuitTrace } from './circuitFx';

export const TaskNode = memo(function TaskNode({ id, data }: NodeProps) {
  const n = (data as { n: VisibleTaskNode }).n;
  const t = n.task;
  const zoom = useRFStore((s) => s.transform[2]);
  const editing = useApp((s) => s.editingId === id);
  const selected = useApp((s) => s.selection.taskId === id);
  const connectSrc = useApp((s) => s.connectSource === id); // つなぐモードの始点
  // 接続の瞬間、起点（out）→終点（in）の順に回路が走る
  const burst = useApp((s) => (s.burst?.source === id ? 'out' : s.burst?.target === id ? 'in' : null));
  const lod = zoom < 0.4;
  const color = DISC_COLOR[t.discipline] || DISC_COLOR.OTHER;

  if (lod && !editing) {
    return (
      <div
        className={
          'lod-node' +
          (n.critical ? ' critical' : '') +
          (n.related ? ' related' : '') +
          (connectSrc ? ' connect-src' : '') +
          (burst ? ' burst-' + burst : '')
        }
        style={{ background: color, opacity: n.dim ? 0.18 : n.outside ? 0.5 : 1 }}
      >
        <Handle type="target" position={Position.Left} />
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }

  const cls = [
    'task-node',
    'st-' + t.status,
    n.dim ? 'dim' : '',
    n.outside ? 'outside' : '',
    n.isOrigin ? 'origin' : '',
    n.related ? 'related' : '',
    n.critical ? 'critical' : '',
    connectSrc ? 'connect-src' : '',
    burst ? 'burst-' + burst : '',
    selected ? 'sel' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // 世代バッジ（起点/上流N/下流N）。関係ハイライト時に「自分の何世代先/前か」を一目化。
  const genBadge =
    n.related && n.gen != null ? (
      <span className={'gen-badge' + (n.gen === 0 ? ' origin' : n.gen < 0 ? ' up' : ' down')}>
        {n.gen === 0 ? '起点' : n.gen < 0 ? `▲${-n.gen}` : `▼${n.gen}`}
      </span>
    ) : null;

  const commit = (val: string) => {
    const v = (val || '').trim();
    if (v) useApp.getState().updateTask(id, { name: v });
    useApp.getState().setEditing(null);
  };

  return (
    <div className={cls}>
      <div className="disc-bar" style={{ background: color }} />
      {genBadge}
      <Handle type="target" position={Position.Left} />
      {editing ? (
        <input
          className="task-name-input nodrag"
          autoFocus
          defaultValue={t.name}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit((e.target as HTMLInputElement).value);
            } else if (e.key === 'Escape') {
              useApp.getState().setEditing(null);
            }
            e.stopPropagation();
          }}
        />
      ) : (
        <div className="task-name">{t.name}</div>
      )}
      <div className="task-meta">
        {t.discipline} · {t.assignee || '—'} · {t.durationDays}d
      </div>
      {t.status === 'DONE' ? <span className="badge-done">✓</span> : null}
      {t.status === 'IN_PROGRESS' ? (
        <div className="progress">
          <i style={{ width: t.progress + '%' }} />
        </div>
      ) : null}
      {burst ? <CircuitTrace seed={id} dir={burst} /> : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

export const MilestoneNode = memo(function MilestoneNode({ id, data }: NodeProps) {
  const n = (data as { n: VisibleTaskNode }).n;
  const t = n.task;
  const selected = useApp((s) => s.selection.taskId === id);
  return (
    <div className="ms-wrap">
      <Handle type="target" position={Position.Left} />
      <div className={'ms-node' + (selected ? ' sel' : '') + (n.critical ? ' critical' : '')} />
      <div className="ms-label">{t.name}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

// 支配的な工種（構成比最大）。集約カードのヘッダ色に使い、俯瞰時の一目の分類を担う。
function dominantDiscipline(d: VisibleAggregateNode['disc']): 'E' | 'P' | 'C' | 'OTHER' {
  const entries: ['E' | 'P' | 'C' | 'OTHER', number][] = [
    ['E', d.E],
    ['P', d.P],
    ['C', d.C],
    ['OTHER', d.OTHER],
  ];
  return entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

export const AggregateNode = memo(function AggregateNode({ id, data }: NodeProps) {
  const n = (data as { n: VisibleAggregateNode }).n;
  const total = n.count || 1;
  const expand = () => useApp.getState().expandAggregate(id);
  const dom = dominantDiscipline(n.disc);
  const domColor = DISC_COLOR_ON[dom]; // ヘッダは白文字が乗るため AA 安全版
  const seg = (c: number, key: string) =>
    c > 0 ? (
      <span key={key} style={{ width: (c / total) * 100 + '%', background: DISC_COLOR[key as 'E'] }} />
    ) : null;

  if (n.continuation) {
    return (
      <div className="agg-card continuation" title="フォーカス深さの先で折り畳み内へ続く経路（§2.9）">
        <Handle type="target" position={Position.Left} />
        <div className="agg-head" style={{ background: '#64748b' }}>
          <span className="agg-prefix">⋯ {n.prefix}</span>
          <span className="agg-count">{n.count}</span>
        </div>
        <div className="agg-body">
          <div className="agg-foot">内部に続く経路</div>
        </div>
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }

  // ズーム非依存の常時カード（LOD灰色箱を廃止）。ヘッダの色ブロック＋大きな件数で
  // 俯瞰でも「どのWBS群がどの工種主体か・規模はどれか」が読める（§0.3-2 即時把握）。
  return (
    <div
      className={'agg-card' + (n.dim ? ' dim' : '') + (n.hasCritical ? ' has-cp' : '')}
      onDoubleClick={expand}
      title={`WBS ${n.prefix}：${n.count}タスク・主体${dom}・進捗${n.avgProgress}%（ダブルクリック/E で展開）`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="agg-head" style={{ background: domColor }}>
        <span className="agg-prefix">{n.prefix}</span>
        <span className="agg-count">{n.count}</span>
        {n.hasMilestone ? <span className="agg-ms" title="マイルストーンを含む">◆</span> : null}
        {n.hasCritical ? <span className="agg-cp" title="内部にクリティカルタスクあり">CP</span> : null}
      </div>
      <div className="agg-body">
        <div className="agg-bars">
          {seg(n.disc.E, 'E')}
          {seg(n.disc.P, 'P')}
          {seg(n.disc.C, 'C')}
          {seg(n.disc.OTHER, 'OTHER')}
        </div>
        <div className="agg-foot">
          <span className="agg-prog">
            <i style={{ width: n.avgProgress + '%' }} />
          </span>
          <span className="agg-prog-num">{n.avgProgress}%</span>
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

export const nodeTypes = { task: TaskNode, milestone: MilestoneNode, aggregate: AggregateNode };
