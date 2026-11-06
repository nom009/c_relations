// ============================================================================
// CPM（クリティカルパス法）— §9.1 / Phase 2。UI/React/DOM 非依存の純関数。
// スコープ（Phase 2 完了）: 依存タイプ **FS/SS/FF/SF ＋ lag（負でリード）**・日付制約
//   **SNET/FNLT/ASAP**・**稼働カレンダー**（稼働曜日＋祝日。非稼働日は跨いで暦日で伸びる。
//   全曜日稼働＋祝日なしなら線形で高速化＝従来挙動を厳密維持）に対応。所要日数は稼働日で数え、
//   es/ef は暦日オフセット（ガントの線形軸を保つ）、開始基準日は project.dataDate。
// 内部は「projectStart からの暦日オフセット（number）」で計算し、表示用に実日付へ変換。
// 性能: O(V+E)、4,000ノード・6,000エッジで <20ms（§9.1）。メインスレッド同期でよい。
// ============================================================================
import type { Dependency, Task } from './types';
import { buildAdjacency } from './graph';

export interface CpmTaskResult {
  es: number; // Early Start（暦日オフセット）
  ef: number; // Early Finish
  ls: number; // Late Start
  lf: number; // Late Finish
  totalFloat: number; // LS − ES（= LF − EF）
  isCritical: boolean; // TF ≤ 0
  esDate: string; // ES の実日付（yyyy-mm-dd）
  efDate: string;
  lsDate: string;
  lfDate: string;
}

export interface CpmResult {
  byTask: Map<string, CpmTaskResult>;
  criticalTasks: Set<string>; // isCritical=true の集合（フィルタ/強調で共有・§5.1）
  criticalEdges: Set<string>; // 駆動依存（クリティカルなエッジ）の dependency.id 集合
  projectStart: number; // 常に 0
  projectEnd: number; // max(全EF)
  projectStartDate: string; // = dataDate
  projectEndDate: string;
}

// yyyy-mm-dd に n 日加算（暦日。UTC 固定でオフバイワン回避）。
export function addCalendarDays(isoDate: string, n: number): string {
  const base = parseISODate(isoDate);
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + Math.round(n));
  return d.toISOString().slice(0, 10);
}

function parseISODate(iso: string): number {
  // "2026-07-09" or ISO datetime → UTC 深夜のミリ秒。
  const s = (iso || '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Date.UTC(2000, 0, 1) : t;
}

const EMPTY: Omit<CpmResult, 'projectStartDate' | 'projectEndDate'> & {
  projectStartDate: string;
  projectEndDate: string;
} = {
  byTask: new Map(),
  criticalTasks: new Set(),
  criticalEdges: new Set(),
  projectStart: 0,
  projectEnd: 0,
  projectStartDate: '',
  projectEndDate: '',
};

/**
 * CPM（暦日・FS/SS/FF/SF＋lag）を計算する。
 * @param tasks       タスク配列（durationDays を使用。milestone は 0）
 * @param deps        依存配列（type=FS/SS/FF/SF・lagDays を尊重。負の lag はリード）
 * @param projectStart 開始基準日（yyyy-mm-dd。通常 project.dataDate）
 */
export function computeCpm(
  tasks: Task[],
  deps: Dependency[],
  projectStart: string,
  calendar?: { workingDays: number[]; holidays: string[] } | null,
): CpmResult {
  if (tasks.length === 0) {
    return { ...EMPTY, byTask: new Map(), criticalTasks: new Set(), criticalEdges: new Set(), projectStartDate: (projectStart || '').slice(0, 10), projectEndDate: (projectStart || '').slice(0, 10) };
  }

  const taskById = new Map<string, Task>();
  for (const t of tasks) taskById.set(t.id, t);
  const { succ } = buildAdjacency(deps);

  // ---- トポロジカルソート（Kahn）。循環は UI 上起き得ないが防御（§9.1-1）----
  const indeg = new Map<string, number>();
  for (const t of tasks) indeg.set(t.id, 0);
  for (const d of deps) if (indeg.has(d.successorId)) indeg.set(d.successorId, indeg.get(d.successorId)! + 1);
  const queue: string[] = [];
  for (const [id, dg] of indeg) if (dg === 0) queue.push(id);
  const order: string[] = [];
  const idegWork = new Map(indeg);
  const qq = [...queue];
  // shift() は O(n) なので、読み出し位置を進める方式で O(V+E) を保つ。
  for (let qi = 0; qi < qq.length; qi++) {
    const cur = qq[qi];
    order.push(cur);
    for (const s of succ.get(cur) || []) {
      idegWork.set(s, idegWork.get(s)! - 1);
      if (idegWork.get(s) === 0) qq.push(s);
    }
  }
  // 循環があれば残りを末尾に足して部分計算だけ返す（クラッシュ回避）。
  if (order.length !== tasks.length) {
    const placed = new Set(order);
    for (const t of tasks) if (!placed.has(t.id)) order.push(t.id);
  }

  const dur = (id: string): number => {
    const t = taskById.get(id);
    if (!t) return 0;
    return t.isMilestone ? 0 : Math.max(0, t.durationDays || 0);
  };

  // 制約日（yyyy-mm-dd）→ 基準日からの暦日オフセット。SNET/FNLT で使用（§9.1 / Phase2）。
  const startDate = (projectStart || '').slice(0, 10) || '2026-01-01';
  // 多数のタスクが同じ日付を参照するため、1回の計算内で日付文字列を共有する。
  const dateCache = new Map<number, string>();
  const dateAt = (offset: number): string => {
    const day = Math.round(offset);
    let date = dateCache.get(day);
    if (date === undefined) {
      date = addCalendarDays(startDate, day);
      dateCache.set(day, date);
    }
    return date;
  };
  const constraintOffset = (iso: string): number =>
    Math.round((parseISODate(iso) - parseISODate(startDate)) / 86400000);

  // ---- 稼働カレンダー（§9.1 / Phase2）: 所要日数は「稼働日」で数え、非稼働日（休日曜日/祝日）は
  //   スケジュールが跨ぐ＝暦日で伸びる。es/ef は暦日オフセットのまま（ガントの線形軸を保つ）。
  //   workingDays が全曜日かつ祝日なしなら線形（従来どおり EF=ES+d）で高速化＝既存挙動を厳密維持。
  // 不正なカレンダー（空・範囲外の曜日）は暴走防止のため無視して全曜日稼働に戻す。
  const validDays = (calendar?.workingDays ?? []).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  const wdSet = new Set(validDays.length ? validDays : [0, 1, 2, 3, 4, 5, 6]);
  const holSet = new Set((calendar?.holidays ?? []).map((h) => h.slice(0, 10)));
  const linearCal = wdSet.size >= 7 && holSet.size === 0;
  const baseMs = parseISODate(startDate);
  const baseDow = new Date(baseMs).getUTCDay();
  const isWorking = (off: number): boolean => {
    if (linearCal) return true;
    const dow = (((baseDow + Math.floor(off)) % 7) + 7) % 7;
    if (!wdSet.has(dow)) return false;
    return holSet.size === 0 || !holSet.has(dateAt(off));
  };
  const nextWorking = (off: number): number => {
    if (linearCal) return off;
    let o = off;
    let g = 0;
    while (!isWorking(o) && g++ < 3660) o++;
    return o;
  };
  const prevWorking = (off: number): number => {
    if (linearCal) return off;
    let o = off;
    let g = 0;
    while (!isWorking(o) && g++ < 3660) o--;
    return o;
  };
  // 稼働日 d 日分を前方に消化した先の暦日オフセット（排他的終端 = EF）。off は稼働日想定。
  const addWorkingDays = (off: number, d: number): number => {
    if (linearCal) return off + d;
    if (d <= 0) return off;
    let cur = off;
    let consumed = 0;
    let g = 0;
    while (consumed < d && g++ < 200000) {
      if (isWorking(cur)) consumed++;
      cur++;
    }
    return cur;
  };
  // 稼働日 d 日分を後方に戻した暦日オフセット（= LS）。
  const subWorkingDays = (off: number, d: number): number => {
    if (linearCal) return off - d;
    if (d <= 0) return off;
    let cur = off;
    let consumed = 0;
    let g = 0;
    while (consumed < d && g++ < 200000) {
      cur--;
      if (isWorking(cur)) consumed++;
    }
    return cur;
  };
  // LS 上限（lsBound）に対応する LF 上限。start を稼働日へ丸めてから d 日消化（線形時 = lsBound+d）。
  const lfFromLs = (lsBound: number, d: number): number => addWorkingDays(prevWorking(lsBound), d);

  // 依存を後続/先行ごとにグルーピング（型・lag を持つ本体を保持。同一ペア複数依存も個別に扱う）。
  const incoming = new Map<string, Dependency[]>(); // key=successorId
  const outgoing = new Map<string, Dependency[]>(); // key=predecessorId
  for (const d of deps) {
    if (!taskById.has(d.predecessorId) || !taskById.has(d.successorId)) continue;
    (incoming.get(d.successorId) ?? incoming.set(d.successorId, []).get(d.successorId)!).push(d);
    (outgoing.get(d.predecessorId) ?? outgoing.set(d.predecessorId, []).get(d.predecessorId)!).push(d);
  }

  // ---- 前進計算（トポ順）: 依存タイプ＋lag で後続の最早開始下限を課す（§9.1-2 / Phase2）----
  // FS: ES_s ≥ EF_p+lag ／ SS: ES_s ≥ ES_p+lag ／ FF: EF_s ≥ EF_p+lag ／ SF: EF_s ≥ ES_p+lag
  //   （EF系は ES = 下限 − dur(s) に変換）。lag は負でリード。ES は 0（基準日）を下限に丸める。
  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  // 依存タイプ＋lag が後続 successor の ES に課す下限（§9.1）。前進計算と駆動エッジ判定で共用。
  //   FS: ES_s ≥ EF_p+lag ／ SS: ES_s ≥ ES_p+lag ／ FF: EF_s≥EF_p+lag → ES へ稼働日換算 ／
  //   SF: EF_s≥ES_p+lag → ES へ稼働日換算。es/ef/subWorkingDays をクロージャで参照。
  const forwardReq = (type: Dependency['type'], p: string, lag: number, dSucc: number): number => {
    switch (type) {
      case 'SS':
        return (es.get(p) ?? 0) + lag;
      case 'FF':
        return subWorkingDays((ef.get(p) ?? 0) + lag, dSucc);
      case 'SF':
        return subWorkingDays((es.get(p) ?? 0) + lag, dSucc);
      case 'FS':
      default:
        return (ef.get(p) ?? 0) + lag;
    }
  };
  for (const id of order) {
    const d = dur(id);
    let start = 0;
    for (const dep of incoming.get(id) ?? []) {
      const req = forwardReq(dep.type, dep.predecessorId, dep.lagDays || 0, d);
      if (req > start) start = req;
    }
    // SNET（Start No Earlier Than）: この日以降にしか開始できない → ES を下限で丸める。
    const t = taskById.get(id);
    if (t && t.constraintType === 'SNET' && t.constraintDate) {
      const off = constraintOffset(t.constraintDate);
      if (off > start) start = off;
    }
    start = nextWorking(start); // ES は稼働日に丸める
    es.set(id, start);
    ef.set(id, addWorkingDays(start, d)); // EF は稼働日 d 日分先（非稼働日は跨いで伸びる）
  }

  const projectEnd = Math.max(0, ...order.map((id) => ef.get(id) ?? 0));

  // ---- 後退計算（逆トポ順）: 依存タイプ＋lag で先行の最遅終了上限を課す（§9.1-3 / Phase2）----
  // FS: LF_p ≤ LS_s−lag ／ SS: LS_p ≤ LS_s−lag ／ FF: LF_p ≤ LF_s−lag ／ SF: LS_p ≤ LF_s−lag
  //   （LS系は LF = 上限 + dur(p) に変換）。後続なしは projectEnd。
  const ls = new Map<string, number>();
  const lf = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const d = dur(id);
    // LF は projectEnd を上限に、各後続の要求で更に絞る（SS/SF や負ラグで projectEnd を超える要求は無視）。
    let finish = projectEnd;
    for (const dep of outgoing.get(id) ?? []) {
      const s = dep.successorId;
      const lag = dep.lagDays || 0;
      let req: number;
      switch (dep.type) {
        case 'SS':
          req = lfFromLs((ls.get(s) ?? projectEnd) - lag, d); // LS_p ≤ LS_s−lag を LF_p 上限へ
          break;
        // 前進側は EF 要求を非稼働日で切り下げるため、後退側は LF_s を次の稼働日まで切り上げて対称にする。
        case 'FF':
          req = nextWorking(lf.get(s) ?? projectEnd) - lag;
          break;
        case 'SF':
          req = lfFromLs(nextWorking(lf.get(s) ?? projectEnd) - lag, d); // LS_p ≤ LF_s−lag を LF_p 上限へ
          break;
        case 'FS':
        default:
          req = (ls.get(s) ?? projectEnd) - lag;
          break;
      }
      if (req < finish) finish = req;
    }
    // FNLT（Finish No Later Than）: この日までに終える → LF を上限で丸める。
    // 前進 EF より早い期限なら TF が負になり「遅延（要注意）」としてクリティカル化する。
    const t = taskById.get(id);
    if (t && t.constraintType === 'FNLT' && t.constraintDate) {
      const off = constraintOffset(t.constraintDate);
      if (off < finish) finish = off;
    }
    lf.set(id, finish);
    ls.set(id, subWorkingDays(finish, d)); // LS は稼働日 d 日分を後退（非稼働日は跨ぐ）
  }

  // ---- TF = LS − ES、TF ≤ 0 がクリティカル（§9.1-4）----
  const byTask = new Map<string, CpmTaskResult>();
  const criticalTasks = new Set<string>();
  for (const t of tasks) {
    const id = t.id;
    const _es = es.get(id) ?? 0;
    const _ef = ef.get(id) ?? 0;
    const _ls = ls.get(id) ?? 0;
    const _lf = lf.get(id) ?? 0;
    const tf = Math.round((_ls - _es) * 1000) / 1000;
    const crit = tf <= 0;
    if (crit) criticalTasks.add(id);
    byTask.set(id, {
      es: _es,
      ef: _ef,
      ls: _ls,
      lf: _lf,
      totalFloat: tf,
      isCritical: crit,
      esDate: dateAt(_es),
      efDate: dateAt(_ef),
      lsDate: dateAt(_ls),
      lfDate: dateAt(_lf),
    });
  }

  // ---- 駆動依存（クリティカルなエッジ）: 両端がクリティカルで、後続ESがこの依存の前進要件に一致 ----
  const criticalEdges = new Set<string>();
  for (const d of deps) {
    if (!criticalTasks.has(d.predecessorId) || !criticalTasks.has(d.successorId)) continue;
    const s = d.successorId;
    // 後続 ES は前進計算で 0 下限・稼働日丸めされているため、要件も同じ丸めをして比較する。
    const req = nextWorking(Math.max(0, forwardReq(d.type, d.predecessorId, d.lagDays || 0, dur(s))));
    const sEs = es.get(s);
    if (sEs != null && Math.abs(sEs - req) < 1e-9) criticalEdges.add(d.id);
  }

  return {
    byTask,
    criticalTasks,
    criticalEdges,
    projectStart: 0,
    projectEnd,
    projectStartDate: startDate,
    projectEndDate: dateAt(projectEnd),
  };
}
