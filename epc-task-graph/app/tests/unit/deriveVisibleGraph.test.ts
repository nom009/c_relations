import { describe, it, expect } from 'vitest';
import {
  deriveVisibleGraph,
  makeTask,
  makeDep,
  collapsedForLevel,
  type ViewSpec,
} from '../../src/domain';

function spec(p: Partial<ViewSpec> = {}): ViewSpec {
  return { filter: {}, displayMode: 'DIM', collapsedWbs: [], focus: null, me: '', ...p };
}

describe('deriveVisibleGraph: フィルタ ISOLATE 後の可視数（§2.6 段1）', () => {
  const tasks = [
    makeTask({ name: 'a', wbsCode: '1.1', discipline: 'E', assignee: '設計1課' }),
    makeTask({ name: 'b', wbsCode: '1.2', discipline: 'P', assignee: '調達課' }),
    makeTask({ name: 'c', wbsCode: '1.3', discipline: 'C', assignee: '施工管理課' }),
    makeTask({ name: 'd', wbsCode: '1.4', discipline: 'E', assignee: '設計1課' }),
  ];
  const deps = [makeDep(tasks[0].id, tasks[1].id), makeDep(tasks[1].id, tasks[2].id)];

  it('ISOLATE は非マッチを描画対象から除去する', () => {
    const res = deriveVisibleGraph(
      tasks,
      deps,
      spec({ filter: { disciplines: ['E'] }, displayMode: 'ISOLATE' }),
    );
    expect(res.stats.visible).toBe(2); // E は a,d の2件
    expect(res.stats.matched).toBe(2);
    expect(res.visibleNodes.every((n) => n.kind === 'task')).toBe(true);
  });

  it('DIM は非マッチを残し dim フラグを付ける', () => {
    const res = deriveVisibleGraph(
      tasks,
      deps,
      spec({ filter: { disciplines: ['E'] }, displayMode: 'DIM' }),
    );
    expect(res.stats.visible).toBe(4); // 全件残る
    const dimmed = res.visibleNodes.filter((n) => n.kind === 'task' && n.dim);
    expect(dimmed.length).toBe(2); // b,c が減光
  });

  it('フィルタ非アクティブなら全件表示', () => {
    const res = deriveVisibleGraph(tasks, deps, spec());
    expect(res.stats.visible).toBe(4);
    expect(res.stats.matched).toBe(4);
  });
});

describe('deriveVisibleGraph: WBS折り畳み集約（§2.7）', () => {
  it('折り畳みプレフィックス配下を1個の集約ノードへ置換し境界跨ぎ依存を集約エッジ化', () => {
    const tasks = [
      makeTask({ name: 'x1', wbsCode: '1.1' }),
      makeTask({ name: 'x2', wbsCode: '1.1' }),
      makeTask({ name: 'y1', wbsCode: '2.1' }),
    ];
    const deps = [
      makeDep(tasks[0].id, tasks[1].id), // 1.1 内部
      makeDep(tasks[1].id, tasks[2].id), // 1.1 → 2.1 境界跨ぎ
    ];
    const res = deriveVisibleGraph(tasks, deps, spec({ collapsedWbs: ['1'] }));
    const agg = res.visibleNodes.filter((n) => n.kind === 'aggregate');
    expect(agg.length).toBe(1);
    expect(agg[0].kind === 'aggregate' && agg[0].count).toBe(2); // 1.1 の2件を集約
    // 内部エッジは集約内に隠れ、境界跨ぎ1本だけが集約エッジとして残る
    const aggEdges = res.visibleEdges.filter((e) => e.aggregate);
    expect(aggEdges.length).toBe(1);
    expect(res.visibleEdges.length).toBe(1);
  });

  it('collapsedForLevel はレベルを超える枝だけを折り畳む', () => {
    const tasks = [
      makeTask({ wbsCode: '1.1.1' }),
      makeTask({ wbsCode: '1.2.3' }),
      makeTask({ wbsCode: '2' }),
    ];
    const collapsed = collapsedForLevel(tasks, 2);
    expect(collapsed.sort()).toEqual(['1.1', '1.2']); // "2" は深さ1なので折り畳まれない
  });
});

describe('deriveVisibleGraph: 近傍フォーカス（§2.9）', () => {
  it('フォーカス起点の上流/下流のみ表示し、起点フラグが立つ', () => {
    const tasks = ['a', 'b', 'c', 'd', 'e'].map((n) => makeTask({ name: n }));
    const deps = [];
    for (let i = 0; i + 1 < tasks.length; i++) deps.push(makeDep(tasks[i].id, tasks[i + 1].id));
    const res = deriveVisibleGraph(
      tasks,
      deps,
      spec({ focus: { taskId: tasks[2].id, up: 1, down: 1 } }),
    );
    // b,c,d の3タスク（continuation 集約が別途付くことがある）
    const taskNodes = res.visibleNodes.filter((n) => n.kind === 'task');
    expect(taskNodes.length).toBe(3);
    const origin = taskNodes.find((n) => n.kind === 'task' && n.isOrigin);
    expect(origin && origin.id).toBe(tasks[2].id);
  });

  it('深さ境界の先に続く経路は continuation 集約ノードで表示', () => {
    const tasks = ['a', 'b', 'c', 'd', 'e'].map((n) => makeTask({ name: n, wbsCode: '1.1' }));
    const deps = [];
    for (let i = 0; i + 1 < tasks.length; i++) deps.push(makeDep(tasks[i].id, tasks[i + 1].id));
    const res = deriveVisibleGraph(
      tasks,
      deps,
      spec({ focus: { taskId: tasks[2].id, up: 1, down: 1 } }),
    );
    const cont = res.visibleNodes.filter((n) => n.kind === 'aggregate' && n.continuation);
    // a（上流2階層先）と e（下流2階層先）が continuation として現れる
    expect(cont.length).toBeGreaterThanOrEqual(1);
  });
});

describe('deriveVisibleGraph: 関係ハイライト（focus mode=highlight・§2.9 ユーザー要望）', () => {
  // 近傍の鎖 A→B→C→D→E（WBS 1.1）と、無関係な別WBS 2.1 のノード群。
  const near = ['A', 'B', 'C', 'D', 'E'].map((n) => makeTask({ name: n, wbsCode: '1.1' }));
  const far = ['X', 'Y', 'Z'].map((n) => makeTask({ name: n, wbsCode: '2.1' }));
  const tasks = [...near, ...far];
  const deps: ReturnType<typeof makeDep>[] = [];
  for (let i = 0; i + 1 < near.length; i++) deps.push(makeDep(near[i].id, near[i + 1].id));

  it('highlight は非近傍を残し（隠さず）、近傍に related+世代タグを付ける', () => {
    const res = deriveVisibleGraph(
      tasks,
      deps,
      spec({
        focus: { taskId: near[2].id, up: 1, down: 1, mode: 'highlight' },
        collapsedWbs: collapsedForLevel(tasks, 1), // 別WBS(2)は畳まれた状態（近傍の 1 は自動展開）
      }),
    );
    // 非近傍（別WBS 2.1）は隠れず、集約ノードとして文脈に残る。
    expect(res.visibleNodes.some((n) => n.kind === 'aggregate')).toBe(true);
    const taskNodes = res.visibleNodes.filter((n) => n.kind === 'task');
    const origin = taskNodes.find((n) => n.kind === 'task' && n.isOrigin);
    expect(origin && (origin as any).related).toBe(true);
    expect(origin && (origin as any).gen).toBe(0);
    // 近傍タスク（B,C,D）は related=true、それ以外の実タスクは dim。
    const b = taskNodes.find((n) => n.id === near[1].id) as any;
    expect(b.related).toBe(true);
    expect(b.gen).toBe(-1);
  });

  it('highlight では continuation 集約を作らない（非近傍は実ノードで描かれるため）', () => {
    const res = deriveVisibleGraph(
      tasks,
      deps,
      spec({ focus: { taskId: near[2].id, up: 1, down: 1, mode: 'highlight' } }),
    );
    expect(res.visibleNodes.some((n) => n.kind === 'aggregate' && n.continuation)).toBe(false);
  });

  it('isolate（既定）は非近傍を除去する', () => {
    const res = deriveVisibleGraph(
      tasks,
      deps,
      spec({ focus: { taskId: near[2].id, up: 1, down: 1, mode: 'isolate' } }),
    );
    // 別WBSのタスクは描画対象に出ない（集約含め near の近傍のみ）。
    const ids = new Set(res.visibleNodes.map((n) => n.id));
    expect(ids.has(far[0].id)).toBe(false);
  });
});

describe('deriveVisibleGraph: 担当＋前後ビュー（boundary・§2.9拡張）', () => {
  // A→B→C→D→E。担当フィルタで C だけ一致させ、前後1世代（B,D）を文脈表示する。
  const t = ['A', 'B', 'C', 'D', 'E'].map((n) =>
    makeTask({ name: n, wbsCode: '1', assignee: n === 'C' ? '自部署' : '他部署' }),
  );
  const deps: ReturnType<typeof makeDep>[] = [];
  for (let i = 0; i + 1 < t.length; i++) deps.push(makeDep(t[i].id, t[i + 1].id));

  it('ISOLATE＋担当フィルタ＋前後1 で 一致(C)＋受け渡し先(B,D) が残り、B/D は outside 文脈', () => {
    const res = deriveVisibleGraph(
      t,
      deps,
      spec({ filter: { assignees: ['自部署'] }, displayMode: 'ISOLATE', boundaryUp: 1, boundaryDown: 1 }),
    );
    const taskNodes = res.visibleNodes.filter((n) => n.kind === 'task');
    const byName = new Map(taskNodes.map((n) => [n.task.name, n]));
    expect([...byName.keys()].sort()).toEqual(['B', 'C', 'D']); // A,E は範囲外
    expect((byName.get('C') as any).outside).toBe(false); // 一致＝主役
    expect((byName.get('B') as any).outside).toBe(true); // 前の受け渡し先＝文脈
    expect((byName.get('D') as any).outside).toBe(true); // 後の受け渡し先＝文脈
  });

  it('boundary=0 なら従来どおり一致タスクのみ（受け渡し先は出ない）', () => {
    const res = deriveVisibleGraph(
      t,
      deps,
      spec({ filter: { assignees: ['自部署'] }, displayMode: 'ISOLATE', boundaryUp: 0, boundaryDown: 0 }),
    );
    const names = res.visibleNodes.filter((n) => n.kind === 'task').map((n) => n.task.name);
    expect(names).toEqual(['C']);
  });
});
