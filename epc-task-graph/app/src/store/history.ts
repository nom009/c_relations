// ============================================================================
// Undo / Redo（zundo temporal 経由、store.ts から分割）。戻した行もダーティ扱いにする（§2.3）。
// useApp は関数本体の中でだけ参照する（モジュール評価時には触れない）。
// ============================================================================
import { nowISO, type ProjectMeta } from "../domain";
import { scheduleSave } from "./persistenceRuntime";
import { useApp } from "./store";
import { readOnlyBlocked } from "./storeUtils";

export function restoreHistory(direction: "undo" | "redo"): void {
  if (readOnlyBlocked()) return;
  const before = useApp.getState();
  const beforeTasks = new Map(before.tasks.map((t) => [t.id, t]));
  const beforeDeps = new Map(before.dependencies.map((d) => [d.id, d]));
  useApp.temporal.getState()[direction]();
  // 変わった行だけをダーティにする（immer の構造共有により未変更行は同一参照）。
  // 参照比較は draft ではなく確定済み状態で行う。
  const after = useApp.getState();
  const currentTasks = new Map(after.tasks.map((t) => [t.id, t]));
  const currentDeps = new Map(after.dependencies.map((d) => [d.id, d]));
  const changedTasks: string[] = [];
  const removedTasks: string[] = [];
  for (const id of new Set([...beforeTasks.keys(), ...currentTasks.keys()])) {
    if (!currentTasks.has(id)) removedTasks.push(id);
    else if (beforeTasks.get(id) !== currentTasks.get(id)) changedTasks.push(id);
  }
  const changedDeps: string[] = [];
  const removedDeps: string[] = [];
  for (const id of new Set([...beforeDeps.keys(), ...currentDeps.keys()])) {
    if (!currentDeps.has(id)) removedDeps.push(id);
    else if (beforeDeps.get(id) !== currentDeps.get(id)) changedDeps.push(id);
  }
  useApp.setState((s) => {
    for (const id of changedTasks) {
      s.dirty.tasks.add(id);
      s.dirty.deletedTasks.delete(id);
    }
    for (const id of removedTasks) {
      s.dirty.tasks.delete(id);
      s.dirty.deletedTasks.add(id);
    }
    for (const id of changedDeps) {
      s.dirty.deps.add(id);
      s.dirty.deletedDeps.delete(id);
    }
    for (const id of removedDeps) {
      s.dirty.deps.delete(id);
      s.dirty.deletedDeps.add(id);
    }
    s.selectedIds = s.selectedIds.filter((id) => currentTasks.has(id));
    if (s.connectSource && !currentTasks.has(s.connectSource))
      s.connectSource = null;
    if (s.selection.taskId && !currentTasks.has(s.selection.taskId))
      s.selection.taskId = null;
    // project は履歴から WBS 名称だけを戻す（名前・基準日・version は巻き戻さない）
    if (after.project !== before.project) {
      const project: ProjectMeta = { ...before.project, updatedAt: nowISO() };
      if (after.project.wbsNames) project.wbsNames = after.project.wbsNames;
      else delete project.wbsNames;
      s.project = project;
    }
  });
  scheduleSave();
}
