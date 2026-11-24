// ============================================================================
// ガントビュー（§9.3 / §12.4・Phase 3 / PR-G）。View Shell の第3タブ。
// §12.4 の接続契約に純粋に乗る:
//   1. 行集合 = selectTableRows（テーブルと同一の順序/折り畳み/フィルタ/ソート）
//   2. バー座標 = selectCpm().byTask の es/ef（暦日オフセット×日幅・線形）
//   3. WBS行のサマリバー = TableRow.esMin/efMax（deriveTableRows の集計・PR-T2で追加済み）
//   4. 行仮想化 = @tanstack/react-virtual（テーブルと共有・ROW_HEIGHT 共通）
// 描画方式: 自前の絶対配置 div（§9.3 スパイク判断＝SVGよりDOMバーが軽量で十分）。
// 左ペイン（名前列）と右ペイン（時間軸）を分離し、縦スクロールを同期・横スクロールは右のみ。
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  addCalendarDays,
  DISC_COLOR,
  finishVariance,
  todayIso,
  wbsLabel,
  wbsNameOf,
  type CpmTaskResult,
  type TableRow,
  type Task,
} from '../../domain';
import { useApp } from '../../store/store';
import { useCpm, useTableRows } from '../../store/hooks';
import { ROW_HEIGHT } from '../table/cells';
import { dateRange, varianceLabel } from '../scheduleFormat';

const LEFT_W = 260; // 名前ペイン幅
const HEAD_H = 30; // 日付軸ヘッダ高
const MS_DAY = 86400000;
const TODAY_PAD_DAYS = 60; // 今日が表示期間からこの日数以内なら期間を広げて今日線を見せる

function dayOffset(dateStr: string, base: string): number {
  return Math.round((Date.parse(dateStr) - Date.parse(base)) / MS_DAY);
}

// WBS行の [開始, 終了)（オフセット）。efMax はその日を含む終了日なので +1 で排他的終端へ戻す。
function wbsSpan(r: TableRow, dataDate: string): [number, number] | null {
  if (r.esOff != null && r.efOff != null) return [r.esOff, r.efOff];
  if (r.esMin && r.efMax) return [dayOffset(r.esMin, dataDate), dayOffset(r.efMax, dataDate) + 1];
  return null;
}

// ベースラインの [開始, 終了)（オフセット・終了はその日を含む日付から +1）。WBS行は配下の min/max。
function baselineSpan(
  start: string | null | undefined,
  finish: string | null | undefined,
  dataDate: string,
): [number, number] | null {
  if (!start || !finish) return null;
  const s = dayOffset(start, dataDate);
  const f = dayOffset(finish, dataDate) + 1;
  if (!Number.isFinite(s) || !Number.isFinite(f)) return null;
  return [s, Math.max(s, f)];
}

const rowBaseline = (r: TableRow): [string | null | undefined, string | null | undefined] =>
  r.kind === 'wbs' ? [r.baselineStart, r.baselineFinish] : [r.task?.baselineStart, r.task?.baselineFinish];

// バーのツールチップ: 予定（その日を含む）／実績／ベースライン／差異。
function barTitle(t: Task, c: CpmTaskResult): string {
  const lines = [
    t.name || '（無題）',
    t.isMilestone ? `予定 ${c.finishDate}` : `予定 ${dateRange(c.esDate, c.finishDate)}`,
  ];
  if (t.actualStart || t.actualFinish) lines.push(`実績 ${dateRange(t.actualStart, t.actualFinish)}`);
  if (t.baselineStart || t.baselineFinish) lines.push(`ベースライン ${dateRange(t.baselineStart, t.baselineFinish)}`);
  const v = finishVariance(t, c);
  if (v != null) lines.push(`差異 ${varianceLabel(v)}`);
  return lines.join('\n');
}

// 月初の目盛り（yyyy-mm ラベル）を [fromOff, toOff] の範囲で列挙（表示中の期間に合わせる）。
function monthTicks(dataDate: string, fromOff: number, toOff: number): { off: number; label: string }[] {
  const ticks: { off: number; label: string }[] = [];
  const start = new Date(dataDate + 'T00:00:00Z');
  if (Number.isNaN(start.getTime()) || !Number.isFinite(fromOff)) return ticks;
  start.setUTCDate(start.getUTCDate() + fromOff);
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  for (let i = 0; i < 2400; i++) {
    const iso = d.toISOString().slice(0, 10);
    const off = dayOffset(iso, dataDate);
    if (off > toOff) break;
    if (off >= fromOff) ticks.push({ off, label: iso.slice(0, 7) });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return ticks;
}

export function GanttView({ active }: { active: boolean }) {
  const dependencies = useApp((s) => s.dependencies);
  const tasks = useApp((s) => s.tasks);
  const dataDate = useApp((s) => s.project.dataDate);
  const wbsNames = useApp((s) => s.project.wbsNames);
  const selection = useApp((s) => s.selection);
  const [manualDayWidth, setManualDayWidth] = useState<number | null>(null); // null=自動フィット
  const [showDeps, setShowDeps] = useState(true); // 依存矢印の表示トグル
  const [baselinePref, setBaselinePref] = useState<boolean | null>(null); // null=ベースラインがあれば表示
  const [paneW, setPaneW] = useState(800); // 右ペイン幅（自動フィット計算用）

  const cpm = useCpm();
  const { rows } = useTableRows();
  const hasBaseline = useMemo(() => tasks.some((t) => !!t.baselineFinish), [tasks]);
  const showBaseline = hasBaseline && (baselinePref ?? true);
  const today = todayIso();
  const todayOff = dayOffset(today, dataDate);

  // 時間ドメインは「表示中の行」の日付範囲に絞る（全体15,000日でなく、見えているタスクの期間へズーム）。
  // 完了タスクは実績日（基準日より前＝負のオフセット）に置かれるため、その分も含める。
  const range = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    const take = (s: number, f: number) => {
      if (s < lo) lo = s;
      if (f > hi) hi = f;
    };
    for (const r of rows) {
      if (r.kind === 'task') {
        const c = cpm.byTask.get(r.id);
        if (c) take(c.es, c.ef);
      } else {
        const w = wbsSpan(r, dataDate);
        if (w) take(w[0], w[1]);
      }
      const b = showBaseline ? baselineSpan(...rowBaseline(r), dataDate) : null;
      if (b) take(b[0], b[1]);
    }
    if (lo === Infinity) return { lo: 0, hi: 30 };
    // 今日が近ければ範囲を広げて今日線も見せる（遠い過去/未来の基準日では広げない）。
    if (Number.isFinite(todayOff) && todayOff >= lo - TODAY_PAD_DAYS && todayOff <= hi + TODAY_PAD_DAYS) {
      take(todayOff, todayOff + 1);
    }
    return { lo, hi };
  }, [rows, cpm, dataDate, showBaseline, todayOff]);

  const originOff = Math.floor(range.lo) - 2; // 左に少し余白
  const spanDays = Math.max(14, range.hi - originOff + 4);
  // 自動フィット日幅: 表示中の期間がペインに収まる倍率（手動ズーム時はそれを優先）。
  const autoDayW = Math.min(28, Math.max(2, (paneW - 24) / spanDays));
  const dayWidth = manualDayWidth ?? autoDayW;
  const timelineW = Math.max(200, spanDays * dayWidth);
  const ticks = useMemo(
    () => monthTicks(dataDate, originOff, originOff + spanDays),
    [dataDate, originOff, spanDays],
  );
  // 今日線は基準日と別の日で、表示期間内の時だけ出す。
  const inView = (off: number) => Number.isFinite(off) && off >= originOff && off <= originOff + spanDays;
  const showData = inView(0);
  const showToday = todayOff !== 0 && inView(todayOff);

  const parentRef = useRef<HTMLDivElement>(null); // 右ペイン（縦横スクロール・仮想化の親）

  // ペイン幅を実測して自動フィットに反映。
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const update = () => setPaneW(el.clientWidth || 800);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);
  const leftInnerRef = useRef<HTMLDivElement>(null); // 左ペイン内側（縦スクロールを右に同期）

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // 右ペインの縦スクロールを左ペインへ反映（横は右のみ）。
  const onScroll = useCallback(() => {
    if (leftInnerRef.current && parentRef.current) {
      leftInnerRef.current.style.transform = `translateY(${-parentRef.current.scrollTop}px)`;
    }
  }, []);

  const rowsRef = useRef<TableRow[]>(rows);
  rowsRef.current = rows;
  const indexById = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.id, i));
    return m;
  }, [rows]);
  const selId = selection.taskId || selection.aggId || null;

  useEffect(() => {
    if (!active) return;
    virtualizer.measure();
    onScroll();
    if (selId != null) {
      const idx = indexById.get(selId);
      if (idx != null) virtualizer.scrollToIndex(idx, { align: 'center' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const select = (r: TableRow) => {
    if (r.kind === 'wbs') useApp.getState().setSelection({ aggId: r.id });
    else useApp.getState().setSelection({ taskId: r.id });
  };

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // 依存矢印: 仮想化された「表示中の行ペア」だけを結ぶ（4,000×6,000でも描画は数十本で軽量）。
  // 折り畳み内の非表示タスクは visTop に載らない＝矢印も出ない（表示と整合）。
  const arrows = useMemo(() => {
    if (!showDeps) return [];
    const visTop = new Map<string, number>(); // taskId → 行の上端Y（表示中のタスク行のみ）
    for (const vi of virtualItems) {
      const r = rows[vi.index];
      if (r && r.kind === 'task') visTop.set(r.id, vi.start);
    }
    const out: { d: string; crit: boolean }[] = [];
    for (const dep of dependencies) {
      const pt = visTop.get(dep.predecessorId);
      const st = visTop.get(dep.successorId);
      if (pt == null || st == null) continue; // 両端が見えている時だけ描く
      const pc = cpm.byTask.get(dep.predecessorId);
      const sc = cpm.byTask.get(dep.successorId);
      if (!pc || !sc) continue;
      // 先行バー終端 → 後続バー始端 をエルボー（直角）で結ぶ。矢印は後続の開始側に付く。
      const x1 = (pc.ef - originOff) * dayWidth;
      const y1 = pt + ROW_HEIGHT / 2;
      const x2 = (sc.es - originOff) * dayWidth;
      const y2 = st + ROW_HEIGHT / 2;
      const ex = Math.max(x1 + 7, x2 - 7); // 一旦右へ出っ張ってから縦移動（重なり回避）
      const path = `M ${x1} ${y1} L ${ex} ${y1} L ${ex} ${y2} L ${x2} ${y2}`;
      out.push({ d: path, crit: cpm.criticalEdges.has(dep.id) });
    }
    return out;
  }, [showDeps, virtualItems, rows, dependencies, cpm, dayWidth, originOff]);

  return (
    <div className="ganttview">
      <div className="gantt-toolbar">
        <span className="stat">
          ガント：<b>{rows.length}</b> 行 · 表示期間 <b>{Math.round(spanDays)}</b> 日
        </span>
        <span className="spacer" />
        <button
          className={'btn' + (showDeps ? ' on' : '')}
          title="依存矢印の表示切替"
          data-testid="gantt-deps-toggle"
          onClick={() => setShowDeps((v) => !v)}
        >
          依存線
        </button>
        <button
          className={'btn' + (showBaseline ? ' on' : '')}
          title={hasBaseline ? 'ベースライン（保存した計画）の表示切替' : 'ベースラインは未保存です（操作メニューから保存）'}
          data-testid="gantt-baseline-toggle"
          disabled={!hasBaseline}
          onClick={() => setBaselinePref(!showBaseline)}
        >
          ベースライン
        </button>
        <span className="gantt-zoom">
          日幅
          <button
            className="btn"
            title="縮小"
            onClick={() => setManualDayWidth((w) => Math.max(1.5, (w ?? dayWidth) - Math.max(0.5, dayWidth * 0.25)))}
          >
            －
          </button>
          <button
            className="btn"
            title="拡大"
            onClick={() => setManualDayWidth((w) => Math.min(40, (w ?? dayWidth) + Math.max(0.5, dayWidth * 0.25)))}
          >
            ＋
          </button>
          <button
            className={'btn' + (manualDayWidth == null ? ' on' : '')}
            title="表示中のタスク期間に自動フィット"
            data-testid="gantt-fit"
            onClick={() => setManualDayWidth(null)}
          >
            自動
          </button>
        </span>
      </div>

      <div className="gantt-main">
        {/* 左ペイン: タスク名列（横固定・縦は右に同期） */}
        <div className="gantt-left" style={{ width: LEFT_W }}>
          <div className="gantt-left-head" style={{ height: HEAD_H }}>
            タスク
          </div>
          <div className="gantt-left-clip">
            <div ref={leftInnerRef} className="gantt-left-inner" style={{ height: totalSize }}>
              {virtualItems.map((vi) => {
                const r = rows[vi.index];
                if (!r) return null;
                const isWbs = r.kind === 'wbs';
                return (
                  <div
                    key={r.id}
                    className={
                      'gantt-name' +
                      (isWbs ? ' wbs' : '') +
                      (r.id === selId ? ' sel' : '') +
                      (vi.index % 2 === 1 ? ' odd' : '') // ゼブラ縞（行を横に追いやすく）
                    }
                    style={{ transform: `translateY(${vi.start}px)`, height: ROW_HEIGHT }}
                    onClick={() => select(r)}
                  >
                    <span style={{ paddingLeft: 6 + r.depth * 13 }}>
                      {isWbs ? (
                        <>
                          <button
                            className="wbs-toggle"
                            onClick={(e) => {
                              e.stopPropagation();
                              useApp.getState().toggleCollapse(r.wbsPrefix || '');
                            }}
                          >
                            {r.collapsed ? '▸' : '▾'}
                          </button>
                          <b>WBS {r.wbsPrefix}</b>
                          {wbsNameOf(r.wbsPrefix || '', wbsNames) ? (
                            <span className="wbs-title" title={wbsLabel(r.wbsPrefix || '', wbsNames)}>
                              {wbsNameOf(r.wbsPrefix || '', wbsNames)}
                            </span>
                          ) : null}
                          <span className="muted">（{r.memberCount}）</span>
                        </>
                      ) : (
                        <span className="gantt-tname">
                          {r.task!.isMilestone ? '◆ ' : ''}
                          {r.task!.name || '（無題）'}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* 右ペイン: 時間軸（縦横スクロール・仮想化の親） */}
        <div
          className="gantt-right"
          ref={parentRef}
          onScroll={onScroll}
          data-testid="gantt-scroll"
          tabIndex={0}
          role="region"
          aria-label="ガントチャート（時間軸）"
        >
          <div className="gantt-axis" style={{ width: timelineW, height: HEAD_H }}>
            {ticks.map((t) => (
              <div key={t.off} className="gantt-tick" style={{ left: (t.off - originOff) * dayWidth }}>
                <span>{t.label}</span>
              </div>
            ))}
            {/* 基準日ライン（project.dataDate = オフセット0）。表示範囲内の時だけ見える */}
            <div className="gantt-today" style={{ left: (0 - originOff) * dayWidth }} title={'基準日（進捗の締め日） ' + dataDate} />
            {showData ? (
              <span
                className="gantt-flag data"
                style={{ left: (0 - originOff) * dayWidth }}
                title={'基準日（進捗の締め日） ' + dataDate}
              >
                {todayOff === 0 ? '基準日＝今日' : '基準日'}
              </span>
            ) : null}
            {showToday ? (
              <>
                <div className="gantt-now-axis" style={{ left: (todayOff - originOff) * dayWidth }} />
                <span className="gantt-flag now" style={{ left: (todayOff - originOff) * dayWidth }} title={'今日 ' + today}>
                  今日
                </span>
              </>
            ) : null}
          </div>

          <div className="gantt-body" style={{ height: totalSize, width: timelineW }}>
            {/* 月グリッド線 */}
            {ticks.map((t) => (
              <div key={t.off} className="gantt-grid" style={{ left: (t.off - originOff) * dayWidth }} />
            ))}
            {/* 基準日／今日の縦線（本体側・クリック透過） */}
            {showData ? <div className="gantt-vline data" style={{ left: (0 - originOff) * dayWidth }} /> : null}
            {showToday ? <div className="gantt-vline now" style={{ left: (todayOff - originOff) * dayWidth }} /> : null}
            {/* 依存矢印レイヤ（バーの下・表示中ペアのみ） */}
            {arrows.length ? (
              <svg className="gantt-deps" width={timelineW} height={totalSize}>
                <defs>
                  <marker id="gv-arrow" markerWidth="6" markerHeight="6" refX="4.6" refY="2.5" orient="auto">
                    <path d="M0,0 L5,2.5 L0,5 Z" fill="#cbd5e1" />
                  </marker>
                  <marker id="gv-arrow-c" markerWidth="6" markerHeight="6" refX="4.6" refY="2.5" orient="auto">
                    <path d="M0,0 L5,2.5 L0,5 Z" fill="#fca5a5" />
                  </marker>
                </defs>
                {arrows.map((a, i) => (
                  <path
                    key={i}
                    d={a.d}
                    className={'gantt-dep-line' + (a.crit ? ' crit' : '')}
                    markerEnd={`url(#${a.crit ? 'gv-arrow-c' : 'gv-arrow'})`}
                  />
                ))}
              </svg>
            ) : null}
            {virtualItems.map((vi) => {
              const r = rows[vi.index];
              if (!r) return null;
              return (
                <GanttBar
                  key={r.id}
                  row={r}
                  cpm={cpm.byTask.get(r.id) || null}
                  dataDate={dataDate}
                  dayWidth={dayWidth}
                  originOff={originOff}
                  top={vi.start}
                  selected={r.id === selId}
                  odd={vi.index % 2 === 1}
                  showBaseline={showBaseline}
                  wbsTitle={r.kind === 'wbs' ? wbsLabel(r.wbsPrefix || '', wbsNames) : ''}
                  onSelect={() => select(r)}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function GanttBar({
  row,
  cpm,
  dataDate,
  dayWidth,
  originOff,
  top,
  selected,
  odd,
  showBaseline,
  wbsTitle,
  onSelect,
}: {
  row: TableRow;
  cpm: CpmTaskResult | null;
  dataDate: string;
  dayWidth: number;
  originOff: number;
  top: number;
  selected: boolean;
  odd: boolean;
  showBaseline: boolean;
  wbsTitle: string;
  onSelect: () => void;
}) {
  // バー右端ドラッグで所要日数を編集（§9.3「閲覧＋duration変更」）。プレビュー中は暦日近似で伸縮し、
  // 確定で updateTask → CPM が稼働カレンダー込みで再計算し正しい暦日スパンへスナップする。
  const [drag, setDrag] = useState<{ startX: number; startDur: number; cur: number } | null>(null);
  const isWbs = row.kind === 'wbs';
  const task = isWbs ? undefined : row.task;
  let es: number | null = null;
  let ef: number | null = null;
  let critical = false;

  if (isWbs) {
    // WBSサマリバー: 集計済みの [ES, EF)（オフセット）。
    const span = wbsSpan(row, dataDate);
    if (span) {
      es = span[0];
      ef = span[1];
    }
    critical = !!row.hasCritical;
  } else if (cpm) {
    es = cpm.es;
    ef = cpm.ef;
    critical = cpm.isCritical;
  }
  // 完了＝実績で固定（くすませる）／着手済み＝進捗を塗る。
  const done = !!task && cpm?.state === 'done';
  const started = !!task && cpm?.state === 'started';

  // ベースライン（保存した計画）: バーの下に細い灰色バー（マイルストーンは小さな菱形）。WBS行は配下の範囲。
  const [bStart, bFinish] = rowBaseline(row);
  const base = showBaseline ? baselineSpan(bStart, bFinish, dataDate) : null;
  const baseEl = base ? (
    task && task.isMilestone ? (
      <div
        className="gantt-baseline ms"
        style={{ left: (base[0] - originOff) * dayWidth }}
        title={'ベースライン ' + bStart}
      />
    ) : (
      <div
        className={'gantt-baseline' + (isWbs ? ' summary' : '')}
        style={{ left: (base[0] - originOff) * dayWidth, width: Math.max(2, (base[1] - base[0]) * dayWidth) }}
        title={(isWbs ? 'WBS ベースライン ' : 'ベースライン ') + dateRange(bStart, bFinish)}
      />
    )
  ) : null;

  const rowEl = (children: React.ReactNode) => (
    <div
      className={'gantt-track' + (selected ? ' sel' : '') + (odd ? ' odd' : '')}
      style={{ transform: `translateY(${top}px)`, height: ROW_HEIGHT }}
      data-id={row.id}
      onClick={onSelect}
    >
      {baseEl}
      {children}
    </div>
  );

  if (es == null || ef == null) return rowEl(null);

  const x = (es - originOff) * dayWidth;

  if (task && task.isMilestone) {
    return rowEl(
      <div
        className={'gantt-ms' + (done ? ' done' : '') + (critical ? ' crit' : '')}
        style={{ left: x }}
        title={cpm ? barTitle(task, cpm) : task.name}
      />,
    );
  }

  const baseDur = task ? task.durationDays : 0;
  const w = drag
    ? Math.max(3, (ef - es + (drag.cur - baseDur)) * dayWidth) // プレビューは暦日近似で伸縮
    : Math.max(3, (ef - es) * dayWidth);
  const color = critical
    ? '#ef4444'
    : task
      ? DISC_COLOR[task.discipline] || DISC_COLOR.OTHER
      : '#64748b'; // WBSサマリは締まったスレート
  const progress = task ? task.progress : 0;
  const title =
    task && cpm
      ? barTitle(task, cpm)
      : `WBS ${wbsTitle || row.wbsPrefix}: ${row.esMin ?? addCalendarDays(dataDate, es)} 〜 ${row.efMax ?? addCalendarDays(dataDate, ef - 1)}`;

  return rowEl(
    <div
      className={
        'gantt-bar' +
        (isWbs ? ' summary' : '') +
        (critical ? ' crit' : '') +
        (done ? ' done' : '') +
        (started ? ' started' : '') +
        (drag ? ' dragging' : '')
      }
      style={{ left: x, width: w, background: color }}
      title={title}
    >
      {task && !done && progress > 0 ? <i className="gantt-prog" style={{ width: progress + '%' }} /> : null}
      {drag ? <span className="gantt-dur-tip">{drag.cur}d</span> : null}
      {/* 右端ハンドル: ドラッグで所要日数を変更（WBSサマリと完了タスクは実績固定のため不可） */}
      {task && !done ? (
        <div
          className="gantt-bar-handle"
          title="ドラッグで所要日数を変更"
          data-testid="gantt-bar-handle"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => {
            e.stopPropagation();
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            setDrag({ startX: e.clientX, startDur: task.durationDays, cur: task.durationDays });
          }}
          onPointerMove={(e) => {
            setDrag((d) => {
              if (!d) return d;
              const delta = Math.round((e.clientX - d.startX) / dayWidth);
              return { ...d, cur: Math.max(0, d.startDur + delta) };
            });
          }}
          onPointerUp={(e) => {
            (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
            if (drag && drag.cur !== drag.startDur) {
              useApp.getState().updateTask(row.id, { durationDays: drag.cur });
            }
            setDrag(null);
          }}
        />
      ) : null}
    </div>,
  );
}
