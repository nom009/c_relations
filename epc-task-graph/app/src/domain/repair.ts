// ============================================================================
// 保存データ/インポートJSONの軽微な欠損・範囲外を直す（読込時の誤「破損」判定を避ける）。
// 直すのはフィールド単位の良性の問題だけ。ID重複・参照切れ・循環・不正な基準日などの
// 構造的な問題には触れず、後段の validateDoc に失敗させる。UI非依存の純関数。
// ============================================================================
import { defaultCalendar, makeDep, makeTask } from './factory';
import { MAX_DAYS, isValidIsoDate } from './schema';

type Rec = Record<string, unknown>;

export interface RepairResult {
  doc: unknown;
  repaired: boolean;
}

const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const finiteOr0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// undefined（と constraintDate 以外の null）は欠損扱いにして既定値を残す。
function present(row: Rec): Rec {
  return Object.fromEntries(
    Object.entries(row).filter(([k, v]) => v !== undefined && (v !== null || k === 'constraintDate')),
  );
}

function same(a: Rec, b: Rec): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => {
    const x = a[k];
    const y = b[k];
    if (isRec(x) && isRec(y)) return x.x === y.x && x.y === y.y; // position のみ入れ子
    return Object.is(x, y);
  });
}

function repairTask(row: Rec): Rec {
  const t: Rec = { ...makeTask({ id: '-' }), ...present(row), id: row.id };
  t.durationDays = t.isMilestone === true ? 0 : clamp(finiteOr0(t.durationDays), 0, MAX_DAYS);
  t.progress = clamp(Math.round(finiteOr0(t.progress)), 0, 100);
  const pos: Rec = isRec(t.position) ? t.position : {};
  t.position = { x: finiteOr0(pos.x), y: finiteOr0(pos.y) };
  if (t.constraintDate !== null && !(typeof t.constraintDate === 'string' && isValidIsoDate(t.constraintDate))) {
    t.constraintDate = null;
  }
  return same(row, t) ? row : t;
}

function repairDep(row: Rec): Rec {
  const d: Rec = { ...makeDep('', '', { id: '-', rev: 0 }), ...present(row), id: row.id };
  d.lagDays = clamp(finiteOr0(d.lagDays), -MAX_DAYS, MAX_DAYS);
  return same(row, d) ? row : d;
}

function mapRows(rows: unknown, fix: (r: Rec) => Rec): { rows: unknown; changed: boolean } {
  if (!Array.isArray(rows)) return { rows, changed: false };
  let changed = false;
  const out = rows.map((r) => {
    if (!isRec(r)) return r;
    const f = fix(r);
    if (f !== r) changed = true;
    return f;
  });
  return { rows: changed ? out : rows, changed };
}

export function repairDoc(doc: unknown): RepairResult {
  if (!isRec(doc)) return { doc, repaired: false };
  const out: Rec = { ...doc };
  let repaired = false;

  const t = mapRows(doc.tasks, repairTask);
  const d = mapRows(doc.dependencies, repairDep);
  if (t.changed) out.tasks = t.rows;
  if (d.changed) out.dependencies = d.rows;
  repaired = t.changed || d.changed;

  const p = doc.project;
  if (isRec(p)) {
    const now = new Date().toISOString();
    const defaults: Rec = { description: '', createdAt: now, updatedAt: now, version: 1 };
    const missing = Object.keys(defaults).filter((k) => p[k] == null);
    if (missing.length) {
      out.project = { ...Object.fromEntries(missing.map((k) => [k, defaults[k]])), ...present(p) };
      repaired = true;
    }
  }
  if (doc.viewState == null) {
    out.viewState = { collapsedWbs: [], expandLevel: 2 };
    repaired = true;
  }
  if (doc.savedViews == null) {
    out.savedViews = [];
    repaired = true;
  }
  if (!Array.isArray(doc.calendars) || !doc.calendars.length) {
    out.calendars = [defaultCalendar()];
    repaired = true;
  }
  return repaired ? { doc: out, repaired } : { doc, repaired };
}
