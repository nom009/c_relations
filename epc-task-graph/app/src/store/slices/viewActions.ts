// ============================================================================
// ビュー関連アクション（store.ts から分割）: 保存ビュー（§2.8/§12.3.8）・多ビュー表示状態（§12.2）・選択対象の表示。
// 保存ビューは Dexie へ保存（scheduleSave）。表示ビュー/表示列/既定ビューは localStorage に記憶する。
// ============================================================================
import { type SavedView, type TableSort, newId, nowISO, wbsPath } from "../../domain";
import { scheduleSave } from "../persistenceRuntime";
import {
  ALL_TABLE_COLUMNS,
  LS_ACTIVE_VIEW,
  LS_DEFAULT_VIEW,
  LS_TABLE_COLUMNS,
  writePref,
} from "../prefs";
import type { AppGet, AppSet, AppState } from "../storeTypes";
import { noSelection, readOnlyBlocked, setCollapsedWbs } from "../storeUtils";

type ViewActions = Pick<
  AppState,
  | "saveCurrentView"
  | "applyView"
  | "deleteView"
  | "setDefaultView"
  | "setActiveView"
  | "setTableSort"
  | "toggleTableSort"
  | "toggleTableColumn"
  | "revealTask"
>;

export function viewActions(set: AppSet, get: AppGet): ViewActions {
  return {
    // ---- 保存ビュー（§2.8/§12.3.8 PR-T2④）----
    saveCurrentView: (name) => {
      if (readOnlyBlocked()) return;
      const s = get();
      const view: SavedView = {
        id: newId(),
        name: name.trim() || "無題ビュー",
        filter: JSON.parse(JSON.stringify(s.viewSpec.filter)),
        displayMode: s.viewSpec.displayMode,
        collapsedWbs: [...s.viewSpec.collapsedWbs],
        createdBy: s.me,
        updatedAt: nowISO(),
        tableSort: s.tableSort.length
          ? s.tableSort.map((t) => ({ ...t }))
          : undefined,
        tableColumns: [...s.tableColumns],
      };
      set((st) => {
        st.savedViews.push(view);
      });
      scheduleSave();
      get().showToast("ビューを保存しました: " + view.name);
    },
    applyView: (id) => {
      const v = get().savedViews.find((x) => x.id === id);
      if (!v) return;
      set((s) => {
        s.viewSpec.filter = JSON.parse(JSON.stringify(v.filter));
        s.viewSpec.displayMode = v.displayMode;
        setCollapsedWbs(s, [...(v.collapsedWbs ?? [])]);
        s.viewSpec.focus = null;
        if (v.tableSort) {
          s.tableSort = v.tableSort.filter(
            (t) =>
              String(t.key) !== "deps" &&
              (ALL_TABLE_COLUMNS as string[]).includes(t.key),
          ) as TableSort[];
        }
        if (v.tableColumns && v.tableColumns.length) {
          const valid = ALL_TABLE_COLUMNS.filter((k) =>
            v.tableColumns!.includes(k),
          );
          if (valid.length) s.tableColumns = valid;
        }
      });
      writePref(LS_TABLE_COLUMNS, JSON.stringify(get().tableColumns));
      get().fit();
      get().showToast("ビューを適用しました: " + v.name);
    },
    deleteView: (id) => {
      if (readOnlyBlocked()) return;
      set((s) => {
        s.savedViews = s.savedViews.filter((v) => v.id !== id);
        if (s.defaultViewId === id) s.defaultViewId = null; // 既定だったビューを消したら既定も解除
      });
      if (get().defaultViewId === null) writePref(LS_DEFAULT_VIEW, null);
      scheduleSave();
    },
    // 既定ビュー: 同じIDを再指定したら解除（トグル）。起動時に bootstrapStore が自動適用する。
    setDefaultView: (id) => {
      set((s) => {
        s.defaultViewId = s.defaultViewId === id ? null : id;
      });
      writePref(LS_DEFAULT_VIEW, get().defaultViewId);
    },

    // ---- 多ビュー（§12.2）: 表示状態アクション（Undo対象外・Dexie非永続）----
    setActiveView: (v) => {
      writePref(LS_ACTIVE_VIEW, v);
      set((s) => {
        s.activeView = v;
      });
    },
    setTableSort: (sort) =>
      set((s) => {
        s.tableSort = sort;
      }),
    // ヘッダクリック=単独 asc→desc→解除／Shift+クリック=キー追加（PR-T1は単一運用が主）。
    toggleTableSort: (key, additive) =>
      set((s) => {
        const cur = s.tableSort;
        const idx = cur.findIndex((x) => x.key === key);
        if (!additive) {
          if (idx === -1) {
            s.tableSort = [{ key, dir: "asc" }];
          } else if (cur[idx].dir === "asc") {
            s.tableSort = [{ key, dir: "desc" }];
          } else {
            s.tableSort = []; // desc の次は解除（＝WBS自然順へ戻る）
          }
          return;
        }
        // 追加（Shift+クリック）: 既存キーはトグル、無ければ末尾に追加（最大3キー）。
        const next = [...cur];
        if (idx === -1) {
          if (next.length < 3) next.push({ key, dir: "asc" });
        } else if (next[idx].dir === "asc") {
          next[idx] = { key, dir: "desc" };
        } else {
          next.splice(idx, 1);
        }
        s.tableSort = next;
      }),
    toggleTableColumn: (key) => {
      set((s) => {
        const has = s.tableColumns.includes(key);
        s.tableColumns = has
          ? s.tableColumns.filter((k) => k !== key)
          : ALL_TABLE_COLUMNS.filter(
              (k) => k === key || s.tableColumns.includes(k),
            );
      });
      writePref(LS_TABLE_COLUMNS, JSON.stringify(get().tableColumns));
    },
    // 選択対象を必ず見せる（§12.2）: 祖先WBSプレフィックスを collapsedWbs から除去＋選択。
    // 'wbs::'+prefix のID規約は集約ノードと共有。検索ジャンプ（§2.6）にも将来流用。
    revealTask: (taskId) =>
      set((s) => {
        const t = s.tasks.find((x) => x.id === taskId);
        if (!t) return;
        const ancestors = new Set(wbsPath(t.wbsCode));
        setCollapsedWbs(s, s.viewSpec.collapsedWbs.filter((p) => !ancestors.has(p)));
        s.selection = { ...noSelection(), taskId };
        s.selectedIds = [];
      }),
  };
}
