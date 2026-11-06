import type { Task, Dependency } from "./types";
import type { CpmResult } from "./cpm";
import { DISCIPLINES } from "./constants";
export function weightedProgress(tasks: Task[]): number {
  const work = tasks.filter((t) => !t.isMilestone);
  const total = work.reduce((sum, t) => sum + Math.max(0, t.durationDays), 0);
  if (!total)
    return tasks.length
      ? Math.round(
          tasks.reduce(
            (s, t) => s + (t.status === "DONE" ? 100 : t.progress),
            0,
          ) / tasks.length,
        )
      : 0;
  return Math.round(
    work.reduce(
      (sum, t) =>
        sum +
        Math.max(0, t.durationDays) * (t.status === "DONE" ? 100 : t.progress),
      0,
    ) / total,
  );
}
export function deriveInsights(
  tasks: Task[],
  deps: Dependency[],
  cpm: CpmResult,
) {
  const open = tasks.filter((t) => t.status !== "DONE");
  const critical = open
    .filter((t) => cpm.criticalTasks.has(t.id))
    .sort(
      (a, b) =>
        (cpm.byTask.get(a.id)?.es ?? 0) - (cpm.byTask.get(b.id)?.es ?? 0),
    );
  const attention = open.filter(
    (t) =>
      t.status === "ON_HOLD" || (cpm.byTask.get(t.id)?.totalFloat ?? 0) < 0,
  );
  const milestones = tasks
    .filter((t) => t.isMilestone)
    .sort(
      (a, b) =>
        (cpm.byTask.get(a.id)?.ef ?? 0) - (cpm.byTask.get(b.id)?.ef ?? 0),
    );
  const groups = DISCIPLINES
    .map((d) => ({
      discipline: d,
      tasks: tasks.filter((t) => t.discipline === d),
    }))
    .filter((g) => g.tasks.length);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const blocked = new Set(
    deps
      .filter((d) => byId.get(d.predecessorId)?.status !== "DONE")
      .map((d) => d.successorId),
  );
  const ready = open.filter(
    (t) => t.status === "NOT_STARTED" && !blocked.has(t.id),
  );
  return {
    progress: weightedProgress(tasks),
    done: tasks.filter((t) => t.status === "DONE").length,
    critical,
    attention,
    milestones,
    groups,
    ready,
  };
}
export function shortDate(iso?: string): string {
  if (!iso) return "—";
  const parts = iso.split("-");
  return `${Number(parts[1])}/${Number(parts[2])}`;
}
