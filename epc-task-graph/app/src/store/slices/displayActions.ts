// ============================================================================
// 表示状態アクション（store.ts から分割）: フィルタ・表示モード・折り畳み・フォーカス・クイックビュー・CP強調。
// Undo 対象外。折り畳み（viewState）だけは Dexie へ保存する（scheduleSave）。
// ============================================================================
import { allTopPrefixes, collapsedForLevel } from "../../domain";
import { scheduleSave } from "../persistenceRuntime";
import type { AppGet, AppSet, AppState } from "../storeTypes";
import { noSelection, setCollapsedWbs } from "../storeUtils";

type DisplayActions = Pick<
  AppState,
  | "setFilter"
  | "clearFilter"
  | "setBoundary"
  | "setDisplayMode"
  | "toggleArrayFilter"
  | "setExpandLevel"
  | "collapseAll"
  | "expandAggregate"
  | "toggleCollapse"
  | "toggleFocus"
  | "clearFocus"
  | "incFocusDepth"
  | "setFocusRange"
  | "setFocusMode"
  | "escape"
  | "quickMyTasks"
  | "quickCriticalOnly"
  | "toggleCpHighlight"
>;

export function displayActions(set: AppSet, get: AppGet): DisplayActions {
  return {
    setFilter: (patch) =>
      set((s) => {
        Object.assign(s.viewSpec.filter, patch);
      }),
    clearFilter: () =>
      set((s) => {
        s.viewSpec.filter = {};
        s.viewSpec.boundaryUp = 0;
        s.viewSpec.boundaryDown = 0;
      }),
    // 前後の受け渡し世代を設定（0-9でクランプ）。フィルタ有効時に文脈として前後を含める。
    setBoundary: (up, down) =>
      set((s) => {
        s.viewSpec.boundaryUp = Math.max(0, Math.min(9, Math.round(up)));
        s.viewSpec.boundaryDown = Math.max(0, Math.min(9, Math.round(down)));
      }),
    setDisplayMode: (m) => {
      set((s) => {
        s.viewSpec.displayMode = m;
      });
      if (m === "ISOLATE") get().fit();
    },
    toggleArrayFilter: (key, val) =>
      set((s) => {
        const cur = (s.viewSpec.filter[key] as string[] | undefined) || [];
        const next = cur.includes(val)
          ? cur.filter((x) => x !== val)
          : [...cur, val];
        (s.viewSpec.filter as Partial<Record<typeof key, string[]>>)[key] = next;
      }),
    setExpandLevel: (n) => {
      set((s) => {
        s.expandLevel = n;
        setCollapsedWbs(s, collapsedForLevel(s.tasks, n));
        s.viewState.expandLevel = n;
      });
      scheduleSave();
    },
    collapseAll: () => {
      set((s) => {
        s.expandLevel = 1;
        setCollapsedWbs(s, allTopPrefixes(s.tasks));
        s.viewState.expandLevel = 1;
      });
      scheduleSave();
    },
    expandAggregate: (aggId) => {
      set((s) => {
        const prefix = aggId.startsWith("wbs::") ? aggId.slice(5) : aggId;
        setCollapsedWbs(s, s.viewSpec.collapsedWbs.filter((p) => p !== prefix));
        s.selection = noSelection();
        s.selectedIds = [];
      });
      scheduleSave();
    },
    toggleCollapse: (prefix) => {
      set((s) => {
        const cur = s.viewSpec.collapsedWbs;
        setCollapsedWbs(
          s,
          cur.includes(prefix) ? cur.filter((p) => p !== prefix) : [...cur, prefix],
        );
      });
      scheduleSave();
    },
    toggleFocus: (taskId) => {
      set((s) => {
        const cur = s.viewSpec.focus;
        if (cur && cur.taskId === taskId) {
          s.viewSpec.focus = null;
        } else {
          // 既定は「関係ハイライト」（全体を残し近傍を強調・§2.9 ユーザー要望2026-07-22）。
          s.viewSpec.focus = { taskId, up: 2, down: 2, mode: "highlight" };
        }
      });
      // ハイライトは文脈を保ちたいので起点センタリングのみ（fitはしない）。
      if (get().viewSpec.focus)
        setTimeout(() => get().runners.centerSelected?.(), 30);
    },
    clearFocus: () =>
      set((s) => {
        s.viewSpec.focus = null;
      }),
    incFocusDepth: (delta) =>
      set((s) => {
        if (!s.viewSpec.focus) return;
        const f = s.viewSpec.focus;
        f.up = Math.max(0, (f.up ?? 2) + delta);
        f.down = Math.max(0, (f.down ?? 2) + delta);
      }),
    setFocusRange: (up, down) =>
      set((s) => {
        if (!s.viewSpec.focus) return;
        s.viewSpec.focus.up = Math.max(0, Math.min(9, Math.round(up)));
        s.viewSpec.focus.down = Math.max(0, Math.min(9, Math.round(down)));
      }),
    setFocusMode: (mode) =>
      set((s) => {
        if (!s.viewSpec.focus) return;
        s.viewSpec.focus.mode = mode;
      }),
    escape: () =>
      set((s) => {
        if (s.viewSpec.focus) {
          s.viewSpec.focus = null;
        } else if (s.selectedIds.length) {
          // 多選択中の Esc は単一（アンカー）へ戻す（選択自体は残す）。
          s.selectedIds = [];
        } else if (
          s.selection.taskId ||
          s.selection.edgeId ||
          s.selection.aggId
        ) {
          s.selection = noSelection();
        }
      }),
    // 「自分のタスク」＝担当で絞る＋前後1世代の受け渡し先を文脈表示（担当＋前後ビューの既定）。
    quickMyTasks: () => {
      set((s) => {
        s.viewSpec.displayMode = "ISOLATE";
        s.viewSpec.focus = null;
        s.viewSpec.filter = { assignees: ["@me"] };
        s.viewSpec.boundaryUp = 1;
        s.viewSpec.boundaryDown = 1;
      });
      get().fit();
    },
    // 「CPのみ表示」組込みビュー（§2.8）: criticalOnly + ISOLATE で背骨チェーンを抽出。
    quickCriticalOnly: () => {
      set((s) => {
        s.viewSpec.displayMode = "ISOLATE";
        s.viewSpec.focus = null;
        s.viewSpec.filter = { criticalOnly: true };
        s.viewSpec.boundaryUp = 0;
        s.viewSpec.boundaryDown = 0;
        s.cpHighlight = true;
      });
      get().fit();
    },
    toggleCpHighlight: () =>
      set((s) => {
        s.cpHighlight = !s.cpHighlight;
      }),
  };
}
