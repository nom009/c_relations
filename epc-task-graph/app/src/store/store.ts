// ============================================================================
// zustand ストア（§4.2 store層）: domain を包み、Undo/永続化/表示状態を管理。
// - zundo(temporal) + diff（差分保存、§2.3）: JSON.stringify 丸ごと保存は禁止。
// - immer: 不変更新で未変更オブジェクトを参照共有（履歴メモリ対策、§2.3）。
// - ダーティ追跡（§6.1/§7.2 L1の土台）: 変更/削除した行IDを保持し、後PRの savePatch へ渡す。
// 状態のうち temporal が追跡するのは { tasks, dependencies } と project.wbsNames のみ（partialize/diff）。
// viewSpec/selection/collapsed/focus/filter は履歴に含めない（§2.3）。
//
// このファイルは useApp の組み立て（初期状態＋アクションのスライス＋temporal 設定）だけを持つ。
// - storeTypes.ts: AppState などの型 / prefs.ts: localStorage の UI 設定 / storeUtils.ts: 共通ヘルパ
// - persistenceRuntime.ts: デバウンス差分保存・起動時ハイドレート・ApiHooks / history.ts: Undo/Redo
// - slices/: アクション（uiActions / taskActions / displayActions / viewActions / projectActions）
// 分割先のモジュールは useApp を関数本体の中でだけ参照する（循環 import でも評価順に依存しない）。
// ============================================================================
import { create } from "zustand";
import { temporal } from "zundo";
import { immer } from "zustand/middleware/immer";
import { enableMapSet } from "immer";
import { showcaseDoc } from "../domain/showcase";
import {
  LS_DEFAULT_VIEW,
  initialActiveView,
  initialMe,
  initialTableColumns,
  readPref,
} from "./prefs";
import type { AppState } from "./storeTypes";
import { emptyDirty, noSelection } from "./storeUtils";
import { displayActions } from "./slices/displayActions";
import { projectActions } from "./slices/projectActions";
import { taskActions } from "./slices/taskActions";
import { uiActions } from "./slices/uiActions";
import { viewActions } from "./slices/viewActions";

export { ALL_TABLE_COLUMNS } from "./prefs";
export type {
  ApiHooks,
  AppState,
  ConflictState,
  DirtyState,
  Runners,
  Selection,
  ToastItem,
} from "./storeTypes";
export {
  explainReject,
  nameOf,
  selectActiveCalendar,
  selectReadOnly,
} from "./storeUtils";
export {
  bootstrapStore,
  flushPersistence,
  installApiHooks,
  isFlushing,
} from "./persistenceRuntime";

enableMapSet();

const doc0 = showcaseDoc();
const me0 = initialMe();

export const useApp = create<AppState>()(
  temporal(
    immer((set, get) => ({
      schemaVersion: doc0.schemaVersion,
      project: doc0.project,
      viewState: doc0.viewState,
      savedViews: doc0.savedViews,
      calendars: doc0.calendars,
      tasks: doc0.tasks,
      dependencies: doc0.dependencies,

      me: me0,
      viewSpec: {
        filter: {},
        displayMode: "DIM",
        collapsedWbs: doc0.viewState.collapsedWbs || [],
        focus: null,
        me: me0,
      },
      expandLevel: doc0.viewState.expandLevel || 2,
      selection: noSelection(),
      selectedIds: [],
      editingId: null,
      toast: [],
      saveStatus: "saved",
      dirty: emptyDirty(),
      role: null,
      account: null,
      conflict: null,
      runners: {},
      cpHighlight: false,
      connectMode: false,
      connectSource: null,
      lastConnected: null,
      burst: null,
      projectList: [],
      storagePersisted: null,
      activeView: initialActiveView(),
      tableSort: [],
      tableColumns: initialTableColumns(),
      defaultViewId: readPref(LS_DEFAULT_VIEW) || null,

      ...uiActions(set, get),
      ...taskActions(set, get),
      ...displayActions(set, get),
      ...viewActions(set, get),
      ...projectActions(set, get),
    })),
    {
      // temporal 追跡は tasks/dependencies（§2.3）と project.wbsNames のみ。
      partialize: (state): Pick<AppState, "tasks" | "dependencies" | "project"> => ({
        tasks: state.tasks,
        dependencies: state.dependencies,
        project: state.project,
      }),
      limit: 100,
      // 差分保存（§2.3）: 参照が変わったキーだけを、その「変更前の値」で保存する。
      // immer の構造共有により未変更 Task/Dep オブジェクトは参照共有され、メモリ膨張しない。
      diff: (pastState, currentState) => {
        const delta: Partial<Pick<AppState, "tasks" | "dependencies" | "project">> = {};
        let changed = false;
        if (pastState.tasks !== currentState.tasks) {
          delta.tasks = pastState.tasks;
          changed = true;
        }
        if (pastState.dependencies !== currentState.dependencies) {
          delta.dependencies = pastState.dependencies;
          changed = true;
        }
        // project は WBS 名称が変わった時だけ積む（名前・基準日等の編集は履歴対象外）。
        // Undo/Redo 時は差分側に project が無いことがあるため両方ある時のみ比較する。
        if (
          pastState.project &&
          currentState.project &&
          pastState.project.wbsNames !== currentState.project.wbsNames
        ) {
          delta.project = pastState.project;
          changed = true;
        }
        return changed ? delta : null;
      },
    },
  ),
);
