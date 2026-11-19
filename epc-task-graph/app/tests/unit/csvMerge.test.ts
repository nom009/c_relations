import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { emptyDoc, fromCsv, makeDep, makeTask, planCsvMerge, toCsv } from '../../src/domain';

const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  save: vi.fn(),
  load: vi.fn(),
  duplicate: vi.fn(),
  list: vi.fn(),
}));
vi.mock('../../src/store/persistence', () => ({
  getRepo: () => ({
    saveGraph: mocks.save,
    loadGraph: mocks.load,
    duplicateProject: mocks.duplicate,
    listProjects: mocks.list,
  }),
  getCurrentProjectId: () => null,
  setCurrentProjectId: vi.fn(),
  persistPatch: mocks.patch,
}));
vi.mock('../../src/layout/layout', () => ({
  runFullLayout: vi.fn(async () => ({})),
}));
import { useApp, flushPersistence } from '../../src/store/store';

// 現在のプロジェクト: A(1) → B(1) →SS+2→ C(2)。WBS「1」は A/B で共有。
const base = () => {
  const a = makeTask({ id: 'a', name: 'A', wbsCode: '1', durationDays: 3, position: { x: 10, y: 20 }, rev: 4 });
  const b = makeTask({ id: 'b', name: 'B', wbsCode: '1', durationDays: 4, assignee: '設計課' });
  const c = makeTask({ id: 'c', name: 'C', wbsCode: '2', durationDays: 5 });
  return {
    tasks: [a, b, c],
    dependencies: [makeDep('a', 'b', { id: 'ab' }), makeDep('b', 'c', { id: 'bc', type: 'SS', lagDays: 2 })],
  };
};
// B を更新、C を削除（CSV に無い）、新規行を追加。所要日数以外の列（担当など）は CSV に無い。
const UPDATE_CSV = [
  'No,WBS,タスク名,所要日数,先行タスク,ID',
  '1,1,A,3,,a',
  '2,1,B改,6,1FS+1,b',
  '3,3,新規,2,2,',
].join('\n');

describe('planCsvMerge', () => {
  it('書き出した CSV をそのまま反映すると変更なし（同じ参照を保つ）', () => {
    const cur = base();
    const plan = planCsvMerge(cur, fromCsv(toCsv(cur.tasks, cur.dependencies)));
    expect(plan.summary).toEqual({
      added: 0,
      updated: 0,
      unchanged: 3,
      removed: 0,
      depsAdded: 0,
      depsRemoved: 0,
      depsKept: 2,
      depsUpdated: 0,
    });
    plan.tasks.forEach((t, i) => expect(t).toBe(cur.tasks[i]));
    plan.dependencies.forEach((d, i) => expect(d).toBe(cur.dependencies[i]));
  });

  it('ID で突き合わせ、更新・追加・削除と依存の差分を数える', () => {
    const cur = base();
    const imp = fromCsv(UPDATE_CSV);
    expect(imp.errors).toEqual([]);
    const plan = planCsvMerge(cur, imp);
    expect(plan.summary).toEqual({
      added: 1,
      updated: 1,
      unchanged: 1,
      removed: 1,
      depsAdded: 1,
      depsRemoved: 1,
      depsKept: 1,
      depsUpdated: 1,
    });
    const [a, b, n] = plan.tasks;
    expect(a).toBe(cur.tasks[0]);
    expect([b.id, b.name, b.durationDays, b.rev]).toEqual(['b', 'B改', 6, cur.tasks[1].rev]);
    // CSV に列が無い項目（担当）は既存値を保つ
    expect(b.assignee).toBe('設計課');
    expect(plan.addedIds).toEqual([n.id]);
    expect(n.id).not.toBe(imp.tasks[2].id);
    expect(n.position).toEqual({ x: 0, y: 0 });
    expect(plan.removedTasks.map((t) => t.id)).toEqual(['c']);
    expect(plan.removedDepIds).toEqual(['bc']);
    const ab = plan.dependencies.find((d) => d.id === 'ab')!;
    expect([ab.predecessorId, ab.successorId, ab.type, ab.lagDays]).toEqual(['a', 'b', 'FS', 1]);
    expect(plan.dependencies.some((d) => d.predecessorId === 'b' && d.successorId === n.id)).toBe(true);
  });

  it('現在のプロジェクトに無い ID の行は、新しい ID で追加する', () => {
    const cur = base();
    const plan = planCsvMerge(cur, fromCsv(['WBS,タスク名,所要日数,ID', '1,A,3,a', '9,X,1,zzz'].join('\n')));
    expect(plan.summary).toMatchObject({ added: 1, unchanged: 1, removed: 2 });
    expect(plan.addedIds[0]).not.toBe('zzz');
  });

  it('先行タスク列・所要日数列が無ければ、既存の依存と日数を保つ', () => {
    const cur = base();
    const imp = fromCsv(['WBS,タスク名,ID', '1,A,a', '1,B,b', '2,C,c'].join('\n'));
    expect(imp.errors).toEqual([]);
    expect(imp.hasPredecessors).toBe(false);
    const plan = planCsvMerge(cur, imp);
    expect(plan.summary).toMatchObject({ updated: 0, unchanged: 3, depsAdded: 0, depsRemoved: 0, depsKept: 2 });
    expect(plan.dependencies).toEqual(cur.dependencies);
    expect(plan.tasks.map((t) => t.durationDays)).toEqual([3, 4, 5]);
  });

  it('ステータス列だけを更新すると、進捗を編集時と同じ規則で整える', () => {
    const cur = base();
    cur.tasks[0] = { ...cur.tasks[0], status: 'IN_PROGRESS', progress: 40 };
    const plan = planCsvMerge(cur, fromCsv(['WBS,タスク名,ステータス,ID', '1,A,完了,a', '1,B,未着手,b', '2,C,,c'].join('\n')));
    expect(plan.summary).toMatchObject({ updated: 1, unchanged: 2 });
    expect([plan.tasks[0].status, plan.tasks[0].progress]).toEqual(['DONE', 100]);
  });
});

describe('applyCsvMerge（store）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.patch.mockReset().mockResolvedValue({ ok: true });
    mocks.save.mockReset().mockResolvedValue(undefined);
    mocks.list.mockReset().mockResolvedValue([]);
    const cur = base();
    useApp
      .getState()
      .loadDoc({ ...emptyDoc('csv'), tasks: cur.tasks, dependencies: cur.dependencies }, { persist: false });
    useApp.setState({
      dirty: {
        tasks: new Set<string>(),
        deps: new Set<string>(),
        deletedTasks: new Set<string>(),
        deletedDeps: new Set<string>(),
      },
      saveStatus: 'saved',
    });
  });
  afterEach(async () => {
    useApp.setState({ role: null });
    await flushPersistence().catch(() => {});
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('1回の操作（1 Undo）で反映し、変わった行だけ rev を上げてダーティにする', () => {
    const s0 = useApp.getState();
    const plan = planCsvMerge({ tasks: s0.tasks, dependencies: s0.dependencies }, fromCsv(UPDATE_CSV));
    const added = plan.addedIds[0];
    useApp.getState().applyCsvMerge(plan);
    const s1 = useApp.getState();
    expect(s1.tasks.map((t) => t.name)).toEqual(['A', 'B改', '新規']);
    expect(s1.tasks[0]).toBe(s0.tasks[0]);
    expect(s1.tasks[1].rev).toBe(s0.tasks[1].rev + 1);
    expect(s1.tasks[1].position).toEqual(s0.tasks[1].position);
    expect([...s1.dirty.tasks].sort()).toEqual(['b', added].sort());
    expect([...s1.dirty.deletedTasks]).toEqual(['c']);
    expect([...s1.dirty.deletedDeps]).toEqual(['bc']);
    expect(s1.dirty.deps.has('ab')).toBe(true);
    expect(s1.dependencies.length).toBe(2);
    expect(useApp.temporal.getState().pastStates.length).toBe(1);

    useApp.getState().undo();
    const s2 = useApp.getState();
    expect(s2.tasks.map((t) => t.id)).toEqual(s0.tasks.map((t) => t.id));
    expect(s2.dependencies.map((d) => d.id)).toEqual(s0.dependencies.map((d) => d.id));
    expect(s2.dirty.deletedTasks.has(added)).toBe(true);
    expect(s2.dirty.tasks.has('c')).toBe(true);
  });

  it('閲覧のみ（viewer）では何も変えない', () => {
    const s0 = useApp.getState();
    const plan = planCsvMerge({ tasks: s0.tasks, dependencies: s0.dependencies }, fromCsv(UPDATE_CSV));
    useApp.setState({ role: 'viewer' });
    useApp.getState().applyCsvMerge(plan);
    expect(useApp.getState().tasks).toBe(s0.tasks);
  });
});
