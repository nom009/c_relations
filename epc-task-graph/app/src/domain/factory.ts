// ============================================================================
// ファクトリ（§5.2）: Task/Dependency/Doc の生成・既定値の一元管理。ここを通して作れば
// スキーマ必須フィールド（rev/updatedBy/timestamp 等）が漏れなく埋まる。UI非依存の純関数。
// ============================================================================
import type { Calendar, Dependency, GraphDoc, Task } from './types';
import { CURRENT_SCHEMA_VERSION } from './migrate';

// 一意 ID。crypto.randomUUID があれば使い、無い環境（古い実行系）は乱数＋時刻で代替。
export function newId(): string {
  return globalThis.crypto && crypto.randomUUID
    ? crypto.randomUUID()
    : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function nowISO(): string {
  return new Date().toISOString();
}

// 決定的擬似乱数（mulberry32）。同じ seed からは常に同じ数列＝デモ生成やテストが再現可能。
// 32bit の内部状態 a を毎回撹拌し、[0,1) の浮動小数を返す（Math.random の置換）。
// ビット演算はオーバーフローを 32bit に丸めるためのイディオム（| 0 / >>> 0）。
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0; // 状態を符号なし32bitに正規化
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0; // 状態を定数で前進
    let t = Math.imul(a ^ (a >>> 15), 1 | a); // 乗算＋シフトで雪崩効果（bit を混ぜる）
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // 2^32 で割って [0,1) へ
  };
}

export function makeTask(p: Partial<Task> = {}, by = '私'): Task {
  const ts = nowISO();
  const isMilestone = !!p.isMilestone;
  return {
    id: p.id || newId(),
    name: p.name != null ? p.name : '新規タスク',
    wbsCode: p.wbsCode != null ? p.wbsCode : '',
    discipline: p.discipline || 'OTHER',
    isMilestone,
    durationDays: isMilestone ? 0 : p.durationDays != null ? p.durationDays : 5,
    status: p.status || 'NOT_STARTED',
    progress: p.progress != null ? p.progress : 0,
    assignee: p.assignee != null ? p.assignee : '',
    constraintType: p.constraintType || 'ASAP',
    constraintDate: p.constraintDate != null ? p.constraintDate : null,
    notes: p.notes || '',
    position: p.position || { x: 0, y: 0 },
    rev: p.rev != null ? p.rev : 1,
    createdAt: p.createdAt || ts,
    updatedAt: p.updatedAt || ts,
    updatedBy: p.updatedBy || by,
  };
}

export function makeDep(
  predecessorId: string,
  successorId: string,
  p: Partial<Dependency> = {},
  by = '私',
): Dependency {
  return {
    id: p.id || newId(),
    predecessorId,
    successorId,
    type: p.type || 'FS',
    lagDays: p.lagDays != null ? p.lagDays : 0,
    rev: p.rev != null ? p.rev : 1,
    updatedAt: p.updatedAt || nowISO(),
    updatedBy: p.updatedBy || by,
  };
}

export function defaultCalendar(): Calendar {
  return { id: 'cal-default', name: '週休2日', workingDays: [1, 2, 3, 4, 5], holidays: [] };
}

// 全 ID（プロジェクト/タスク/依存）を振り直した複製を返す。tasks/dependencies の主キーは
// プロジェクト横断で一意のため、複製・インポート時は必ずこれを通して他プロジェクトとの衝突を避ける。
export function cloneDocWithNewIds(src: GraphDoc, newName: string): GraphDoc {
  const now = nowISO();
  const idMap = new Map<string, string>();
  const tasks = src.tasks.map((t) => {
    const nid = newId();
    idMap.set(t.id, nid);
    return { ...t, id: nid };
  });
  const dependencies = src.dependencies
    .map((d) => ({
      ...d,
      id: newId(),
      predecessorId: idMap.get(d.predecessorId)!,
      successorId: idMap.get(d.successorId)!,
    }))
    .filter((d) => d.predecessorId && d.successorId);
  return {
    ...src,
    project: { ...src.project, id: newId(), name: newName, createdAt: now, updatedAt: now, version: 1 },
    tasks,
    dependencies,
  };
}

export function emptyDoc(name = '新規プロジェクト'): GraphDoc {
  const ts = nowISO();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: {
      id: newId(),
      name,
      description: '',
      calendarId: 'cal-default',
      // 開始基準日は利用者の現地日付（UTC だと JST 午前9時前に前日になる）。
      dataDate: new Date().toLocaleDateString('sv-SE'),
      createdAt: ts,
      updatedAt: ts,
      version: 1,
    },
    viewState: { collapsedWbs: [], expandLevel: 2 },
    savedViews: [],
    calendars: [defaultCalendar()],
    tasks: [],
    dependencies: [],
  };
}
