// ============================================================================
// テーブル1行の描画（§12.3.2）。memo＋安定 props。編集は全て親→ストアアクション経由。
// 仮想化ライブラリには依存しない（TableView が絶対配置で位置決めする）。
// ============================================================================
import { memo, useEffect, useRef, useState } from 'react';
import {
  wbsPath,
  type CpmTaskResult,
  type Discipline,
  type Status,
  type TableColumnKey,
  type TableRow,
  type Task,
} from '../../domain';
import { DISCIPLINES, STATUSES } from '../../domain';
import { useApp } from '../../store/store';
import { selectTaskIndex } from '../../store/selectors';
import {
  COLUMN_META,
  DiscChip,
  EDITABLE_COLUMNS,
  ProgressBar,
  StatusBadge,
  ROW_HEIGHT,
} from './cells';

export interface RowHandlers {
  onSelect: (row: TableRow, e: React.MouseEvent) => void;
  onToggleCollapse: (prefix: string) => void;
  onStartEdit: (id: string, col: TableColumnKey) => void;
  onCommit: (id: string, patch: Partial<Task>, advance: boolean) => void;
  onCancelEdit: () => void;
  onJump: (taskId: string) => void;
}

interface Props {
  row: TableRow;
  columns: TableColumnKey[];
  cpm: CpmTaskResult | null;
  selected: boolean;
  editCol: TableColumnKey | null;
  assigneeOptions: string[];
  top: number;
  handlers: RowHandlers;
}

function cpmDate(cpm: CpmTaskResult | null, key: 'esDate' | 'efDate' | 'lsDate' | 'lfDate'): string {
  return cpm ? cpm[key] : '—';
}

function EditInput({
  col,
  task,
  assigneeOptions,
  onCommit,
  onCancel,
}: {
  col: TableColumnKey;
  task: Task;
  assigneeOptions: string[];
  onCommit: (patch: Partial<Task>, advance: boolean) => void;
  onCancel: () => void;
}) {
  if (col === 'discipline') {
    return (
      <select
        className="tedit"
        autoFocus
        defaultValue={task.discipline}
        onChange={(e) => onCommit({ discipline: e.target.value as Discipline }, false)}
        onBlur={onCancel}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      >
        {DISCIPLINES.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
    );
  }
  if (col === 'status') {
    return (
      <select
        className="tedit"
        autoFocus
        defaultValue={task.status}
        onChange={(e) => onCommit({ status: e.target.value as Status }, false)}
        onBlur={onCancel}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      >
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    );
  }
  return (
    <TextEdit col={col} task={task} assigneeOptions={assigneeOptions} onCommit={onCommit} onCancel={onCancel} />
  );
}

// text / number 系（wbsCode / name / assignee / progress / durationDays）
function TextEdit({
  col,
  task,
  assigneeOptions,
  onCommit,
  onCancel,
}: {
  col: TableColumnKey;
  task: Task;
  assigneeOptions: string[];
  onCommit: (patch: Partial<Task>, advance: boolean) => void;
  onCancel: () => void;
}) {
  const numeric = col === 'progress' || col === 'durationDays';
  const initial =
    col === 'wbsCode'
      ? task.wbsCode
      : col === 'name'
        ? task.name
        : col === 'assignee'
          ? task.assignee
          : col === 'progress'
            ? String(task.progress)
            : String(task.durationDays);
  const done = useRef(false);
  const draft = useRef(initial);
  const commit = (raw: string, advance: boolean) => {
    if (done.current) return; // blur と Enter/アンマウントの二重確定を防ぐ
    done.current = true;
    // 数値欄の空欄は 0 ではなく取消扱い（消して打ち直す途中で 0 が確定しないように）。
    if (numeric && raw.trim() === '') return onCancel();
    // wbsCode 編集: 確定でツリーが再構築され行が新WBSへ移動する（deriveTableRows が毎回再導出）。
    if (col === 'wbsCode') onCommit({ wbsCode: raw.trim() }, advance);
    else if (col === 'name') onCommit({ name: raw }, advance);
    else if (col === 'assignee') onCommit({ assignee: raw }, advance);
    else if (col === 'progress') {
      const n = Math.max(0, Math.min(100, Math.round(Number(raw) || 0)));
      onCommit({ progress: n }, advance);
    } else if (col === 'durationDays') {
      const n = Math.max(0, Math.round(Number(raw) || 0));
      onCommit({ durationDays: n }, advance);
    }
  };
  const cancel = () => {
    done.current = true;
    onCancel();
  };
  // 仮想スクロールで行が画面外へ外れ破棄されても、入力途中の値を失わない。
  const latest = useRef({ commit, initial });
  latest.current = { commit, initial };
  useEffect(
    () => () => {
      const l = latest.current;
      if (draft.current !== l.initial) l.commit(draft.current, false);
    },
    [],
  );
  return (
    <>
      <input
        className={'tedit task-name-input'}
        autoFocus
        type={numeric ? 'number' : 'text'}
        min={numeric ? 0 : undefined}
        max={col === 'progress' ? 100 : undefined}
        list={col === 'assignee' ? 'assignee-options' : undefined}
        defaultValue={initial}
        onChange={(e) => {
          draft.current = e.target.value;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit((e.target as HTMLInputElement).value, true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={(e) => commit(e.target.value, false)}
      />
      {col === 'assignee' ? (
        <datalist id="assignee-options">
          {assigneeOptions.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
      ) : null}
    </>
  );
}

function DepsCell({ row, onJump }: { row: TableRow; onJump: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const pred = row.predCount || 0;
  const succ = row.succCount || 0;
  return (
    <span className="deps-cell">
      <button
        className="deps-btn"
        title="先行/後続を表示"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        ◀{pred} ▶{succ}
      </button>
      {open ? (
        <DepsPopover taskId={row.id} onJump={onJump} onClose={() => setOpen(false)} />
      ) : null}
    </span>
  );
}

// 先行/後続ポップオーバー: ストアから直接読む（描画時のみ・参照とジャンプに限定・§12.3.6）。
function DepsPopover({
  taskId,
  onJump,
  onClose,
}: {
  taskId: string;
  onJump: (id: string) => void;
  onClose: () => void;
}) {
  // 参照とジャンプに限定（§12.3.6）。描画時にストアから直接読む（軽量・依存編集はしない）。
  const deps = useApp((s) => s.dependencies);
  const tasks = useApp((s) => s.tasks);
  const byId = selectTaskIndex(tasks);
  const nameOf = (id: string) => byId.get(id)?.name || id.slice(0, 6);
  const preds = deps.filter((d) => d.successorId === taskId);
  const succs = deps.filter((d) => d.predecessorId === taskId);
  return (
    <div className="deps-popover" onClick={(e) => e.stopPropagation()}>
      <div className="deps-pop-sec">先行</div>
      {preds.length ? (
        preds.map((d) => (
          <div
            key={d.id}
            className="deps-pop-item"
            onClick={() => {
              onJump(d.predecessorId);
              onClose();
            }}
          >
            {nameOf(d.predecessorId)}
          </div>
        ))
      ) : (
        <div className="deps-pop-empty">— なし</div>
      )}
      <div className="deps-pop-sec">後続</div>
      {succs.length ? (
        succs.map((d) => (
          <div
            key={d.id}
            className="deps-pop-item"
            onClick={() => {
              onJump(d.successorId);
              onClose();
            }}
          >
            {nameOf(d.successorId)}
          </div>
        ))
      ) : (
        <div className="deps-pop-empty">— なし</div>
      )}
    </div>
  );
}

function TableRowViewImpl({
  row,
  columns,
  cpm,
  selected,
  editCol,
  assigneeOptions,
  top,
  handlers,
}: Props) {
  const isWbs = row.kind === 'wbs';
  const task = row.task;

  const cell = (col: TableColumnKey) => {
    const meta = COLUMN_META[col];
    const editable = !isWbs && task && EDITABLE_COLUMNS.includes(col);
    const isEditing = editCol === col && !isWbs && task;
    const isMs = !!task?.isMilestone;

    let content: React.ReactNode = null;

    if (isEditing && task) {
      if (!(col === 'durationDays' && isMs)) {
        return (
          <div
            key={col}
            className={'tcell tcell-' + col + (meta.align ? ' align-' + meta.align : '')}
            style={{ width: meta.width }}
          >
            <EditInput
              col={col}
              task={task}
              assigneeOptions={assigneeOptions}
              onCommit={(patch, advance) => handlers.onCommit(task.id, patch, advance)}
              onCancel={handlers.onCancelEdit}
            />
          </div>
        );
      }
    }

    if (col === 'name') {
      const indent = 6 + row.depth * 14;
      if (isWbs) {
        content = (
          <span className="wbs-name" style={{ paddingLeft: indent }}>
            <button
              className="wbs-toggle"
              onClick={(e) => {
                e.stopPropagation();
                handlers.onToggleCollapse(row.wbsPrefix || '');
              }}
              title={row.collapsed ? '展開' : '折り畳み'}
            >
              {row.collapsed ? '▸' : '▾'}
            </button>
            <span className="wbs-label">WBS {row.wbsPrefix}</span>
            <span className="wbs-count">（{row.memberCount}）</span>
            {row.hasMilestone ? <span className="ms-flag" title="マイルストーンを含む">◆</span> : null}
            {row.hasCritical ? <span className="cp-flag" title="CPを含む">▲</span> : null}
          </span>
        );
      } else if (task) {
        content = (
          <span className="task-name-cell" style={{ paddingLeft: indent + 14 }}>
            {isMs ? <span className="ms-diamond" title="マイルストーン">◆</span> : null}
            <span className="tname-text">{task.name || '（無題）'}</span>
          </span>
        );
      }
    } else if (isWbs) {
      // WBS行: 集計を出す列だけ表示（ES=配下の最早／EF=配下の最遅・§12.3.2 サマリ）。
      if (col === 'wbsCode') content = <span className="mono">{row.wbsPrefix}</span>;
      else if (col === 'progress') content = <ProgressBar v={row.avgProgress || 0} />;
      else if (col === 'critical') content = row.hasCritical ? <span className="cp-mark">▲</span> : null;
      else if (col === 'es')
        content = <span className="mono wbs-agg">{row.esMin || '—'}</span>;
      else if (col === 'ef')
        content = <span className="mono wbs-agg">{row.efMax || '—'}</span>;
      else content = null;
    } else if (task) {
      switch (col) {
        case 'wbsCode':
          content = <span className="mono">{task.wbsCode || '—'}</span>;
          break;
        case 'wbsPath':
          content = <span className="wpath">{wbsPath(task.wbsCode).join(' › ') || '（ルート）'}</span>;
          break;
        case 'discipline':
          content = <DiscChip d={task.discipline} />;
          break;
        case 'assignee':
          content = task.assignee || <span className="muted">—</span>;
          break;
        case 'status':
          content = <StatusBadge s={task.status} />;
          break;
        case 'progress':
          content = <ProgressBar v={task.progress} />;
          break;
        case 'durationDays':
          content = <span className="mono">{isMs ? 0 : task.durationDays}</span>;
          break;
        case 'es':
          content = <span className="mono">{cpmDate(cpm, 'esDate')}</span>;
          break;
        case 'ef':
          content = <span className="mono">{cpmDate(cpm, 'efDate')}</span>;
          break;
        case 'ls':
          content = <span className="mono">{cpmDate(cpm, 'lsDate')}</span>;
          break;
        case 'lf':
          content = <span className="mono">{cpmDate(cpm, 'lfDate')}</span>;
          break;
        case 'totalFloat':
          content = cpm ? (
            <span className={'mono' + (cpm.totalFloat <= 0 ? ' tf-crit' : cpm.totalFloat <= 5 ? ' tf-near' : '')}>
              {cpm.totalFloat}
            </span>
          ) : (
            <span className="muted">—</span>
          );
          break;
        case 'critical':
          content = cpm && cpm.isCritical ? <span className="cp-mark" title="クリティカル">◆</span> : null;
          break;
        case 'deps':
          content = <DepsCell row={row} onJump={handlers.onJump} />;
          break;
      }
    }

    return (
      <div
        key={col}
        className={
          'tcell tcell-' +
          col +
          (meta.align ? ' align-' + meta.align : '') +
          (editable ? ' editable' : '')
        }
        style={{ width: meta.width }}
        onDoubleClick={
          editable && task
            ? (e) => {
                e.stopPropagation();
                handlers.onStartEdit(task.id, col);
              }
            : undefined
        }
      >
        {content}
      </div>
    );
  };

  return (
    <div
      className={
        'trow' +
        (isWbs ? ' trow-wbs' : '') +
        (selected ? ' sel' : '') +
        (row.dim ? ' dim' : '') +
        (row.outside ? ' outside' : '') +
        (!isWbs && cpm && cpm.isCritical ? ' crit' : '')
      }
      style={{ transform: `translateY(${top}px)`, height: ROW_HEIGHT }}
      data-id={row.id}
      onClick={(e) => handlers.onSelect(row, e)}
    >
      {columns.map((c) => cell(c))}
    </div>
  );
}

export const TableRowView = memo(TableRowViewImpl);
