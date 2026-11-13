import { describe, it, expect } from 'vitest';
import { validateDoc, emptyDoc, makeTask, makeDep, starterDoc } from '../../src/domain';

describe('validate: §5.2 バリデーション①〜⑦', () => {
  it('空ドキュメント/スターターは合格', () => {
    expect(validateDoc(emptyDoc()).ok).toBe(true);
    expect(validateDoc(starterDoc()).ok).toBe(true);
  });

  it('ID重複を検出', () => {
    const doc = emptyDoc();
    const t = makeTask({ id: 'dup', name: 'x' });
    const t2 = makeTask({ id: 'dup', name: 'y' });
    doc.tasks = [t, t2];
    const res = validateDoc(doc);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('ID重複'))).toBe(true);
  });

  it('依存の参照不明を検出', () => {
    const doc = emptyDoc();
    const t = makeTask({ name: 'x' });
    doc.tasks = [t];
    doc.dependencies = [makeDep(t.id, 'missing')];
    const res = validateDoc(doc);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('successor不明'))).toBe(true);
  });

  it('milestone の duration!=0 を検出', () => {
    const doc = emptyDoc();
    // makeTask は milestone で強制0にするので、手で壊す
    const t = makeTask({ name: 'ms', isMilestone: true });
    (t as any).durationDays = 5;
    doc.tasks = [t];
    const res = validateDoc(doc);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('milestone'))).toBe(true);
  });

  it('循環（DAG違反）を検出', () => {
    const doc = emptyDoc();
    const a = makeTask({ name: 'a' });
    const b = makeTask({ name: 'b' });
    doc.tasks = [a, b];
    doc.dependencies = [makeDep(a.id, b.id), makeDep(b.id, a.id)];
    const res = validateDoc(doc);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('DAG違反'))).toBe(true);
  });

  it('Zod: 型不正（progress が範囲外）を弾く', () => {
    const doc: any = emptyDoc();
    const t = makeTask({ name: 'x' });
    (t as any).progress = 200;
    doc.tasks = [t];
    const res = validateDoc(doc);
    expect(res.ok).toBe(false);
  });

  it('Zod: 未知の構造（tasks欠落）を弾く', () => {
    const res = validateDoc({ schemaVersion: 1 });
    expect(res.ok).toBe(false);
  });

  it('Zod: 稼働曜日が空/範囲外、所要日数が巨大なドキュメントを弾く', () => {
    const empty: any = emptyDoc();
    empty.calendars[0].workingDays = [];
    expect(validateDoc(empty).ok).toBe(false);
    const outOfRange: any = emptyDoc();
    outOfRange.calendars[0].workingDays = [7];
    expect(validateDoc(outOfRange).ok).toBe(false);
    const huge: any = emptyDoc();
    // makeTask は上限で丸めるため、取込データ相当として直接書き換える
    huge.tasks = [{ ...makeTask({ name: 'x' }), durationDays: 1e9 }];
    expect(validateDoc(huge).ok).toBe(false);
  });

  it('Zod: 実在しない基準日・休日・制約日を弾く', () => {
    for (const bad of ['', 'abc', '2026-13-01', '2026-02-30']) {
      const d: any = emptyDoc();
      d.project.dataDate = bad;
      expect(validateDoc(d).ok).toBe(false);
    }
    const hol: any = emptyDoc();
    hol.calendars[0].holidays = ['2026-02-30'];
    expect(validateDoc(hol).ok).toBe(false);
    const con: any = emptyDoc();
    con.tasks = [makeTask({ name: 'x', constraintType: 'SNET', constraintDate: '2026-1-5' })];
    expect(validateDoc(con).ok).toBe(false);
    const ok: any = emptyDoc();
    ok.project.dataDate = '2024-02-29';
    expect(validateDoc(ok).ok).toBe(true);
  });
});
