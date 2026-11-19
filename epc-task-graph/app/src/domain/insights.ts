import type { Task, Dependency } from "./types";
import type { CpmResult } from "./cpm";
import { DISCIPLINES } from "./constants";
import { daysBetween, finishVariance } from "./schedule";
/** 概要の判定に使う日付。today 省略時は期限超過・基準日の経過日数を出さない（純関数を保つ）。 */
export interface InsightOptions {
  today?: string;
  dataDate?: string;
}
/** 実績入力の不整合（概要に一覧表示する）。 */
export interface DataIssue {
  task: Task;
  message: string;
}
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
  opts: InsightOptions = {},
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
  // 期限超過: 予定終了日が今日より前、または未着手のまま予定開始日を過ぎた未完了タスク。
  const today = opts.today ?? "";
  const overdue = today
    ? open
        .filter((t) => {
          const r = cpm.byTask.get(t.id);
          if (!r) return false;
          return (
            r.finishDate < today || (r.state === "planned" && r.esDate < today)
          );
        })
        .sort((a, b) => {
          const fa = cpm.byTask.get(a.id)?.finishDate ?? "";
          const fb = cpm.byTask.get(b.id)?.finishDate ?? "";
          return fa < fb ? -1 : fa > fb ? 1 : 0;
        })
    : [];
  // ベースライン比の遅れ（暦日・正=遅れ）。大きい順。
  const slipped: { task: Task; days: number }[] = [];
  for (const t of open) {
    const days = finishVariance(t, cpm.byTask.get(t.id));
    if (days != null && days > 0) slipped.push({ task: t, days });
  }
  slipped.sort((a, b) => b.days - a.days);
  const staleDays =
    opts.dataDate && today ? daysBetween(opts.dataDate, today) : null;
  const hasBaseline = tasks.some((t) => !!t.baselineFinish);
  // 実績入力の不整合。基準日は opts.dataDate、無ければ CPM の開始基準日。
  const dataDate = (opts.dataDate || cpm.projectStartDate || "").slice(0, 10);
  const dataIssues: DataIssue[] = [];
  for (const t of tasks) {
    const sAct = (t.actualStart || "").slice(0, 10);
    const fAct = (t.actualFinish || "").slice(0, 10);
    if (t.status === "DONE" && !t.isMilestone && !fAct)
      dataIssues.push({ task: t, message: "実績完了日が未入力" });
    if (sAct && fAct && sAct > fAct)
      dataIssues.push({ task: t, message: "実績開始日が実績完了日より後" });
    if (dataDate && ((sAct && sAct > dataDate) || (fAct && fAct > dataDate)))
      dataIssues.push({ task: t, message: "実績日が基準日より後" });
    if (t.status === "IN_PROGRESS" && !sAct)
      dataIssues.push({ task: t, message: "実績開始日が未入力" });
  }
  return {
    progress: weightedProgress(tasks),
    done: tasks.filter((t) => t.status === "DONE").length,
    critical,
    attention,
    milestones,
    groups,
    ready,
    overdue,
    slipped,
    staleDays,
    hasBaseline,
    dataIssues,
  };
}
export function shortDate(iso?: string): string {
  if (!iso) return "—";
  const parts = iso.split("-");
  return `${Number(parts[1])}/${Number(parts[2])}`;
}
