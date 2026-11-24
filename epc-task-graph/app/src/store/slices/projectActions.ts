// ============================================================================
// ドキュメント/プロジェクト管理アクション（store.ts から分割）: doc 化・全量差替え（loadDoc）・デモ生成・
// 全体整列・プロジェクト属性（名前/基準日/カレンダー/WBS 名称）・複数プロジェクト管理（§6.1）。
// 保存状態（デバウンス保存・全量保存の予約）は persistenceRuntime の操作関数経由で触る。
// useApp は関数本体の中でだけ参照する（モジュール評価時には触れない）。
// ============================================================================
import {
  emptyDoc,
  isValidIsoDate,
  nowISO,
  seedDemo,
  WBS_NAME_MAX,
  WBS_CODE_MAX,
  WBS_NAMES_MAX,
} from "../../domain";
import { runFullLayout } from "../../layout/layout";
import { getRepo, setCurrentProjectId } from "../persistence";
import {
  bumpSaveGeneration,
  clearSaveTimer,
  enqueueWrite,
  flushPersistence,
  getApiHooks,
  hasPendingFullSave,
  isHydrating,
  loadGraphWithRecovery,
  scheduleSave,
  setPendingFullSave,
} from "../persistenceRuntime";
import { useApp } from "../store";
import type { AppGet, AppSet, AppState } from "../storeTypes";
import { emptyDirty, noSelection, readOnlyBlocked } from "../storeUtils";

type ProjectActions = Pick<
  AppState,
  | "toDoc"
  | "loadDoc"
  | "generateDemo"
  | "layoutAll"
  | "renameProject"
  | "setDataDate"
  | "updateCalendar"
  | "setWbsName"
  | "setWbsNames"
  | "refreshProjects"
  | "switchProject"
  | "newProject"
  | "duplicateCurrentProject"
  | "deleteCurrentProject"
>;

export function projectActions(set: AppSet, get: AppGet): ProjectActions {
  return {
    // ---- ドキュメント（doc化・差替え）----
    toDoc: () => {
      const s = get();
      return {
        schemaVersion: s.schemaVersion,
        project: s.project,
        viewState: s.viewState,
        savedViews: s.savedViews,
        calendars: s.calendars,
        tasks: s.tasks,
        dependencies: s.dependencies,
      };
    },
    loadDoc: (doc, opts) => {
      clearSaveTimer();
      bumpSaveGeneration();
      setPendingFullSave(opts?.persist === false || isHydrating() ? null : Symbol());
      set((s) => {
        s.schemaVersion = doc.schemaVersion;
        s.project = doc.project;
        s.viewState = doc.viewState;
        s.savedViews = doc.savedViews;
        s.calendars = doc.calendars;
        s.tasks = doc.tasks;
        s.dependencies = doc.dependencies;
        s.selection = noSelection();
        s.selectedIds = [];
        s.editingId = null;
        s.connectMode = false;
        s.connectSource = null;
        s.viewSpec = {
          filter: {},
          displayMode: "DIM",
          collapsedWbs: doc.viewState.collapsedWbs || [],
          focus: null,
          me: s.me,
        };
        s.expandLevel = doc.viewState.expandLevel || 2;
        s.dirty = emptyDirty();
        s.saveStatus = hasPendingFullSave() ? "dirty" : "saved";
        // サーバー版: 全量置換（インポート等）は新規プロジェクトとして作られ、呼び出し者が所有者になる。
        if (hasPendingFullSave() && getApiHooks()) s.role = "owner";
        s.conflict = null;
      });
      useApp.temporal.getState().clear(); // 新ドキュメントは履歴を持ち越さない
      // loadDoc は「全量差替え」（デモ生成・インポート等）。差分ではなく全量 saveGraph で
      // 永続化する。persist:false（起動時ハイドレート・切替/複製/復元の自前保存）では保存しない。
      if (hasPendingFullSave())
        void flushPersistence().catch(() => undefined);
    },
    generateDemo: () => {
      void flushPersistence()
        .then(() => {
          const doc = seedDemo({ count: 4000 });
          get().loadDoc(doc);
          get().fit(200);
          get().showToast("4,000タスクのデモプロジェクトを開きました");
        })
        .catch(() => undefined);
    },

    // ---- 全体整列（Worker、§2.5）----
    layoutAll: () => {
      get().showToast(
        "全体整列を実行中…（Web Workerで非同期。UIはブロックしません）",
      );
      const s = get();
      runFullLayout(
        s.tasks.map((t) => t.id),
        s.dependencies.map(
          (d) => [d.predecessorId, d.successorId] as [string, string],
        ),
      )
        .then((posMap) => {
          get().applyPositions(posMap);
          get().showToast("全体整列が完了しました（左→右 DAGレイアウト）");
          get().runners.fitView?.();
        })
        .catch(() => get().showToast("全体整列に失敗しました", true));
    },

    // ---- 複数プロジェクト管理（§6.1）----
    renameProject: (name) => {
      if (readOnlyBlocked()) return;
      set((s) => {
        s.project.name = name;
        s.project.updatedAt = nowISO();
      });
      scheduleSave();
    },
    setDataDate: (d) => {
      if (!isValidIsoDate(d)) return; // 空欄・不正値は描画/CPM を壊すため無視
      if (readOnlyBlocked()) return;
      set((s) => {
        s.project.dataDate = d;
        s.project.updatedAt = nowISO();
      });
      scheduleSave();
    },
    updateCalendar: (patch) => {
      if (readOnlyBlocked()) return;
      set((s) => {
        const cal =
          s.calendars.find((c) => c.id === s.project.calendarId) ??
          s.calendars[0];
        if (!cal) return;
        Object.assign(cal, patch);
        s.project.updatedAt = nowISO();
      });
      scheduleSave();
    },
    setWbsName: (code, name) => {
      const key = code.trim();
      if (!key) return;
      get().setWbsNames({ ...(get().project.wbsNames ?? {}), [key]: name });
    },
    setWbsNames: (names) => {
      if (readOnlyBlocked()) return;
      // 前後空白を除き 200 字まで。空の名称はキーごと削除する。サーバー上限（コード長・件数）を超える分は付けない。
      const next: Record<string, string> = {};
      let count = 0;
      for (const [code, name] of Object.entries(names)) {
        const key = code.trim();
        const value = String(name ?? "").trim().slice(0, WBS_NAME_MAX);
        if (!key || !value || key === "__proto__" || key.length > WBS_CODE_MAX) continue;
        if (count >= WBS_NAMES_MAX) break;
        next[key] = value;
        count++;
      }
      const cur = get().project.wbsNames ?? {};
      const curKeys = Object.keys(cur);
      if (
        curKeys.length === Object.keys(next).length &&
        curKeys.every((k) => Object.prototype.hasOwnProperty.call(next, k) && cur[k] === next[k])
      )
        return;
      // wbsNames の参照が変わる → temporal の diff が 1 回の Undo として積む
      set((s) => {
        s.project.wbsNames = next;
        s.project.updatedAt = nowISO();
      });
      scheduleSave();
    },
    refreshProjects: async () => {
      try {
        const list = await getRepo().listProjects();
        set((s) => {
          s.projectList = list;
        });
      } catch {
        /* ignore */
      }
    },
    switchProject: async (id) => {
      try {
        await flushPersistence();
        const { doc, notified } = await loadGraphWithRecovery(id);
        await flushPersistence(); // 読込中の編集を旧プロジェクトへ吐き出してから差し替える
        setCurrentProjectId(id);
        get().loadDoc(doc, { persist: false });
        getApiHooks()?.adoptDoc(doc);
        get().fit(200);
        if (!notified) get().showToast("プロジェクトを切り替えました: " + doc.project.name);
      } catch {
        get().showToast("プロジェクトの読込に失敗しました", true);
      }
    },
    newProject: async (name) => {
      const doc = emptyDoc(name || "新規プロジェクト");
      try {
        await flushPersistence();
        await enqueueWrite(() => getRepo().saveGraph(doc));
        await flushPersistence();
        const apiHooks = getApiHooks();
        if (apiHooks) await apiHooks.afterFullSave(doc.project.id, true);
        setCurrentProjectId(doc.project.id);
        get().loadDoc(doc, { persist: false });
        await get().refreshProjects();
        get().showToast("新規プロジェクトを作成しました");
      } catch {
        get().showToast("プロジェクト作成に失敗しました", true);
      }
    },
    duplicateCurrentProject: async () => {
      const cur = get().project;
      try {
        await flushPersistence();
        const dup = await getRepo().duplicateProject(
          cur.id,
          cur.name + "（複製）",
        );
        await flushPersistence();
        setCurrentProjectId(dup.project.id);
        get().loadDoc(dup, { persist: false });
        getApiHooks()?.adoptDoc(dup);
        await get().refreshProjects();
        get().fit(200);
        get().showToast("プロジェクトを複製しました");
      } catch {
        get().showToast("複製に失敗しました", true);
      }
    },
    deleteCurrentProject: async () => {
      const curId = get().project.id;
      try {
        await flushPersistence();
        await getRepo().deleteProject(curId);
        getApiHooks()?.detach(); // 削除済みプロジェクトをポーリングしない（次の切替で adoptDoc される）
        // 削除待ちの間の編集は書込先が無いので破棄する（保存エラーで切替が止まるのを防ぐ）。
        clearSaveTimer();
        bumpSaveGeneration();
        set((s) => {
          s.dirty = emptyDirty();
          s.saveStatus = "saved";
        });
        const list = await getRepo().listProjects();
        if (list.length) {
          await get().switchProject(list[0].id);
        } else {
          await get().newProject("新規プロジェクト");
        }
        await get().refreshProjects();
        get().showToast("プロジェクトを削除しました");
      } catch {
        get().showToast("削除に失敗しました", true);
      }
    },
  };
}
