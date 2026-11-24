// ============================================================================
// タスク/依存のデータ編集アクション（store.ts から分割）: CRUD・一括更新・CSV 取込・ベースライン・Undo/Redo。
// いずれもダーティ追跡付きで scheduleSave する。1回の set() ＝ 1 Undo 単位（zundo）。
// ============================================================================
import { baselinePatch, todayIso } from "../../domain/schedule";
import {
  type Dependency,
  type Task,
  canConnect,
  clampLagDays,
  csvFieldsEqual,
  makeDep,
  makeTask,
  nowISO,
  pickCsvFields,
} from "../../domain";
import { restoreHistory } from "../history";
import { scheduleSave } from "../persistenceRuntime";
import { selectCpm } from "../selectors";
import type { AppGet, AppSet, AppState } from "../storeTypes";
import {
  cpmForStatusEdit,
  currentWbsContext,
  explainReject,
  noSelection,
  patchWithActuals,
  readOnlyBlocked,
  selectActiveCalendar,
} from "../storeUtils";

type TaskActions = Pick<
  AppState,
  | "addTask"
  | "updateTask"
  | "setPosition"
  | "applyPositions"
  | "deleteTasks"
  | "addDependencyChecked"
  | "updateDep"
  | "deleteDeps"
  | "createSuccessor"
  | "bulkUpdateTasks"
  | "applyCsvMerge"
  | "setBaseline"
  | "clearBaseline"
  | "undo"
  | "redo"
>;

export function taskActions(set: AppSet, get: AppGet): TaskActions {
  return {
    // ---- タスク/依存 CRUD（ダーティ追跡付き）----
    addTask: (p = {}, { edit = true } = {}) => {
      if (readOnlyBlocked()) return makeTask({ ...p }, get().me);
      const t = makeTask(
        {
          ...p,
          wbsCode: p.wbsCode != null ? p.wbsCode : currentWbsContext() || "",
          updatedBy: get().me,
        },
        get().me,
      );
      set((s) => {
        s.tasks.push(t);
        s.dirty.tasks.add(t.id);
        s.selection = { taskId: t.id, edgeId: null, aggId: null };
        s.selectedIds = [];
        s.editingId = edit ? t.id : null;
      });
      scheduleSave();
      return t;
    },
    updateTask: (id, patch) => {
      if (readOnlyBlocked()) return;
      const cpm = cpmForStatusEdit(patch);
      const today = todayIso();
      set((s) => {
        const t = s.tasks.find((x) => x.id === id);
        if (!t) return;
        Object.assign(t, patchWithActuals(t, patch, cpm, today));
        t.rev += 1;
        t.updatedAt = nowISO();
        t.updatedBy = s.me;
        s.dirty.tasks.add(id);
      });
      scheduleSave();
    },
    setPosition: (id, pos) => {
      if (readOnlyBlocked()) return;
      set((s) => {
        const t = s.tasks.find((x) => x.id === id);
        if (!t) return;
        t.position = pos;
        s.dirty.tasks.add(id);
      });
      scheduleSave();
    },
    applyPositions: (map) => {
      if (readOnlyBlocked()) return;
      set((s) => {
        for (const t of s.tasks) {
          if (map[t.id]) {
            t.position = map[t.id];
            s.dirty.tasks.add(t.id);
          }
        }
      });
      scheduleSave();
    },
    deleteTasks: (ids) => {
      if (readOnlyBlocked()) return;
      const idset = new Set(ids);
      set((s) => {
        s.tasks = s.tasks.filter((t) => !idset.has(t.id));
        // 付随する依存も削除として記録する（DB 側に連鎖削除はない）。
        s.dependencies = s.dependencies.filter((d) => {
          const keep =
            !idset.has(d.predecessorId) && !idset.has(d.successorId);
          if (!keep) s.dirty.deletedDeps.add(d.id);
          return keep;
        });
        for (const id of ids) s.dirty.deletedTasks.add(id);
        s.selectedIds = s.selectedIds.filter((id) => !idset.has(id));
        if (s.connectSource && idset.has(s.connectSource))
          s.connectSource = null;
        if (s.selection.taskId && idset.has(s.selection.taskId))
          s.selection = {
            taskId: s.selectedIds[s.selectedIds.length - 1] || null,
            edgeId: null,
            aggId: null,
          };
      });
      scheduleSave();
      if (ids.length > 1)
        get().showToast(
          ids.length + "件削除しました（元に戻す で復元できます）",
        );
    },
    addDependencyChecked: (source, target) => {
      if (readOnlyBlocked()) return false;
      const tasks = get().tasks;
      if (
        !tasks.some((t) => t.id === source) ||
        !tasks.some((t) => t.id === target)
      )
        return false; // 削除済みタスクへの依存（孤児行）を作らない
      const chk = canConnect(source, target, get().dependencies);
      if (!chk.ok) {
        get().showToast(explainReject(chk, get()), true);
        return false;
      }
      const dep = makeDep(source, target, {}, get().me);
      set((s) => {
        s.dependencies.push(dep);
        s.dirty.deps.add(dep.id);
        s.lastConnected = { id: dep.id, at: Date.now() }; // 通電エフェクトのトリガ
        s.burst = { source, target }; // 両端ノードに回路が走る演出のトリガ
      });
      // ワンショット。終点側の発光が終わる頃に消す（その後に別の接続をしていなければ）。
      setTimeout(() => {
        const b = get().burst;
        if (b && b.source === source && b.target === target)
          set((s) => {
            s.burst = null;
          });
      }, 1500);
      scheduleSave();
      return true;
    },
    updateDep: (id, patch) => {
      if (readOnlyBlocked()) return;
      set((s) => {
        const d = s.dependencies.find((x) => x.id === id);
        if (!d) return;
        const next =
          patch.lagDays === undefined
            ? patch
            : { ...patch, lagDays: clampLagDays(patch.lagDays) };
        Object.assign(d, next);
        d.rev += 1;
        d.updatedAt = nowISO();
        d.updatedBy = s.me;
        s.dirty.deps.add(id);
      });
      scheduleSave();
    },
    deleteDeps: (ids) => {
      if (readOnlyBlocked()) return;
      const idset = new Set(ids);
      set((s) => {
        s.dependencies = s.dependencies.filter((d) => !idset.has(d.id));
        for (const id of ids) s.dirty.deletedDeps.add(id);
      });
      scheduleSave();
    },
    createSuccessor: (sourceId) => {
      if (readOnlyBlocked()) return;
      const src = get().tasks.find((t) => t.id === sourceId);
      if (!src) return;
      const pos = { x: src.position.x + 220, y: src.position.y };
      const t = makeTask(
        { wbsCode: src.wbsCode, discipline: src.discipline, position: pos },
        get().me,
      );
      const dep = makeDep(sourceId, t.id, {}, get().me);
      set((s) => {
        s.tasks.push(t);
        s.dependencies.push(dep);
        s.dirty.tasks.add(t.id);
        s.dirty.deps.add(dep.id);
        s.selection = { taskId: t.id, edgeId: null, aggId: null };
        s.selectedIds = [];
        s.editingId = t.id;
      });
      scheduleSave();
    },

    // 一括更新（削除/ステータス/担当/工種）: 1回の set() ＝ 1 Undo単位（zundo は状態差分で1エントリ）。
    bulkUpdateTasks: (ids, patch) => {
      if (readOnlyBlocked()) return;
      const idset = new Set(ids);
      const cpm = cpmForStatusEdit(patch);
      const today = todayIso();
      set((s) => {
        const now = nowISO();
        for (const t of s.tasks) {
          if (!idset.has(t.id)) continue;
          Object.assign(t, patchWithActuals(t, patch, cpm, today));
          t.rev += 1;
          t.updatedAt = now;
          t.updatedBy = s.me;
          s.dirty.tasks.add(t.id);
        }
      });
      scheduleSave();
    },
    // CSV 更新取込（planCsvMerge の結果）: 1回の set() ＝ 1 Undo。変わった行だけ rev を上げてダーティにする。
    applyCsvMerge: (plan) => {
      if (readOnlyBlocked()) return;
      const addedIds = new Set(plan.addedIds);
      const removedTaskIds = new Set(plan.removedTasks.map((t) => t.id));
      const removedDepIds = new Set(plan.removedDepIds);
      const planTaskIds = new Set(plan.tasks.map((t) => t.id));
      const planDepIds = new Set(plan.dependencies.map((d) => d.id));
      set((s) => {
        const now = nowISO();
        const curTasks = new Map(s.tasks.map((t) => [t.id, t]));
        const tasks: Task[] = [];
        for (const p of plan.tasks) {
          const t = curTasks.get(p.id);
          if (t) {
            if (!csvFieldsEqual(t, p)) {
              Object.assign(t, pickCsvFields(p));
              t.rev += 1;
              t.updatedAt = now;
              t.updatedBy = s.me;
              s.dirty.tasks.add(t.id);
              s.dirty.deletedTasks.delete(t.id);
            }
            tasks.push(t);
          } else if (addedIds.has(p.id)) {
            tasks.push({ ...p, rev: 1, createdAt: now, updatedAt: now, updatedBy: s.me });
            s.dirty.tasks.add(p.id);
            s.dirty.deletedTasks.delete(p.id);
          }
        }
        for (const t of s.tasks) {
          if (planTaskIds.has(t.id)) continue;
          if (removedTaskIds.has(t.id)) {
            s.dirty.tasks.delete(t.id);
            s.dirty.deletedTasks.add(t.id);
          } else tasks.push(t); // 計画後に増えた行は残す
        }
        const alive = new Set(tasks.map((t) => t.id));
        const curDeps = new Map(s.dependencies.map((d) => [d.id, d]));
        const deps: Dependency[] = [];
        const used = new Set<string>();
        const pairs = new Set<string>();
        const pairOf = (d: Dependency) => d.predecessorId + ">" + d.successorId;
        for (const p of plan.dependencies) {
          if (!alive.has(p.predecessorId) || !alive.has(p.successorId) || pairs.has(pairOf(p))) continue;
          pairs.add(pairOf(p));
          const d = curDeps.get(p.id);
          if (d) {
            if (d.type !== p.type || d.lagDays !== p.lagDays) {
              d.type = p.type;
              d.lagDays = clampLagDays(p.lagDays);
              d.rev += 1;
              d.updatedAt = now;
              d.updatedBy = s.me;
              s.dirty.deps.add(d.id);
              s.dirty.deletedDeps.delete(d.id);
            }
            used.add(d.id);
            deps.push(d);
          } else {
            deps.push({ ...p, rev: 1, updatedAt: now, updatedBy: s.me });
            s.dirty.deps.add(p.id);
            s.dirty.deletedDeps.delete(p.id);
          }
        }
        for (const d of s.dependencies) {
          if (used.has(d.id)) continue;
          const stray = !planDepIds.has(d.id) && !removedDepIds.has(d.id);
          if (stray && alive.has(d.predecessorId) && alive.has(d.successorId) && !pairs.has(pairOf(d))) {
            pairs.add(pairOf(d));
            deps.push(d);
          } else {
            s.dirty.deps.delete(d.id);
            s.dirty.deletedDeps.add(d.id);
          }
        }
        s.tasks = tasks;
        s.dependencies = deps;
        s.selectedIds = s.selectedIds.filter((id) => alive.has(id));
        if (s.connectSource && !alive.has(s.connectSource)) s.connectSource = null;
        if (s.editingId && !alive.has(s.editingId)) s.editingId = null;
        if (s.selection.taskId && !alive.has(s.selection.taskId)) s.selection = noSelection();
        if (s.selection.edgeId && !deps.some((d) => d.id === s.selection.edgeId)) s.selection.edgeId = null;
      });
      scheduleSave();
    },
    // ベースライン保存: 現在の CPM の開始/終了（その日を含む）を写す。1回の set() ＝ 1 Undo。
    setBaseline: (ids) => {
      if (readOnlyBlocked()) return;
      const st = get();
      const cpm = selectCpm(st.tasks, st.dependencies, st.project.dataDate, selectActiveCalendar(st));
      const target = ids ? new Set(ids) : null;
      let count = 0;
      set((s) => {
        const now = nowISO();
        for (const t of s.tasks) {
          if (target && !target.has(t.id)) continue;
          const r = cpm.byTask.get(t.id);
          if (!r) continue;
          count += 1;
          const b = baselinePatch(r);
          if (t.baselineStart === b.baselineStart && t.baselineFinish === b.baselineFinish) continue;
          Object.assign(t, b);
          t.rev += 1;
          t.updatedAt = now;
          t.updatedBy = s.me;
          s.dirty.tasks.add(t.id);
        }
      });
      scheduleSave();
      get().showToast(`ベースラインを保存しました（${count}件）`);
    },
    clearBaseline: () => {
      if (readOnlyBlocked()) return;
      let count = 0;
      set((s) => {
        const now = nowISO();
        for (const t of s.tasks) {
          if (t.baselineStart == null && t.baselineFinish == null) continue;
          count += 1;
          t.baselineStart = null;
          t.baselineFinish = null;
          t.rev += 1;
          t.updatedAt = now;
          t.updatedBy = s.me;
          s.dirty.tasks.add(t.id);
        }
      });
      scheduleSave();
      get().showToast(`ベースラインをクリアしました（${count}件）`);
    },

    // ---- Undo / Redo（zundo temporal 経由。戻した行もダーティ扱い、§2.3）----
    undo: () => restoreHistory("undo"),
    redo: () => restoreHistory("redo"),
  };
}
