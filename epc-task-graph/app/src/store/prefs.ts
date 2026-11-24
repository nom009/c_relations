// ============================================================================
// 端末ローカルの UI 設定（localStorage）: 担当者名・表示ビュー・表示列・既定ビュー。
// Undo/Dexie の対象外。読み書きの失敗は無視する（設定の記憶は必須ではない）。
// ============================================================================
import type { ActiveView, TableColumnKey } from "../domain";

export const LS_ME = "epc-app-me";
export const LS_ACTIVE_VIEW = "epc-app-active-view";
export const LS_TABLE_COLUMNS = "epc-app-table-columns";
export const LS_DEFAULT_VIEW = "epc-app-default-view"; // 起動時に自動適用する保存ビューID（実用化の入口）

// localStorage は無効化/容量超過で例外を投げうる。UI設定の記憶は失敗しても無視してよい。
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

// 表示列の正準順（§12.3.2）。TableView はこの順で、tableColumns に含まれる列だけを描画する。
export const ALL_TABLE_COLUMNS: TableColumnKey[] = [
  "wbsCode",
  "name",
  "wbsPath",
  "discipline",
  "assignee",
  "status",
  "progress",
  "durationDays",
  "es",
  "ef",
  "ls",
  "lf",
  "totalFloat",
  "critical",
  "actualStart",
  "actualFinish",
  "variance",
  "deps",
];

// 既定表示列（§12.3.2 「既定」列）。wbsPath / ls / lf / 実績・差異は既定非表示。
const DEFAULT_TABLE_COLUMNS: TableColumnKey[] = [
  "wbsCode",
  "name",
  "discipline",
  "assignee",
  "status",
  "progress",
  "durationDays",
  "es",
  "ef",
  "totalFloat",
  "critical",
  "deps",
];

export function initialMe(): string {
  return readPref(LS_ME) || "私";
}

export function initialActiveView(): ActiveView {
  const v = readPref(LS_ACTIVE_VIEW);
  return v === "graph" || v === "table" || v === "gantt" ? v : "graph";
}

export function initialTableColumns(): TableColumnKey[] {
  try {
    const raw = readPref(LS_TABLE_COLUMNS);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const valid = parsed.filter((k): k is TableColumnKey =>
          (ALL_TABLE_COLUMNS as string[]).includes(k as string),
        );
        if (valid.length) return valid;
      }
    }
  } catch {
    /* ignore */
  }
  return [...DEFAULT_TABLE_COLUMNS];
}
