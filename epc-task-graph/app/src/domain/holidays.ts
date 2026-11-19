// ============================================================================
// 休日の一括生成: 日本の祝日（祝日法・2007〜2099年）／年末年始／お盆。
// 稼働カレンダーの祝日登録に使う。UI 非依存の純関数。
// ============================================================================
import { isValidIsoDate } from './schema';

export interface NamedHoliday {
  date: string; // 'YYYY-MM-DD'
  name: string;
}

// 現行の祝日法（昭和の日・みどりの日5/4・振替休日の現行規定）が揃う 2007 年以降を対象とする。
const JP_MIN_YEAR = 2007;
const JP_MAX_YEAR = 2099;
const DAY_MS = 86400000;

// 暦日を「1970-01-01 からの通し日数」で扱う（UTC 固定で曜日・前後日の計算を単純にする）。
const dayNum = (y: number, m: number, d: number): number => Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
const isoOf = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);
const dowOf = (n: number): number => new Date(n * DAY_MS).getUTCDay();
const iso = (y: number, m: number, d: number): string =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// 対象年の配列（整数化し [min, max] に収める。逆順・非有限は空）。
function yearsIn(fromYear: number, toYear: number, min: number, max: number): number[] {
  const lo = Math.max(min, Math.ceil(fromYear));
  const hi = Math.min(max, Math.floor(toYear));
  const out: number[] = [];
  for (let y = lo; y <= hi; y++) out.push(y);
  return out;
}

// m 月の第 n 月曜日（日）。
function nthMonday(y: number, m: number, n: number): number {
  const first = 1 + ((8 - dowOf(dayNum(y, m, 1))) % 7);
  return first + (n - 1) * 7;
}

// 春分日・秋分日（1980〜2099 年に有効な近似式）。
const vernalEquinox = (y: number): number =>
  Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
const autumnalEquinox = (y: number): number =>
  Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

// 「国民の祝日」本体（振替休日・国民の休日を除く）。
function nationalHolidays(y: number): [number, number, string][] {
  const list: [number, number, string][] = [
    [1, 1, '元日'],
    [1, nthMonday(y, 1, 2), '成人の日'],
    [2, 11, '建国記念の日'],
    [3, vernalEquinox(y), '春分の日'],
    [4, 29, '昭和の日'],
    [5, 3, '憲法記念日'],
    [5, 4, 'みどりの日'],
    [5, 5, 'こどもの日'],
    [9, nthMonday(y, 9, 3), '敬老の日'],
    [9, autumnalEquinox(y), '秋分の日'],
    [11, 3, '文化の日'],
    [11, 23, '勤労感謝の日'],
  ];
  if (y <= 2018) list.push([12, 23, '天皇誕生日']);
  else if (y >= 2020) list.push([2, 23, '天皇誕生日']);
  // 東京五輪の特例（2020/2021）で海の日・山の日・スポーツの日が移動。
  if (y === 2020) list.push([7, 23, '海の日']);
  else if (y === 2021) list.push([7, 22, '海の日']);
  else list.push([7, nthMonday(y, 7, 3), '海の日']);
  if (y === 2020) list.push([8, 10, '山の日']);
  else if (y === 2021) list.push([8, 8, '山の日']);
  else if (y >= 2016) list.push([8, 11, '山の日']);
  if (y <= 2019) list.push([10, nthMonday(y, 10, 2), '体育の日']);
  else if (y === 2020) list.push([7, 24, 'スポーツの日']);
  else if (y === 2021) list.push([7, 23, 'スポーツの日']);
  else list.push([10, nthMonday(y, 10, 2), 'スポーツの日']);
  if (y === 2019) {
    list.push([4, 30, '国民の休日'], [5, 1, '天皇の即位の日'], [5, 2, '国民の休日'], [10, 22, '即位礼正殿の儀']);
  }
  return list;
}

function holidaysOfYear(y: number): NamedHoliday[] {
  const base = new Map<number, string>();
  for (const [m, d, name] of nationalHolidays(y)) base.set(dayNum(y, m, d), name);
  const all = new Map(base);
  for (const n of base.keys()) {
    // 国民の休日: 前日と翌日がともに祝日である（祝日でない）日。
    if (!base.has(n + 1) && base.has(n + 2)) all.set(n + 1, '国民の休日');
    // 振替休日: 日曜の祝日 → その後の最も近い「祝日でない日」。
    if (dowOf(n) === 0) {
      let s = n + 1;
      while (base.has(s)) s++;
      all.set(s, '振替休日');
    }
  }
  return [...all.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, name]) => ({ date: isoOf(n), name }));
}

/** 日本の祝日（振替休日・国民の休日を含む）。fromYear〜toYear（両端含む）、2007〜2099 年の範囲外は除外。日付昇順。 */
export function japaneseHolidays(fromYear: number, toYear: number): NamedHoliday[] {
  const out: NamedHoliday[] = [];
  for (const y of yearsIn(fromYear, toYear, JP_MIN_YEAR, JP_MAX_YEAR)) out.push(...holidaysOfYear(y));
  return out;
}

/** 年末年始休暇: 各年の 12/29〜12/31 と 1/1〜1/3。日付昇順・重複なし。 */
export function yearEndHolidays(fromYear: number, toYear: number): string[] {
  const out: string[] = [];
  for (const y of yearsIn(fromYear, toYear, 1000, 9999)) {
    out.push(iso(y, 1, 1), iso(y, 1, 2), iso(y, 1, 3), iso(y, 12, 29), iso(y, 12, 30), iso(y, 12, 31));
  }
  return out;
}

/** お盆休暇: 各年の 8/13〜8/16。日付昇順・重複なし。 */
export function obonHolidays(fromYear: number, toYear: number): string[] {
  const out: string[] = [];
  for (const y of yearsIn(fromYear, toYear, 1000, 9999)) {
    out.push(iso(y, 8, 13), iso(y, 8, 14), iso(y, 8, 15), iso(y, 8, 16));
  }
  return out;
}

/** 休日リストの結合: 実在する 'YYYY-MM-DD' だけを残し、重複を除いて昇順にする。 */
export function mergeHolidays(existing: string[], add: string[]): string[] {
  const set = new Set<string>();
  for (const h of [...existing, ...add]) {
    const s = typeof h === 'string' ? h.trim() : '';
    if (isValidIsoDate(s)) set.add(s);
  }
  return [...set].sort();
}
