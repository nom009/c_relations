import { describe, it, expect } from 'vitest';
import { repairDoc, validateDoc, emptyDoc, makeTask, makeDep, starterDoc, type GraphDoc } from '../../src/domain';

type Loose = Record<string, unknown>;
const docWith = (tasks: unknown[], dependencies: unknown[] = []): GraphDoc =>
  ({ ...emptyDoc(), tasks, dependencies }) as unknown as GraphDoc;

describe('repairDoc', () => {
  it('有効なドキュメントは repaired=false で同一参照を返す', () => {
    const doc = starterDoc();
    const r = repairDoc(doc);
    expect(r.repaired).toBe(false);
    expect(r.doc).toBe(doc);
    expect(repairDoc(emptyDoc()).repaired).toBe(false);
  });

  it('後から追加されたフィールドの欠損（constraintType/updatedBy）を既定値で埋める', () => {
    const t = makeTask({ name: 'legacy' }) as unknown as Loose;
    delete t.constraintType;
    delete t.updatedBy;
    const r = repairDoc(docWith([t]));
    const fixed = (r.doc as GraphDoc).tasks[0];
    expect(r.repaired).toBe(true);
    expect(fixed.id).toBe(t.id);
    expect(fixed.name).toBe('legacy');
    expect(fixed.constraintType).toBe('ASAP');
    expect(fixed.updatedBy).toBeTruthy();
    expect(validateDoc(r.doc).ok).toBe(true);
  });

  it('範囲外・非有限の数値と不正な日付を補正する', () => {
    const t = makeTask({ name: 'x' }) as unknown as Loose;
    t.progress = 150.4;
    t.durationDays = Number.NaN;
    t.position = { x: Number.NaN, y: Infinity };
    t.constraintDate = '2025-02-30';
    const u = makeTask({ name: 'y', durationDays: 5 }) as unknown as Loose;
    u.durationDays = 99999;
    u.progress = 49.6;
    delete u.position;
    const dep = makeDep(t.id as string, u.id as string) as unknown as Loose;
    dep.lagDays = Number.NaN;
    delete dep.type;
    delete dep.rev;
    const r = repairDoc(docWith([t, u], [dep]));
    const out = r.doc as GraphDoc;
    expect(r.repaired).toBe(true);
    expect(out.tasks[0]).toMatchObject({ progress: 100, durationDays: 0, position: { x: 0, y: 0 }, constraintDate: null });
    expect(out.tasks[1]).toMatchObject({ durationDays: 36500, progress: 50, position: { x: 0, y: 0 } });
    expect(out.dependencies[0]).toMatchObject({ type: 'FS', lagDays: 0, rev: 0 });
    expect(validateDoc(r.doc).ok).toBe(true);
  });

  it('構造的な問題（循環）は修復後も検証で失敗する', () => {
    const a = makeTask({ name: 'a' });
    const b = makeTask({ name: 'b' });
    const broken = { ...a, progress: 150.4 };
    const r = repairDoc(docWith([broken, b], [makeDep(a.id, b.id), makeDep(b.id, a.id)]));
    expect(r.repaired).toBe(true);
    const v = validateDoc(r.doc);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('DAG違反'))).toBe(true);
  });
});
