// ============================================================================
// UI 操作アクション（store.ts から分割）: ランナー登録・fit・担当者名・トースト・選択/編集・つなぐモード。
// いずれも Undo 対象外の表示状態（つなぐモードの接続/切断は taskActions の CRUD 経由で Undo 可）。
// ============================================================================
import { newId } from "../../domain";
import { LS_ME, writePref } from "../prefs";
import type { AppGet, AppSet, AppState } from "../storeTypes";
import { noSelection } from "../storeUtils";

type UiActions = Pick<
  AppState,
  | "setRunner"
  | "fit"
  | "setMe"
  | "showToast"
  | "setEditing"
  | "setSelection"
  | "setSelectedIds"
  | "toggleSelectedId"
  | "toggleConnectMode"
  | "connectClick"
>;

export function uiActions(set: AppSet, get: AppGet): UiActions {
  return {
    setRunner: (name, fn) =>
      set((s) => {
        s.runners[name] = fn;
      }),
    fit: (delay = 160) =>
      setTimeout(() => {
        get().runners.fitView?.();
      }, delay),
    setMe: (me) => {
      writePref(LS_ME, me);
      set((s) => {
        s.me = me;
        s.viewSpec.me = me;
      });
    },

    showToast: (msg, err = false) => {
      const id = newId();
      set((s) => {
        s.toast.push({ id, msg, err });
      });
      setTimeout(
        () =>
          set((s) => {
            s.toast = s.toast.filter((t) => t.id !== id);
          }),
        5200,
      );
    },

    // ---- 表示状態（Undo対象外）----
    setEditing: (id) =>
      set((s) => {
        s.editingId = id;
      }),
    setSelection: (sel) =>
      set((s) => {
        s.selection = { ...noSelection(), ...sel };
        s.selectedIds = []; // 単一選択に戻す（多選択はテーブルの明示操作でのみ張る）
      }),
    // 範囲選択の確定（Shift+クリック等）: ids をそのまま多選択とし、アンカーを selection.taskId に。
    setSelectedIds: (ids, anchor) =>
      set((s) => {
        const uniq = [...new Set(ids)];
        s.selectedIds = uniq.length > 1 ? uniq : [];
        s.selection = {
          taskId: anchor ?? uniq[uniq.length - 1] ?? null,
          edgeId: null,
          aggId: null,
        };
      }),
    // Cmd/Ctrl+クリックのトグル: id を多選択に足す/外す。アンカーは操作した id（外した時は残りの末尾）。
    toggleSelectedId: (id) =>
      set((s) => {
        const base = s.selectedIds.length
          ? [...s.selectedIds]
          : s.selection.taskId
            ? [s.selection.taskId]
            : [];
        const idx = base.indexOf(id);
        let anchor: string | null;
        if (idx >= 0) {
          base.splice(idx, 1);
          anchor = base[base.length - 1] ?? null;
        } else {
          base.push(id);
          anchor = id;
        }
        s.selectedIds = base.length > 1 ? base : [];
        s.selection = { taskId: anchor, edgeId: null, aggId: null };
      }),

    // ---- つなぐモード（クリックで接続/切断・トラックパッド向けの直感操作）----
    toggleConnectMode: () => {
      const on = !get().connectMode;
      set((s) => {
        s.connectMode = on;
        s.connectSource = null;
      });
      get().showToast(
        on
          ? "つなぐモード: 始点→終点の順にクリック（もう一度で切断・Escで終了）"
          : "つなぐモードを終了しました",
      );
    },
    connectClick: (id) => {
      const s = get();
      if (!s.connectMode) return;
      if (id.startsWith("wbs::")) {
        s.showToast("集約ノードは接続できません。展開してから", true);
        return;
      }
      const src = s.connectSource;
      if (!src) {
        // 始点を選ぶ。
        set((st) => {
          st.connectSource = id;
          st.selection = { taskId: id, edgeId: null, aggId: null };
        });
        return;
      }
      if (src === id) {
        // 始点を再クリック＝選び直し（解除）。
        set((st) => {
          st.connectSource = null;
        });
        return;
      }
      // 既に src→id があれば切断、なければ接続（循環は addDependencyChecked が拒否）。
      const existing = s.dependencies.find(
        (d) => d.predecessorId === src && d.successorId === id,
      );
      if (existing) {
        s.deleteDeps([existing.id]);
        s.showToast("依存を切断しました（元に戻す で復元できます）");
      } else {
        if (s.addDependencyChecked(src, id))
          s.showToast("依存を接続しました");
      }
      // 始点は保持＝A→B, A→C と連続で繋げる。
    },
  };
}
