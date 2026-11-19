// ============================================================================
// 休日の一括生成（holidays.ts）: 日本の祝日（振替休日・国民の休日・特例）／年末年始／お盆／結合。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { japaneseHolidays, mergeHolidays, obonHolidays, yearEndHolidays } from '../../src/domain/holidays';

describe('japaneseHolidays', () => {
  it('2026年: 振替休日（5/6）と国民の休日（9/22）を含む18日', () => {
    expect(japaneseHolidays(2026, 2026)).toEqual([
      { date: '2026-01-01', name: '元日' },
      { date: '2026-01-12', name: '成人の日' },
      { date: '2026-02-11', name: '建国記念の日' },
      { date: '2026-02-23', name: '天皇誕生日' },
      { date: '2026-03-20', name: '春分の日' },
      { date: '2026-04-29', name: '昭和の日' },
      { date: '2026-05-03', name: '憲法記念日' },
      { date: '2026-05-04', name: 'みどりの日' },
      { date: '2026-05-05', name: 'こどもの日' },
      { date: '2026-05-06', name: '振替休日' },
      { date: '2026-07-20', name: '海の日' },
      { date: '2026-08-11', name: '山の日' },
      { date: '2026-09-21', name: '敬老の日' },
      { date: '2026-09-22', name: '国民の休日' },
      { date: '2026-09-23', name: '秋分の日' },
      { date: '2026-10-12', name: 'スポーツの日' },
      { date: '2026-11-03', name: '文化の日' },
      { date: '2026-11-23', name: '勤労感謝の日' },
    ]);
  });

  it('2025年の振替休日は 2/24・5/6・11/24', () => {
    const subs = japaneseHolidays(2025, 2025)
      .filter((h) => h.name === '振替休日')
      .map((h) => h.date);
    expect(subs).toEqual(['2025-02-24', '2025-05-06', '2025-11-24']);
  });

  it('2019年の特例（即位関連・天皇誕生日なし）と2020年の五輪特例', () => {
    const y2019 = japaneseHolidays(2019, 2019);
    const dates2019 = y2019.map((h) => h.date);
    expect(dates2019).toEqual(
      expect.arrayContaining(['2019-04-30', '2019-05-01', '2019-05-02', '2019-05-06', '2019-10-22']),
    );
    expect(y2019.some((h) => h.name === '天皇誕生日')).toBe(false);
    const y2020 = japaneseHolidays(2020, 2020);
    expect(y2020).toEqual(
      expect.arrayContaining([
        { date: '2020-07-23', name: '海の日' },
        { date: '2020-07-24', name: 'スポーツの日' },
        { date: '2020-08-10', name: '山の日' },
      ]),
    );
    expect(y2020.some((h) => h.date.startsWith('2020-10-'))).toBe(false);
  });

  it('複数年は昇順に連結し、2007〜2099年の範囲外は除外する', () => {
    const two = japaneseHolidays(2025, 2026);
    expect(two.map((h) => h.date)).toEqual([...two.map((h) => h.date)].sort());
    expect(two.length).toBe(japaneseHolidays(2025, 2025).length + 18);
    expect(japaneseHolidays(2000, 2006)).toEqual([]);
    expect(japaneseHolidays(2099, 2105).every((h) => h.date.startsWith('2099-'))).toBe(true);
    expect(japaneseHolidays(2026, 2025)).toEqual([]);
  });
});

describe('年末年始・お盆・結合', () => {
  it('yearEndHolidays: 各年の 1/1〜1/3 と 12/29〜12/31', () => {
    expect(yearEndHolidays(2026, 2027)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
      '2027-12-29',
      '2027-12-30',
      '2027-12-31',
    ]);
  });

  it('obonHolidays: 各年の 8/13〜8/16', () => {
    expect(obonHolidays(2026, 2026)).toEqual(['2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16']);
  });

  it('mergeHolidays: 重複を除いて昇順、不正な日付は捨てる', () => {
    expect(
      mergeHolidays(['2026-01-05', '2026-01-01', 'bad', '2026-02-30'], ['2026-01-01', ' 2026-01-03 ']),
    ).toEqual(['2026-01-01', '2026-01-03', '2026-01-05']);
  });
});
