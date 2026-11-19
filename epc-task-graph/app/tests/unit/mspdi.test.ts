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

describe('MSPDI 進捗（実績・進捗率）とベースライン', () => {
  // makeTask は実績・ベースラインを引き継がないため、後から展開して付与する。
  const done = {
    ...makeTask({ id: 'A', name: '設計', wbsCode: '1.1', durationDays: 4, status: 'DONE', progress: 100 }),
    actualStart: '2026-01-05',
    actualFinish: '2026-01-09',
    baselineStart: '2026-01-05',
    baselineFinish: '2026-01-08',
  };
  const wip = {
    ...makeTask({ id: 'B', name: '調達', wbsCode: '1.2', durationDays: 5, status: 'IN_PROGRESS', progress: 40 }),
    actualStart: '2026-01-12',
    baselineStart: '2026-01-09',
    baselineFinish: '2026-01-15',
  };
  const todo = makeTask({ id: 'C', name: '工事', wbsCode: '1.3', durationDays: 3 });
  const doc = docWith([done, wip, todo], [makeDep('A', 'B', { id: 'd1' }), makeDep('B', 'C', { id: 'd2' })]);
  const block = (xml: string, uid: number) => new RegExp(`<UID>${uid}</UID>[\\s\\S]*?</Task>`).exec(xml)![0];

  it('実績開始/完了・進捗率・ベースライン0 を書き出す（無いものは出さない）', () => {
    const xml = toMspdi(doc);
    const a = block(xml, 1);
    expect(a).toContain('<PercentComplete>100</PercentComplete>');
    expect(a).toContain('<ActualStart>2026-01-05T08:00:00</ActualStart>');
    expect(a).toContain('<ActualFinish>2026-01-09T17:00:00</ActualFinish>');
    expect(a).toMatch(
      /<Baseline>\s*<Number>0<\/Number>\s*<Start>2026-01-05T08:00:00<\/Start>\s*<Finish>2026-01-08T17:00:00<\/Finish>\s*<\/Baseline>/,
    );
    const b = block(xml, 2);
    expect(b).toContain('<PercentComplete>40</PercentComplete>');
    expect(b).not.toContain('<ActualFinish>');
    const c = block(xml, 3);
    expect(c).toContain('<PercentComplete>0</PercentComplete>');
    expect(c).not.toContain('<ActualStart>');
    expect(c).not.toContain('<Baseline>');
  });

  it('CPM 付き: 完了タスクの Start/Finish は実績、着手済みは残作業の終了日', () => {
    const cpm = computeCpm(doc.tasks, doc.dependencies, '2026-01-12', null);
    const xml = toMspdi(doc, cpm);
    expect(block(xml, 1)).toContain('<Start>2026-01-05T08:00:00</Start>\n      <Finish>2026-01-09T17:00:00</Finish>');
    // 調達: 5日×残60% = 3日 → 1/12〜1/14
    expect(block(xml, 2)).toContain('<Start>2026-01-12T08:00:00</Start>\n      <Finish>2026-01-14T17:00:00</Finish>');
  });

  it('往復で状態・進捗・実績・ベースラインが保たれる', () => {
    const r = fromMspdi(toMspdi(doc));
    const byName = new Map(r.tasks.map((t) => [t.name, t]));
    expect(byName.get('設計')).toMatchObject({
      status: 'DONE',
      progress: 100,
      durationDays: 4,
      actualStart: '2026-01-05',
      actualFinish: '2026-01-09',
      baselineStart: '2026-01-05',
      baselineFinish: '2026-01-08',
    });
    expect(byName.get('調達')).toMatchObject({
      status: 'IN_PROGRESS',
      progress: 40,
      actualStart: '2026-01-12',
      baselineStart: '2026-01-09',
      baselineFinish: '2026-01-15',
    });
    expect(byName.get('調達')!.actualFinish ?? null).toBeNull();
    const c = byName.get('工事')!;
    expect(c).toMatchObject({ status: 'NOT_STARTED', progress: 0 });
    expect(c.actualStart ?? null).toBeNull();
    expect(c.baselineStart ?? null).toBeNull();
  });

  it('MS Project 形式: PercentComplete から状態を決め、Baseline は番号0だけを読む', () => {
    const xml = `<Project><Tasks>
      <Task><UID>1</UID><Name>A</Name><Duration>PT40H0M0S</Duration><PercentComplete>100</PercentComplete>
        <Baseline><Number>1</Number><Start>2025-12-01T08:00:00</Start><Finish>2025-12-05T17:00:00</Finish></Baseline>
        <Baseline><Number>0</Number><Start>2026-01-05T08:00:00</Start><Finish>2026-01-09T17:00:00</Finish></Baseline>
      </Task>
      <Task><UID>2</UID><Name>B</Name><Duration>PT16H0M0S</Duration><PercentComplete>50</PercentComplete></Task>
      <Task><UID>3</UID><Name>C</Name><Duration>PT8H0M0S</Duration><PercentComplete>0</PercentComplete></Task>
    </Tasks></Project>`;
    const [a, b, c] = fromMspdi(xml).tasks;
    expect(a).toMatchObject({
      status: 'DONE',
      progress: 100,
      durationDays: 5,
      baselineStart: '2026-01-05',
      baselineFinish: '2026-01-09',
    });
    expect(b).toMatchObject({ status: 'IN_PROGRESS', progress: 50 });
    expect(b.baselineStart ?? null).toBeNull();
    expect(c).toMatchObject({ status: 'NOT_STARTED', progress: 0 });
  });
});
