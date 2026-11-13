// ============================================================================
// バックアップ補助: JSON書き出し（最終バックアップ時刻を記録）と、経過日数のリマインド判定。
// ============================================================================
import type { GraphDoc, ProjectMeta } from "../domain";

const LS_LAST_BACKUP = "epc-last-backup-at";
const REMIND_AFTER_DAYS = 7;
const REMIND_AFTER_DAYS_UNPROTECTED = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DownloadOptions {
  // false なら「最終バックアップ日時」を更新しない（復旧前の退避など、通常のエクスポートでない用途）。
  recordBackup?: boolean;
  suffix?: string;
}

export function downloadJson(doc: GraphDoc, opts: DownloadOptions = {}): void {
  const { recordBackup = true, suffix } = opts;
  const blob = new Blob([JSON.stringify(doc, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${doc.project.name}-${new Date().toISOString().slice(0, 10)}${suffix ? `.${suffix}` : ""}.epcgraph.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  if (!recordBackup) return;
  try {
    localStorage.setItem(LS_LAST_BACKUP, new Date().toISOString());
  } catch {
    /* 記録できなくても書き出し自体は成功 */
  }
}

// 最も古いプロジェクトが閾値日数以上前に作られ、かつ直近の閾値日数以内にバックアップが無い時だけ文言を返す。
// 保存領域が未保護（persisted === false。ブラウザが容量不足時に削除しうる）なら閾値を7日→3日に短縮する。
// 作成直後のプロジェクトでは出さない。
export function backupReminderMessage(
  projects: Pick<ProjectMeta, "createdAt">[],
  now: number = Date.now(),
  persisted: boolean | null = null,
): string | null {
  const remindAfterDays = persisted === false ? REMIND_AFTER_DAYS_UNPROTECTED : REMIND_AFTER_DAYS;
  const created = projects
    .map((p) => Date.parse(p.createdAt))
    .filter((t) => Number.isFinite(t));
  if (!created.length) return null;
  if (now - Math.min(...created) < remindAfterDays * DAY_MS) return null;
  let last = NaN;
  try {
    last = Date.parse(localStorage.getItem(LS_LAST_BACKUP) ?? "");
  } catch {
    /* 読めなければ未バックアップ扱い */
  }
  if (!Number.isFinite(last)) {
    return "まだバックアップがありません。JSONエクスポートでバックアップしてください";
  }
  const days = Math.floor((now - last) / DAY_MS);
  if (days < remindAfterDays) return null;
  return `最終バックアップから${days}日経過しています。JSONエクスポートでバックアップしてください`;
}

// ブラウザによる自動削除を避けるため、永続ストレージを要求する。保護済みか（非対応・失敗は null）を返す。
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    const s = typeof navigator !== "undefined" ? navigator.storage : undefined;
    if (!s || typeof s.persisted !== "function" || typeof s.persist !== "function") return null;
    if (await s.persisted()) return true;
    return await s.persist();
  } catch {
    return null;
  }
}
