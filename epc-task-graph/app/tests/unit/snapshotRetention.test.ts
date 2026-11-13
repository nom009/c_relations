import { describe, it, expect } from "vitest";
import { selectSnapshotsToKeep } from "../../src/storage/DexieRepository";

const at = (day: number, hour: number) => new Date(2026, 0, day, hour).toISOString();

describe("selectSnapshotsToKeep", () => {
  it("keeps everything when there are few rows", () => {
    const rows = [1, 2, 3].map((seq) => ({ seq, createdAt: at(10, seq) }));
    expect([...selectSnapshotsToKeep(rows)].sort()).toEqual([1, 2, 3]);
  });

  it("keeps the newest 5 plus the newest row of each older local day (max 7 days)", () => {
    const rows: { seq: number; createdAt: string }[] = [];
    let seq = 0;
    // 古い順に10日分、各日に3件
    for (let day = 1; day <= 10; day++)
      for (const hour of [9, 12, 15]) rows.push({ seq: ++seq, createdAt: at(day, hour) });
    const keep = selectSnapshotsToKeep(rows);
    // 直近5件: seq 26..30（10日の3件と9日の2件）
    for (const s of [26, 27, 28, 29, 30]) expect(keep.has(s)).toBe(true);
    // それ以前は日ごとに最新1件（9日→3日の7日分）
    expect(keep.has(25)).toBe(true); // 9日の残り
    expect(keep.has(24)).toBe(true); // 8日の最新
    expect(keep.has(23)).toBe(false);
    expect(keep.has(22)).toBe(false);
    expect(keep.has(9)).toBe(true); // 3日の最新
    expect(keep.has(6)).toBe(false); // 2日は8日目になるため対象外
    expect(keep.size).toBe(5 + 7);
  });

  it("drops rows with an unparsable timestamp unless they are recent", () => {
    const rows = [
      { seq: 1, createdAt: "broken" },
      ...[2, 3, 4, 5, 6, 7].map((seq) => ({ seq, createdAt: at(10, seq) })),
    ];
    const keep = selectSnapshotsToKeep(rows);
    expect(keep.has(1)).toBe(false);
    expect(keep.has(7)).toBe(true);
  });
});
