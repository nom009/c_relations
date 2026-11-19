import { describe, it, expect } from 'vitest';
import { fromCsv, toCsv, csvTemplate, parseCsvRows, parseCsvDate, decodeCsvBytes, validateDoc, emptyDoc, CSV_COLUMNS } from '../../src/domain';
import { showcaseDoc } from '../../src/domain/showcase';

// 旧形式（No/ID/実績列なし・「分類」見出し）でも読めることを確かめる。
const H = 'WBS,タスク名,分類,所要日数,マイルストーン,先行タスク,ステータス,進捗(%),担当,開始日,期限,備考';

describe('CSV 取込', () => {
  it('RFC4180: 引用符・埋め込み改行・"" を扱える', () => {
    expect(parseCsvRows('\uFEFFa,"b,c","x""y"\r\n"1\n2",3\n')).toEqual([
      ['a', 'b,c', 'x"y'],
      ['1\n2', '3'],
    ]);
  });

  it('日付は / - . 年月日・8桁を受け、実在しない日付は弾く', () => {
    expect(parseCsvDate('2026/4/1')).toBe('2026-04-01');
    expect(parseCsvDate('2026-04-01')).toBe('2026-04-01');
    expect(parseCsvDate('2026年4月1日')).toBe('2026-04-01');
    expect(parseCsvDate('20260401')).toBe('2026-04-01');
    expect(parseCsvDate('２０２６／４／１')).toBe('2026-04-01');
    expect(parseCsvDate('2026/2/30')).toBeNull();
  });

  it('テンプレートはエラーなく取り込め、検証も通る', () => {
    const r = fromCsv(csvTemplate());
    expect(r.errors).toEqual([]);
    expect(r.tasks.length).toBe(7);
    expect(r.dependencies.length).toBe(7);
    expect(r.earliestStart).toBe('2026-04-01');
    const byWbs = new Map(r.tasks.map((t) => [t.wbsCode, t]));
    const ss = r.dependencies.find((d) => d.successorId === byWbs.get('2.1')!.id)!;
    expect(ss.type).toBe('SS');
    expect(ss.lagDays).toBe(5);
    expect(byWbs.get('3.3')!.isMilestone).toBe(true);
    expect(byWbs.get('3.3')!.constraintType).toBe('FNLT');
    expect(byWbs.get('1.1')!.constraintType).toBe('SNET');
    expect(byWbs.get('1.1')!.discipline).toBe('E');
    expect(byWbs.get('1.2')!.status).toBe('IN_PROGRESS');
    const doc = { ...emptyDoc(), tasks: r.tasks, dependencies: r.dependencies };
    expect(validateDoc(doc).ok).toBe(true);
  });

  it('見出しの別名・列順の違い・ハイフン入り WBS・ラグ付き表記を受ける', () => {
    const csv = [
      '作業名,ＷＢＳ,工期(日),先行',
      'A作業,A-1,3,',
      'B作業,A-2,4日,A-1',
      'C作業,A-3,2,"A-1FS+2, A-2 SS-1日"',
    ].join('\n');
    const r = fromCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.tasks.map((t) => t.durationDays)).toEqual([3, 4, 2]);
    const c = r.tasks[2].id;
    const deps = r.dependencies.filter((d) => d.successorId === c).map((d) => [d.type, d.lagDays]);
    expect(deps).toEqual([
      ['FS', 2],
      ['SS', -1],
    ]);
  });

  it('行番号付きでエラーを返す（不明な先行・不正値・開始日と期限の併記）。WBS の重複は許す', () => {
    const csv = [
      H,
      '1,A,設計,3,,,,,,,,',
      '1,B,設計,3,,,,,,,,',
      '2,C,土木,x,,9,,150,,2026/1/1,2026/2/1,',
      '3,D,,3,,9,,,,,,',
    ].join('\n');
    const r = fromCsv(csv);
    expect(r.errors.some((e) => e.includes('WBS「1」'))).toBe(false);
    expect(r.errors.some((e) => e.startsWith('4行目: 工種「土木」'))).toBe(true);
    expect(r.errors.some((e) => e.startsWith('4行目: 所要日数「x」'))).toBe(true);
    expect(r.errors.some((e) => e.startsWith('4行目: 進捗「150」'))).toBe(true);
    expect(r.errors.some((e) => e.startsWith('4行目: 開始日と期限'))).toBe(true);
    expect(r.errors).toContain('5行目: 先行タスク「9」が見つかりません');
  });

  it('見出しに WBS/タスク名 が無ければ中止', () => {
    expect(fromCsv('名前,日数\nA,1').errors[0]).toMatch(/「WBS」と「タスク名」/);
  });

  it('見出し上の表題行を読み飛ばし、行番号は Excel の行と一致する', () => {
    const r = fromCsv(['工程表（仮）,,', ',,', 'WBS,タスク名,先行タスク', '1,A,', '2,B,9'].join('\n'));
    expect(r.errors).toEqual(['5行目: 先行タスク「9」が見つかりません']);
  });

  it('Unicode テキスト（UTF-16LE＋BOM・タブ区切り）を読める', () => {
    const s = 'WBS\tタスク名\t先行タスク\r\n1\tA\t\r\n2\tB\t1，1\r\n';
    const bytes = new Uint8Array(2 + s.length * 2);
    bytes.set([0xff, 0xfe]);
    for (let i = 0; i < s.length; i++) {
      bytes[2 + i * 2] = s.charCodeAt(i) & 0xff;
      bytes[3 + i * 2] = s.charCodeAt(i) >> 8;
    }
    const r = fromCsv(decodeCsvBytes(bytes));
    expect(r.errors).toEqual([]);
    expect(r.tasks.map((t) => t.name)).toEqual(['A', 'B']);
    expect(r.dependencies.length).toBe(1);
  });

  it('循環を検出する', () => {
    const r = fromCsv([H, '1,A,,1,,2,,,,,,', '2,B,,1,,1,,,,,,'].join('\n'));
    expect(r.errors[0]).toMatch(/循環/);
  });

  it('進捗・ステータスの補完と警告（所要日数空・重複先行）', () => {
    const r = fromCsv([H, '1,A,,,,,,,,,,', '2,B,,2,,"1,1",完了,,,,,', '3,C,,2,,,,0.3,,,,'].join('\n'));
    expect(r.errors).toEqual([]);
    expect(r.tasks[1].progress).toBe(100);
    expect(r.tasks[2].progress).toBe(30);
    expect(r.tasks[2].status).toBe('IN_PROGRESS');
    expect(r.dependencies.length).toBe(1);
    expect(r.warnings.length).toBe(2);
  });

  it('toCsv → fromCsv で往復でき、式に見える文字列は無害化して復元する', () => {
    const src = fromCsv(csvTemplate());
    src.tasks[0].name = '=SUM(A1)';
    src.tasks[0].notes = '複数行\nの備考, "引用"';
    const text = toCsv(src.tasks, src.dependencies);
    expect(text).toContain("'=SUM(A1)");
    const back = fromCsv(text);
    expect(back.errors).toEqual([]);
    expect(back.tasks.map((t) => [t.wbsCode, t.name, t.durationDays, t.constraintDate])).toEqual(
      src.tasks.map((t) => [t.wbsCode, t.name, t.durationDays, t.constraintDate]),
    );
    expect(back.tasks[0].notes).toBe('複数行\nの備考, "引用"');
    expect(back.dependencies.map((d) => [d.type, d.lagDays])).toEqual(
      src.dependencies.map((d) => [d.type, d.lagDays]),
    );
  });

  it('テンプレートは16列（先頭 No・末尾 ID）で、先行タスクは No で書く', () => {
    const rows = parseCsvRows(csvTemplate());
    expect(rows[0]).toEqual([...CSV_COLUMNS]);
    expect(rows[0].length).toBe(16);
    expect(rows.every((r) => r.length === 16)).toBe(true);
    expect(rows[3][6]).toBe('2SS+5');
  });

  it('WBS が重複していても No で先行タスクを指定できる（種類・ラグ付き、"03" は 3）', () => {
    const r = fromCsv(
      [
        'No,WBS,タスク名,所要日数,先行タスク',
        '1,1.1,A,3,',
        '2,1.1,B,4,1',
        '03,1.2,C,2,"1FS+2, 2SS-1日"',
        '4,1.2,D,1,3',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    const name = new Map(r.tasks.map((t) => [t.id, t.name]));
    expect(r.dependencies.map((d) => [name.get(d.predecessorId), name.get(d.successorId), d.type, d.lagDays])).toEqual([
      ['A', 'B', 'FS', 0],
      ['A', 'C', 'FS', 2],
      ['B', 'C', 'SS', -1],
      ['C', 'D', 'FS', 0],
    ]);
  });

  it('No の重複はエラー（"01" と "1" は同じ番号）', () => {
    const r = fromCsv(['No,WBS,タスク名,所要日数', '1,1,A,1', '01,2,B,1'].join('\n'));
    expect(r.errors).toContain('3行目: No「1」が2行目と重複しています');
  });

  it('No 列が無く WBS が重複する旧形式は、先行タスクをデータ行の順番で読む', () => {
    const ok = fromCsv(['WBS,タスク名,所要日数,先行タスク', '1.1,A,1,', '1.1,B,1,1', '1.2,C,1,2FS+1'].join('\n'));
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.some((w) => w.includes('データ行の順番'))).toBe(true);
    const name = new Map(ok.tasks.map((t) => [t.id, t.name]));
    expect(ok.dependencies.map((d) => [name.get(d.predecessorId), name.get(d.successorId), d.lagDays])).toEqual([
      ['A', 'B', 0],
      ['B', 'C', 1],
    ]);
    const ng = fromCsv(['WBS,タスク名,所要日数,先行タスク', '1.1,A,1,', '1.1,B,1,1.1'].join('\n'));
    expect(ng.errors[0]).toBe('3行目: 先行タスク「1.1」が見つかりません');
    expect(ng.errors[1]).toMatch(/データ行の順番/);
  });

  it('ID 列: 正しい形式で一意なら Task.id に使い、重複はエラー、不正な形式は無視して警告', () => {
    const r = fromCsv(['WBS,タスク名,所要日数,ID', '1,A,1,task_A-1', '2,B,1,', '3,C,1,不正 ID'].join('\n'));
    expect(r.errors).toEqual([]);
    expect(r.hasIds).toBe(true);
    expect(r.tasks[0].id).toBe('task_A-1');
    expect(r.tasks[1].id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(r.tasks[2].id).not.toBe('不正 ID');
    expect(r.warnings).toContain('4行目: ID「不正 ID」は形式が正しくないため無視し、新しいタスクとして扱います');
    const dup = fromCsv(['WBS,タスク名,所要日数,ID', '1,A,1,x1', '2,B,1,x1'].join('\n'));
    expect(dup.errors).toContain('3行目: ID「x1」が2行目と重複しています');
  });

  it('実績開始日・実績完了日を読み、不正な日付や前後の逆転はエラー', () => {
    const r = fromCsv(
      [
        'WBS,タスク名,所要日数,実績開始日,実績完了日',
        '1,A,5,2026/4/1,2026年4月10日',
        '2,B,5,,',
        '3,C,5,2026/4/31,',
        '4,D,5,2026/4/10,2026/4/1',
      ].join('\n'),
    );
    expect(r.errors).toEqual([
      '4行目: 実績開始日「2026/4/31」を日付として読めません（例: 2026/4/1）',
      '5行目: 実績完了日が実績開始日より前です',
    ]);
    expect(r.fields).toEqual(expect.arrayContaining(['actualStart', 'actualFinish']));
    expect(r.tasks[0].actualStart).toBe('2026-04-01');
    expect(r.tasks[0].actualFinish).toBe('2026-04-10');
    expect(r.tasks[1].actualStart ?? null).toBeNull();
    const text = toCsv(r.tasks, r.dependencies);
    expect(text).toContain('2026/04/01,2026/04/10');
  });

  it('デモ（WBS を共有するタスクあり）を書き出して読み戻すと、件数・ID・依存・値が一致する', () => {
    const doc = showcaseDoc();
    const back = fromCsv(toCsv(doc.tasks, doc.dependencies));
    expect(back.errors).toEqual([]);
    expect(back.tasks.length).toBe(doc.tasks.length);
    expect(back.dependencies.length).toBe(doc.dependencies.length);
    expect(new Set(back.tasks.map((t) => t.id))).toEqual(new Set(doc.tasks.map((t) => t.id)));
    const depKey = (d: { predecessorId: string; successorId: string; type: string; lagDays: number }) =>
      `${d.predecessorId}>${d.successorId}:${d.type}${d.lagDays}`;
    expect(back.dependencies.map(depKey).sort()).toEqual(doc.dependencies.map(depKey).sort());
    const byId = new Map(doc.tasks.map((t) => [t.id, t]));
    const vals = (t: (typeof doc.tasks)[number]) => [
      t.name,
      t.wbsCode,
      t.discipline,
      t.isMilestone,
      t.durationDays,
      t.status,
      t.progress,
      t.assignee,
      t.notes,
    ];
    for (const t of back.tasks) expect(vals(t)).toEqual(vals(byId.get(t.id)!));
  });

  it('UTF-8 でなければ Shift_JIS として読む', () => {
    const utf8 = new TextEncoder().encode('WBS,タスク名');
    expect(decodeCsvBytes(utf8)).toBe('WBS,タスク名');
    // "WBS,作業" の Shift_JIS バイト列
    const sjis = new Uint8Array([0x57, 0x42, 0x53, 0x2c, 0x8d, 0xec, 0x8b, 0xc6]);
    expect(decodeCsvBytes(sjis)).toBe('WBS,作業');
  });
});
