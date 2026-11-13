import type { Task } from "./types";
import { clampDays } from "./schema";
/** Keep values created by the editor internally consistent without migrating imported records. */
export function normalizeTaskPatch(
  task: Task,
  patch: Partial<Task>,
): Partial<Task> {
  const next = { ...patch };
  if (next.progress !== undefined)
    next.progress = Math.round(
      Math.max(
        0,
        Math.min(100, Number.isFinite(next.progress) ? next.progress : 0),
      ),
    );
  if (next.durationDays !== undefined) next.durationDays = clampDays(next.durationDays);
  if (next.status === "DONE") next.progress = 100;
  else if (next.status === "NOT_STARTED") next.progress = 0;
  else if (
    next.status !== undefined &&
    task.status === "DONE" &&
    next.progress === undefined
  )
    next.progress = 0;
  if (next.status === undefined && next.progress !== undefined) {
    if (next.progress === 100) next.status = "DONE";
    else if (task.status === "DONE")
      next.status = next.progress === 0 ? "NOT_STARTED" : "IN_PROGRESS";
    else if (next.progress > 0 && task.status === "NOT_STARTED")
      next.status = "IN_PROGRESS";
  }
  if (next.isMilestone ?? task.isMilestone) next.durationDays = 0;
  return next;
}
