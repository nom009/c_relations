import { afterEach, describe, it, expect, vi } from "vitest";
import { backupReminderMessage } from "../../src/store/backup";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-01-31T00:00:00Z");
const iso = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();

function stubBackup(value: string | null) {
  vi.stubGlobal("localStorage", { getItem: () => value });
}

afterEach(() => vi.unstubAllGlobals());

describe("backupReminderMessage", () => {
  it("stays quiet for freshly created projects", () => {
    stubBackup(null);
    expect(backupReminderMessage([{ createdAt: iso(1) }], now)).toBeNull();
  });

  it("reminds when an old project was never backed up", () => {
    stubBackup(null);
    expect(backupReminderMessage([{ createdAt: iso(30) }], now)).toMatch(/まだバックアップがありません/);
  });

  it("reminds with elapsed days when the last backup is stale, not when recent", () => {
    stubBackup(iso(10));
    expect(backupReminderMessage([{ createdAt: iso(30) }], now)).toMatch(/10日経過/);
    stubBackup(iso(2));
    expect(backupReminderMessage([{ createdAt: iso(30) }], now)).toBeNull();
  });
});
