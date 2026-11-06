import { describe, it, expect } from 'vitest';
import { toMspdi, fromMspdi, makeTask, makeDep, emptyDoc, computeCpm, type GraphDoc } from '../../src/domain';

function docWith(tasks: ReturnType<typeof makeTask>[], deps: ReturnType<typeof makeDep>[]): GraphDoc {
  const d = emptyDoc('T');
  d.tasks = tasks;
  d.dependencies = deps;
  return d;
}

describe('MSPDI 往復（§8 / Phase5 下ごしらえ）', () => {
  const A = makeTask({ id: 'A', name: '設計', wbsCode: '1.1', durationDays: 4 });
  const B = makeTask({ id: 'B', name: '調達', wbsCode: '1.2', durationDays: 3 });
  const M = makeTask({ id: 'M', name: '着工', wbsCode: '1.3', isMilestone: true });
  const deps = [
    makeDep('A', 'B', { id: 'd1', type: 'FS', lagDays: 2 }),
    makeDep('A', 'M', { id: 'd2', type: 'SS', lagDays: 0 }),
  ];
  const doc = docWith([A, B, M], deps);

  it('toMspdi→fromMspdi でタスク（名前/WBS/所要/マイルストーン）が保たれる', () => {
    const r = fromMspdi(toMspdi(doc));
    expect(r.tasks.length).toBe(3);
    const byName = new Map(r.tasks.map((t) => [t.name, t]));
    expect(byName.get('設計')!.wbsCode).toBe('1.1');
    expect(byName.get('設計')!.durationDays).toBe(4);
    expect(byName.get('調達')!.durationDays).toBe(3);
    expect(byName.get('着工')!.isMilestone).toBe(true);
    expect(byName.get('着工')!.durationDays).toBe(0);
  });

  it('依存タイプ・ラグが保たれる（FS+lag2 / SS）', () => {
    const r = fromMspdi(toMspdi(doc));
    const idToName = new Map(r.tasks.map((t) => [t.id, t.name]));
    const named = r.dependencies.map((d) => ({
      p: idToName.get(d.predecessorId),
      s: idToName.get(d.successorId),
      type: d.type,
      lag: d.lagDays,
    }));
    expect(named).toContainEqual({ p: '設計', s: '調達', type: 'FS', lag: 2 });
    expect(named).toContainEqual({ p: '設計', s: '着工', type: 'SS', lag: 0 });
  });

  it('MS Project 由来の要約タスク(Summary=1)は取り込まない・所要はh/8で日換算', () => {
    const xml = `<?xml version="1.0"?><Project><Tasks>
      <Task><UID>1</UID><Name>WBS1</Name><Summary>1</Summary><OutlineLevel>1</OutlineLevel></Task>
      <Task><UID>2</UID><Name>実作業</Name><WBS>1.1</WBS><Duration>PT16H0M0S</Duration><Milestone>0</Milestone></Task>
    </Tasks></Project>`;
    const r = fromMspdi(xml);
    expect(r.tasks.length).toBe(1);
    expect(r.tasks[0].name).toBe('実作業');
    expect(r.tasks[0].durationDays).toBe(2); // 16h / 8 = 2日
  });

  it('Start/Finish: Finish は最終作業日（CPM の排他的 EF の前日）、マイルストーンは Start と同日', () => {
    const cpm = computeCpm(doc.tasks, doc.dependencies, '2026-01-05', null);
    const xml = toMspdi(doc, cpm);
    const block = (uid: number) => new RegExp(`<UID>${uid}</UID>[\\s\\S]*?</Task>`).exec(xml)![0];
    // A: 4日 → 1/5〜1/8 の最終作業日は 1/8
    expect(block(1)).toContain('<Start>2026-01-05T08:00:00</Start>');
    expect(block(1)).toContain('<Finish>2026-01-08T17:00:00</Finish>');
    // 着工(マイルストーン): Start と同日
    const m = block(3);
    expect(m.match(/<Start>(\d{4}-\d{2}-\d{2})/)![1]).toBe(m.match(/<Finish>(\d{4}-\d{2}-\d{2})/)![1]);
  });

  it('属性付きタグ・CDATA・数値文字参照・同一ペアの重複リンクを取り込める', () => {
    const xml = `<Project><Tasks>
      <Task xmlns="x"><UID>1</UID><Name><![CDATA[A & B]]></Name><Duration>PT8H0M0S</Duration></Task>
      <Task><UID>2</UID><Name>&#x30C6;&#12473;&#12488;</Name><Duration>PT8H0M0S</Duration>
        <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type></PredecessorLink>
        <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>3</Type></PredecessorLink>
      </Task>
    </Tasks></Project>`;
    const r = fromMspdi(xml);
    expect(r.tasks.map((t) => t.name)).toEqual(['A & B', 'テスト']);
    expect(r.dependencies.length).toBe(1);
    expect(r.dependencies[0].type).toBe('FS');
  });

  it('XMLエスケープ: 名前の & < > が往復で壊れない', () => {
    const t = makeTask({ id: 'X', name: 'A&B <試験>', wbsCode: '2', durationDays: 1 });
    const r = fromMspdi(toMspdi(docWith([t], [])));
    expect(r.tasks[0].name).toBe('A&B <試験>');
  });
});
