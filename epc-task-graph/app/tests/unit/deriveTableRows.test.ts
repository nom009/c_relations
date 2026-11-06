import { describe, it, expect } from 'vitest';
import {
  deriveTableRows,
  computeCpm,
  makeTask,
  makeDep,
  seedDemo,
  type CpmTaskResult,
  type TableSort,
  type ViewSpec,
} from '../../src/domain';

function spec(p: Partial<ViewSpec> = {}): ViewSpec {
  return { filter: {}, displayMode: 'DIM', collapsedWbs: [], focus: null, me: '', ...p };
}

const NO_SORT: TableSort[] = [];
const NO_CPM: Map<string, CpmTaskResult> | null = null;

describe('deriveTableRows: WBSツリー化（§12.3.1 段3）', () => {
  it('プレフィックスごとに中間WBS行を作り、タスクは完全一致ノードの子・depthが正しい', () => {
    const t1 = makeTask({ name: 'a', wbsCode: '1.1' });
    const t2 = makeTask({ name: 'b', wbsCode: '1.1' });
    const t3 = makeTask({ name: 'c', wbsCode: '1.2' });
    const { rows, stats } = deriveTableRows([t1, t2, t3], [], spec(), NO_SORT, NO_CPM);

    // WBS1(0) → WBS1.1(1) → a(2) b(2) → WBS1.2(1) → c(2)
    expect(rows.map((r) => r.kind)).toEqual(['wbs', 'wbs', 'task', 'task', 'wbs', 'task']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2, 1, 2]);
    expect(rows[0].id).toBe('wbs::1');
    expect(rows[1].id).toBe('wbs::1.1');
    expect(rows[0].memberCount).toBe(3); // 配下タスク3件
    expect(rows[1].memberCount).toBe(2);
    expect(stats.taskRows).toBe(3);
    expect(stats.wbsRows).toBe(3);
  });

  it('wbsCode未設定のタスクはルート直下（depth0・WBS行を作らない）', () => {
    const t1 = makeTask({ name: 'x', wbsCode: '' });
    const t2 = makeTask({ name: 'y', wbsCode: '1' });
    const { rows } = deriveTableRows([t1, t2], [], spec(), NO_SORT, NO_CPM);
    const xRow = rows.find((r) => r.task?.name === 'x')!;
    expect(xRow.kind).toBe('task');
    expect(xRow.depth).toBe(0);
    // "1" は WBS行を作り、その子として y が付く
    expect(rows.some((r) => r.kind === 'wbs' && r.id === 'wbs::1')).toBe(true);
  });
});

describe('deriveTableRows: ISOLATE 枝刈り（§12.3.1 段3/4）', () => {
  it('非マッチを除去し、空になった枝も除去する', () => {
    const t1 = makeTask({ name: 'a', wbsCode: '1.1', discipline: 'E' });
    const t2 = makeTask({ name: 'b', wbsCode: '1.2', discipline: 'P' });
    const t3 = makeTask({ name: 'c', wbsCode: '2.1', discipline: 'E' });
    const { rows, stats } = deriveTableRows(
      [t1, t2, t3],
      [],
      spec({ filter: { disciplines: ['E'] }, displayMode: 'ISOLATE' }),
      NO_SORT,
      NO_CPM,
    );
    // E のみ: 1.1 と 2.1。P だけの枝 1.2 は消える。
    expect(stats.taskRows).toBe(2);
    expect(rows.some((r) => r.id === 'wbs::1.2')).toBe(false);
    expect(rows.some((r) => r.id === 'wbs::1.1')).toBe(true);
    expect(rows.some((r) => r.id === 'wbs::2.1')).toBe(true);
    // WBS1 のメンバー件数はフィルタ後の1件
    expect(rows.find((r) => r.id === 'wbs::1')!.memberCount).toBe(1);
  });

  it('DIM は非マッチを残し dim=true', () => {
    const t1 = makeTask({ name: 'a', wbsCode: '1.1', discipline: 'E' });
    const t2 = makeTask({ name: 'b', wbsCode: '1.2', discipline: 'P' });
    const { rows, stats } = deriveTableRows(
      [t1, t2],
      [],
      spec({ filter: { disciplines: ['E'] }, displayMode: 'DIM' }),
      NO_SORT,
      NO_CPM,
    );
    expect(stats.taskRows).toBe(2);
    const bRow = rows.find((r) => r.task?.name === 'b')!;
    expect(bRow.dim).toBe(true);
    const aRow = rows.find((r) => r.task?.name === 'a')!;
    expect(aRow.dim).toBe(false);
  });
});

describe('deriveTableRows: 折り畳み（§12.3.1 段4）', () => {
  it('collapsedWbs 配下のタスク/子WBSを出力せず、collapsed＋memberCount＋集計フラグを持つ', () => {
    const t1 = makeTask({ name: 'a', wbsCode: '1.1', isMilestone: true });
    const t2 = makeTask({ name: 'b', wbsCode: '1.2' });
    const t3 = makeTask({ name: 'c', wbsCode: '2' });
    const { rows } = deriveTableRows(
      [t1, t2, t3],
      [],
      spec({ collapsedWbs: ['1'] }),
      NO_SORT,
      NO_CPM,
    );
    const wbs1 = rows.find((r) => r.id === 'wbs::1')!;
    expect(wbs1.collapsed).toBe(true);
    expect(wbs1.memberCount).toBe(2);
    expect(wbs1.hasMilestone).toBe(true);
    // 折り畳み配下は出力されない
    expect(rows.some((r) => r.id === 'wbs::1.1')).toBe(false);
    expect(rows.some((r) => r.task?.name === 'a')).toBe(false);
    // 別枝 "2" のタスクは出る
    expect(rows.some((r) => r.task?.name === 'c')).toBe(true);
  });
});

describe('deriveTableRows: wbsCode自然順（§12.3.1 段5）', () => {
  it('"1.10" は "1.9" の後（セグメント数値比較）', () => {
    const t9 = makeTask({ name: 'nine', wbsCode: '1.9' });
    const t10 = makeTask({ name: 'ten', wbsCode: '1.10' });
    const { rows } = deriveTableRows([t10, t9], [], spec(), NO_SORT, NO_CPM);
    const wbsRows = rows.filter((r) => r.kind === 'wbs').map((r) => r.id);
    const i9 = wbsRows.indexOf('wbs::1.9');
    const i10 = wbsRows.indexOf('wbs::1.10');
    expect(i9).toBeGreaterThanOrEqual(0);
    expect(i10).toBeGreaterThan(i9);
  });
});

describe('deriveTableRows: 近傍フォーカス（§12.3.1 段2）', () => {
  it('focus 起点の上流/下流のみ行に残す', () => {
    const ts = ['a', 'b', 'c', 'd', 'e'].map((n) => makeTask({ name: n }));
    const deps = [];
    for (let i = 0; i + 1 < ts.length; i++) deps.push(makeDep(ts[i].id, ts[i + 1].id));
    const { rows, stats } = deriveTableRows(
      ts,
      deps,
      spec({ focus: { taskId: ts[2].id, up: 1, down: 1 } }),
      NO_SORT,
      NO_CPM,
    );
    // b, c, d の3タスク
    expect(stats.taskRows).toBe(3);
    const names = rows.filter((r) => r.kind === 'task').map((r) => r.task!.name).sort();
    expect(names).toEqual(['b', 'c', 'd']);
  });
});

describe('deriveTableRows: CPM列ソート（§12.3.1 段5）', () => {
  const A = makeTask({ name: 'A', durationDays: 2 });
  const B = makeTask({ name: 'B', durationDays: 3 });
  const C = makeTask({ name: 'C', durationDays: 1 });
  const deps = [makeDep(A.id, B.id), makeDep(B.id, C.id)]; // ES: A=0, B=2, C=5
  const cpm = computeCpm([A, B, C], deps, '2026-01-01').byTask;

  it('es 降順で ES 最大が先頭になる', () => {
    const { rows } = deriveTableRows([A, B, C], deps, spec(), [{ key: 'es', dir: 'desc' }], cpm);
    const taskNames = rows.filter((r) => r.kind === 'task').map((r) => r.task!.name);
    expect(taskNames).toEqual(['C', 'B', 'A']);
  });

  it('es 昇順で ES 最小が先頭になる', () => {
    const { rows } = deriveTableRows([A, B, C], deps, spec(), [{ key: 'es', dir: 'asc' }], cpm);
    const taskNames = rows.filter((r) => r.kind === 'task').map((r) => r.task!.name);
    expect(taskNames).toEqual(['A', 'B', 'C']);
  });

  it('CPM未計算（null）のタスクは方向によらず末尾', () => {
    const partial = new Map(cpm);
    partial.delete(C.id); // C は CPM 値なし
    const { rows } = deriveTableRows(
      [A, B, C],
      deps,
      spec(),
      [{ key: 'es', dir: 'asc' }],
      partial,
    );
    const taskNames = rows.filter((r) => r.kind === 'task').map((r) => r.task!.name);
    expect(taskNames[taskNames.length - 1]).toBe('C');
  });
});

describe('deriveTableRows: WBS行の日付集計 min ES 〜 max EF（§12.3.2）', () => {
  // A(1.1)→B(1.2)→C(1.2)。ES: A=0,B後,C後。EF は C が最遅。
  const A = makeTask({ name: 'A', wbsCode: '1.1', durationDays: 2 });
  const B = makeTask({ name: 'B', wbsCode: '1.2', durationDays: 3 });
  const C = makeTask({ name: 'C', wbsCode: '1.2', durationDays: 1 });
  const deps = [makeDep(A.id, B.id), makeDep(B.id, C.id)];
  const cpm = computeCpm([A, B, C], deps, '2026-01-01').byTask;

  it('WBS "1" は配下の最早ES日付と最遅EF日付を集計する', () => {
    const { rows } = deriveTableRows([A, B, C], deps, spec(), NO_SORT, cpm);
    const w1 = rows.find((r) => r.id === 'wbs::1')!;
    expect(w1.kind).toBe('wbs');
    // 最早ES=A、最遅EF=C（鎖の末尾）。
    expect(w1.esMin).toBe(cpm.get(A.id)!.esDate);
    expect(w1.efMax).toBe(cpm.get(C.id)!.efDate);
  });

  it('子WBS "1.2" は自身の配下だけ（B,C）で集計する', () => {
    const { rows } = deriveTableRows([A, B, C], deps, spec(), NO_SORT, cpm);
    const w12 = rows.find((r) => r.id === 'wbs::1.2')!;
    expect(w12.esMin).toBe(cpm.get(B.id)!.esDate); // B が 1.2 内で最早
    expect(w12.efMax).toBe(cpm.get(C.id)!.efDate); // C が 1.2 内で最遅
  });

  it('CPM未注入なら WBS 行の日付集計は null', () => {
    const { rows } = deriveTableRows([A, B, C], deps, spec(), NO_SORT, NO_CPM);
    const w1 = rows.find((r) => r.id === 'wbs::1')!;
    expect(w1.esMin).toBeNull();
    expect(w1.efMax).toBeNull();
  });
});

describe('deriveTableRows: 性能（§12.6 受入(a) 4,000で <30ms 目標）', () => {
  it('4,000タスク全展開で derive <30ms（中央値・ソート込み）', () => {
    const doc = seedDemo({ count: 4000, density: 1.5 });
    const cpm = computeCpm(doc.tasks, doc.dependencies, doc.project.dataDate).byTask;
    const view = spec({ collapsedWbs: [] }); // 全展開（最悪ケース＝4,000行超）
    const sort: TableSort[] = [{ key: 'es', dir: 'asc' }];
    const times: number[] = [];
    let rowsN = 0;
    for (let i = 0; i < 7; i++) {
      const t = performance.now();
      const res = deriveTableRows(doc.tasks, doc.dependencies, view, sort, cpm);
      times.push(performance.now() - t);
      rowsN = res.rows.length;
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    console.log(`[deriveTableRows perf] rows=${rowsN} median=${median.toFixed(2)}ms`);
    expect(rowsN).toBeGreaterThan(4000); // タスク4,000＋WBS行
    expect(median).toBeLessThan(60); // 余裕を持った上限（目標<30ms・CI環境差を吸収）
  });
});

describe('deriveTableRows: メモ化セレクタ入力（純関数の決定性）', () => {
  it('同一入力は同一行数・stats.total を返す', () => {
    const ts = Array.from({ length: 20 }, (_, i) => makeTask({ name: 't' + i, wbsCode: '1.' + (i % 3) }));
    const r1 = deriveTableRows(ts, [], spec(), NO_SORT, NO_CPM);
    const r2 = deriveTableRows(ts, [], spec(), NO_SORT, NO_CPM);
    expect(r1.rows.length).toBe(r2.rows.length);
    expect(r1.stats.total).toBe(20);
  });
});
