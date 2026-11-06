// ============================================================================
// テーブルビュー（§12.3）。仮想スクロール（@tanstack/react-virtual v3）をこのファイル配下に
// 隔離。行集合は domain の deriveTableRows（selectTableRows でメモ化）が一元決定する。
// 選択・フィルタ・折り畳みはストア共有状態のため「同期は基本なにもしない」で成立する（§12.2）。
// ============================================================================
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useApp, ALL_TABLE_COLUMNS } from '../../store/store';
import { useAssigneeOptions, useCpm, useTableRows } from '../../store/hooks';
import type { TableColumnKey, TableRow, Task } from '../../domain';
import { COLUMN_META, ROW_HEIGHT } from './cells';
import { TableRowView, type RowHandlers } from './TableRowView';
import { ColumnMenu } from './ColumnMenu';
import { BulkBar } from './BulkBar';
import { isShortcutBlocked } from '../keyboard';

export function TableView({ active }: { active: boolean }) {
  const tableSort = useApp((s) => s.tableSort);
  const tableColumns = useApp((s) => s.tableColumns);
  const selection = useApp((s) => s.selection);
  const selectedIds = useApp((s) => s.selectedIds);

  const cpm = useCpm();
  const { rows, stats } = useTableRows();

  const columns = useMemo(
    () => ALL_TABLE_COLUMNS.filter((k) => tableColumns.includes(k)),
    [tableColumns],
  );
  const totalWidth = useMemo(() => columns.reduce((w, c) => w + COLUMN_META[c].width, 0), [columns]);
  const assigneeOptions = useAssigneeOptions();

  // 編集中セル（ローカル・§12.1「読み方」の状態）。書込は必ずストアアクション経由。
  const editRef = useRef<{ id: string; col: TableColumnKey } | null>(null);
  const [, force] = useReducer((x: number) => x + 1, 0); // 編集セルの表示トグル用の再描画ティック
  const setEdit = useCallback(
    (v: { id: string; col: TableColumnKey } | null) => {
      editRef.current = v;
      force();
    },
    [force],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // 行→index の索引（選択同期・スクロール追従用）。
  const rowsRef = useRef<TableRow[]>(rows);
  rowsRef.current = rows;
  const indexById = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.id, i));
    return m;
  }, [rows]);

  const selId = selection.taskId || selection.aggId || null;
  // 実効選択（多選択が張られていればそれ、無ければアンカー1件）。一括操作/削除の対象。
  const effectiveSelected = useMemo(
    () => (selectedIds.length ? selectedIds : selection.taskId ? [selection.taskId] : []),
    [selectedIds, selection.taskId],
  );
  // 行ハイライト集合: 多選択はタスクidの集合、単一時はアンカー（agg行も含む selId）。
  const selectedSet = useMemo(
    () => new Set(selectedIds.length ? selectedIds : selId ? [selId] : []),
    [selectedIds, selId],
  );

  // 復帰時に measure()（コンテナ 0px の間に破綻しないための1回・§12.2）＋選択へスクロール。
  useEffect(() => {
    if (!active) return;
    virtualizer.measure();
    if (selId != null) {
      const idx = indexById.get(selId);
      if (idx != null) virtualizer.scrollToIndex(idx, { align: 'center' });
    }
    // active 化の一度だけでよい（rows/選択変更は別 effect が拾う）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // 選択がストア側で変わった（グラフ選択・ジャンプ等）ら、その行へ追従スクロール。
  useEffect(() => {
    if (!active || selId == null) return;
    const idx = indexById.get(selId);
    if (idx != null) virtualizer.scrollToIndex(idx, { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId, indexById, active]);

  // ---- 行ハンドラ（すべてストアアクション経由）----
  const commit = useCallback((id: string, patch: Partial<Task>, advance: boolean) => {
    useApp.getState().updateTask(id, patch);
    if (advance) {
      const list = rowsRef.current;
      const cur = list.findIndex((r) => r.id === id);
      let next = -1;
      for (let i = cur + 1; i < list.length; i++) {
        if (list[i].kind === 'task') {
          next = i;
          break;
        }
      }
      if (next >= 0) {
        const nr = list[next];
        useApp.getState().setSelection({ taskId: nr.id });
        editRef.current = { id: nr.id, col: 'name' };
      } else {
        editRef.current = null;
      }
    } else {
      editRef.current = null;
    }
    force();
  }, [force]);

  const handlers: RowHandlers = useMemo(
    () => ({
      onSelect: (row, e) => {
        const s = useApp.getState();
        if (row.kind === 'wbs') {
          s.setSelection({ aggId: row.id });
          return;
        }
        // Cmd/Ctrl+クリック=トグル ／ Shift+クリック=アンカー〜クリックの範囲（タスク行のみ）。
        if (e.metaKey || e.ctrlKey) {
          s.toggleSelectedId(row.id);
        } else if (e.shiftKey) {
          const list = rowsRef.current;
          const anchorId = s.selection.taskId;
          const ai = anchorId ? list.findIndex((r) => r.id === anchorId) : -1;
          const ci = list.findIndex((r) => r.id === row.id);
          if (ai < 0 || ci < 0) {
            s.setSelection({ taskId: row.id });
          } else {
            const [lo, hi] = ai < ci ? [ai, ci] : [ci, ai];
            const ids: string[] = [];
            for (let i = lo; i <= hi; i++) if (list[i].kind === 'task') ids.push(list[i].id);
            s.setSelectedIds(ids, row.id);
          }
        } else {
          s.setSelection({ taskId: row.id });
        }
      },
      onToggleCollapse: (prefix) => useApp.getState().toggleCollapse(prefix),
      onStartEdit: (id, col) => setEdit({ id, col }),
      onCommit: commit,
      onCancelEdit: () => setEdit(null),
      onJump: (taskId) => useApp.getState().revealTask(taskId),
    }),
    [commit, setEdit],
  );

  // ---- キーボード（§12.3.7）。table がアクティブな時のみ。編集中は無効 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState();
      if (s.activeView !== 'table') return;
      if (isShortcutBlocked(e)) return;
      if (e.metaKey || e.ctrlKey) return; // Undo/Redo 等はグラフ側グローバルに任せる
      const list = rowsRef.current;
      const curId = s.selection.taskId || s.selection.aggId || null;
      const curIdx = curId != null ? list.findIndex((r) => r.id === curId) : -1;
      const selectRow = (r: TableRow) => {
        if (r.kind === 'wbs') s.setSelection({ aggId: r.id });
        else s.setSelection({ taskId: r.id });
      };
      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          const ni = curIdx < 0 ? 0 : Math.min(list.length - 1, curIdx + 1);
          const nr = list[ni];
          if (!nr) break;
          if (e.shiftKey && nr.kind === 'task') {
            // Shift+↓: 下の行を選択に加えつつアンカーを移動（範囲の下方向拡張）。
            const base = s.selectedIds.length ? s.selectedIds : s.selection.taskId ? [s.selection.taskId] : [];
            s.setSelectedIds([...base, nr.id], nr.id);
          } else {
            selectRow(nr);
          }
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const ni = curIdx <= 0 ? 0 : curIdx - 1;
          const nr = list[ni];
          if (!nr) break;
          if (e.shiftKey && nr.kind === 'task') {
            const base = s.selectedIds.length ? s.selectedIds : s.selection.taskId ? [s.selection.taskId] : [];
            s.setSelectedIds([...base, nr.id], nr.id);
          } else {
            selectRow(nr);
          }
          break;
        }
        case 'ArrowRight': {
          const r = list[curIdx];
          if (r && r.kind === 'wbs' && r.collapsed) {
            e.preventDefault();
            s.toggleCollapse(r.wbsPrefix || '');
          }
          break;
        }
        case 'ArrowLeft': {
          const r = list[curIdx];
          if (!r) break;
          e.preventDefault();
          if (r.kind === 'wbs' && !r.collapsed) {
            s.toggleCollapse(r.wbsPrefix || '');
          } else {
            // タスク/折り畳み済みWBS: 親WBS行へ移動。
            for (let i = curIdx - 1; i >= 0; i--) {
              if (list[i].kind === 'wbs' && list[i].depth < r.depth) {
                selectRow(list[i]);
                break;
              }
            }
          }
          break;
        }
        case 'Enter': {
          const r = list[curIdx];
          if (r && r.kind === 'task') {
            e.preventDefault();
            setEdit({ id: r.id, col: 'name' });
          }
          break;
        }
        case 'Tab': {
          // 後続作成（§12.3.5・createSuccessor 流用）。選択タスクの後続を作り名前セルを編集開始。
          if (s.selection.taskId) {
            e.preventDefault();
            s.createSuccessor(s.selection.taskId);
            const newId = useApp.getState().selection.taskId; // createSuccessor が新タスクを選択済み
            if (newId) setEdit({ id: newId, col: 'name' });
          }
          break;
        }
        case 'n':
        case 'N': {
          e.preventDefault();
          const r = list[curIdx];
          const ctx = r ? (r.kind === 'task' ? r.task!.wbsCode : r.wbsPrefix || '') : '';
          const t = s.addTask({ wbsCode: ctx });
          setEdit({ id: t.id, col: 'name' });
          break;
        }
        case 'Delete':
        case 'Backspace': {
          const sel = s.selectedIds.length ? s.selectedIds : s.selection.taskId ? [s.selection.taskId] : [];
          if (sel.length) {
            e.preventDefault();
            s.deleteTasks(sel);
          }
          break;
        }
        case 'h':
        case 'H': {
          if (s.selection.taskId) {
            e.preventDefault();
            s.toggleFocus(s.selection.taskId);
            s.setActiveView('graph');
          }
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setEdit]);

  const virtualItems = virtualizer.getVirtualItems();
  const edit = editRef.current;

  return (
    <div className="tableview">
      <div className="table-toolbar">
        <span className="stat" data-testid="table-count">
          行 <b>{stats.rows}</b>（タスク {stats.taskRows} / WBS {stats.wbsRows} / 全 {stats.total}）
        </span>
        {effectiveSelected.length > 1 ? (
          <BulkBar ids={effectiveSelected} assigneeOptions={assigneeOptions} />
        ) : null}
        <span className="spacer" />
        <button
          className="btn"
          title="選択WBS文脈で新規行 (N)"
          onClick={() => {
            const s = useApp.getState();
            const t = s.addTask();
            setEdit({ id: t.id, col: 'name' });
          }}
        >
          ＋行 (N)
        </button>
        <ColumnMenu />
      </div>
      <div className="table-scroll" ref={parentRef} data-testid="table-scroll">
        <div className="table-inner" style={{ width: totalWidth }}>
          <div className="thead" style={{ width: totalWidth }}>
            {columns.map((c) => {
              const meta = COLUMN_META[c];
              const si = tableSort.findIndex((x) => x.key === c);
              const sort = si >= 0 ? tableSort[si] : null;
              return (
                <div
                  key={c}
                  className={
                    'th tcell-' + c + (meta.align ? ' align-' + meta.align : '') + (meta.sortable ? ' sortable' : '')
                  }
                  style={{ width: meta.width }}
                  onClick={
                    meta.sortable
                      ? (e) => useApp.getState().toggleTableSort(c as Exclude<TableColumnKey, 'deps'>, e.shiftKey)
                      : undefined
                  }
                >
                  {meta.label}
                  {sort ? <span className="sort-ind">{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span> : null}
                  {sort && tableSort.length > 1 ? <span className="sort-ord">{si + 1}</span> : null}
                </div>
              );
            })}
          </div>
          <div className="tbody" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualItems.map((vi) => {
              const row = rows[vi.index];
              if (!row) return null;
              const isSel = selectedSet.has(row.id);
              const cpmR = row.kind === 'task' ? cpm.byTask.get(row.id) || null : null;
              const editCol = edit && edit.id === row.id ? edit.col : null;
              return (
                <TableRowView
                  key={row.id}
                  row={row}
                  columns={columns}
                  cpm={cpmR}
                  selected={isSel}
                  editCol={editCol}
                  assigneeOptions={assigneeOptions}
                  top={vi.start}
                  handlers={handlers}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
