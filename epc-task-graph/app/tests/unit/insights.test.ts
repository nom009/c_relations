import { describe, it, expect } from "vitest";
import {
  makeTask,
  makeDep,
  computeCpm,
  validateDoc,
  seedDemo,
  daysBetween,
} from "../../src/domain";
import {
  deriveInsights,
  weightedProgress,
  type InsightOptions,
} from "../../src/domain/insights";
import { normalizeTaskPatch } from "../../src/domain/taskEditing";
import { showcaseDoc } from "../../src/domain/showcase";
describe("Project overview decisions", () => {
  it("weights progress by duration and excludes milestone weight", () => {
    expect(
      weightedProgress([
        makeTask({ durationDays: 10, progress: 50 }),
        makeTask({ durationDays: 30, status: "DONE" }),
        makeTask({ isMilestone: true, progress: 0 }),
      ]),
    ).toBe(88);
    expect(weightedProgress([])).toBe(0);
  });
  it("distinguishes pending critical tasks, holds and genuinely ready work", () => {
    const a = makeTask({ status: "DONE" }),
      b = makeTask({ status: "ON_HOLD" }),
      c = makeTask();
    const tasks = [a, b, c],
      deps = [makeDep(a.id, b.id), makeDep(b.id, c.id)],
      cpm = computeCpm(tasks, deps, "2026-09-01");
    const result = deriveInsights(tasks, deps, cpm);
    expect(result.critical.map((t) => t.id)).toEqual([b.id, c.id]);
    expect(result.attention.map((t) => t.id)).toEqual([b.id]);
    expect(result.ready).toHaveLength(0);
  });
  it("a duration change moves the dependent completion date without mutating the source", () => {
    const a = makeTask({ durationDays: 3 }),
      b = makeTask({ durationDays: 2 }),
      deps = [makeDep(a.id, b.id)];
    const baseline = computeCpm([a, b], deps, "2026-09-01");
    const scenario = computeCpm(
      [{ ...a, durationDays: 8 }, b],
      deps,
      "2026-09-01",
    );
    expect(scenario.projectEnd - baseline.projectEnd).toBe(5);
    expect(a.durationDays).toBe(3);
  });
  it("the new example is valid, has milestones and real dependency-derived critical work", () => {
    const doc = showcaseDoc();
    expect(validateDoc(doc).ok).toBe(true);
    const cpm = computeCpm(
      doc.tasks,
      doc.dependencies,
      doc.project.dataDate,
      doc.calendars[0],
    );
    const result = deriveInsights(doc.tasks, doc.dependencies, cpm);
    expect(result.milestones).toHaveLength(5);
    expect(result.attention).toHaveLength(1);
    expect(result.critical.length).toBeGreaterThan(3);
    expect(cpm.projectEnd).toBeGreaterThan(60);
  });
  it("handles a 4,000-task overview without a quadratic dependency scan", () => {
    const doc = seedDemo();
    const cpm = computeCpm(doc.tasks, doc.dependencies, doc.project.dataDate);
    const start = performance.now();
    const result = deriveInsights(doc.tasks, doc.dependencies, cpm);
    expect(result.groups.reduce((n, g) => n + g.tasks.length, 0)).toBe(4000);
    expect(performance.now() - start).toBeLessThan(100);
  });
});
describe("Consistent task editing", () => {
  it("completing sets progress, reopening clears 100%, and milestone durations stay zero", () => {
    expect(normalizeTaskPatch(makeTask(), { status: "DONE" })).toMatchObject({
      status: "DONE",
      progress: 100,
    });
    expect(
      normalizeTaskPatch(makeTask({ status: "DONE", progress: 100 }), {
        status: "IN_PROGRESS",
      }),
    ).toMatchObject({ progress: 0 });
    expect(
      normalizeTaskPatch(makeTask({ isMilestone: true }), { durationDays: 5 }),
    ).toMatchObject({ durationDays: 0 });
  });
  it("clamps invalid values and translates progress into an appropriate status", () => {
    expect(normalizeTaskPatch(makeTask(), { progress: 55 })).toMatchObject({
      progress: 55,
      status: "IN_PROGRESS",
    });
    expect(
      normalizeTaskPatch(makeTask(), { durationDays: -4, progress: 120 }),
    ).toMatchObject({ durationDays: 0, progress: 100, status: "DONE" });
    expect(
      normalizeTaskPatch(makeTask({ status: "ON_HOLD" }), { progress: 30 }),
    ).not.toHaveProperty("status");
  });
});
describe("Progress against the status date (P6)", () => {
  // makeTask は実績・ベースラインを引き継がないため、後から展開して付与する。
  const DATA_DATE = "2026-09-01";
  it("lists overdue work only when today is given, ordered by finish date", () => {
    const long = makeTask({ name: "long", durationDays: 10 });
    const next = makeTask({ name: "next", durationDays: 3 });
    const late = {
      ...makeTask({
        name: "late",
        durationDays: 4,
        status: "IN_PROGRESS",
        progress: 50,
      }),
      actualStart: "2026-08-25",
    };
    const wip = {
      ...makeTask({
        name: "wip",
        durationDays: 10,
        status: "IN_PROGRESS",
        progress: 10,
      }),
      actualStart: "2026-08-31",
    };
    const done = {
      ...makeTask({
        name: "done",
        durationDays: 2,
        status: "DONE",
        progress: 100,
      }),
      actualStart: "2026-08-20",
      actualFinish: "2026-08-21",
    };
    const tasks = [long, next, late, wip, done];
    const cpm = computeCpm(tasks, [], DATA_DATE);
    expect(deriveInsights(tasks, [], cpm).overdue).toEqual([]);
    expect(
      deriveInsights(tasks, [], cpm, { dataDate: DATA_DATE }).overdue,
    ).toEqual([]);
    // late: 残2日で 9/2 終了 ／ next: 9/3 終了 ／ long: 未着手のまま開始日 9/1 を過ぎた
    // wip: 着手済みで 9/9 終了予定 → 対象外 ／ done: 完了 → 対象外
    const overdue = deriveInsights(tasks, [], cpm, {
      today: "2026-09-04",
      dataDate: DATA_DATE,
    }).overdue;
    expect(overdue.map((t) => t.name)).toEqual(["late", "next", "long"]);
  });
  it("reports unfinished slips against the baseline, largest first", () => {
    const one = { ...makeTask({ name: "one", durationDays: 2 }), baselineFinish: "2026-09-01" };
    const early = { ...makeTask({ name: "early", durationDays: 3 }), baselineFinish: "2026-09-10" };
    const finished = {
      ...makeTask({
        name: "finished",
        durationDays: 2,
        status: "DONE",
        progress: 100,
      }),
      actualStart: "2026-08-18",
      actualFinish: "2026-08-20",
      baselineFinish: "2026-08-01",
    };
    const two = { ...makeTask({ name: "two", durationDays: 5 }), baselineFinish: "2026-09-03" };
    const none = makeTask({ name: "none", durationDays: 1 });
    const tasks = [one, early, finished, two, none];
    const result = deriveInsights(tasks, [], computeCpm(tasks, [], DATA_DATE));
    expect(result.slipped.map((s) => [s.task.name, s.days])).toEqual([
      ["two", 2],
      ["one", 1],
    ]);
    expect(result.hasBaseline).toBe(true);
    expect(
      deriveInsights([none], [], computeCpm([none], [], DATA_DATE)).hasBaseline,
    ).toBe(false);
  });
  it("counts days since the status date only when both dates are known", () => {
    const t = makeTask();
    const cpm = computeCpm([t], [], DATA_DATE);
    expect(
      deriveInsights([t], [], cpm, { today: "2026-09-04", dataDate: DATA_DATE })
        .staleDays,
    ).toBe(3);
    expect(
      deriveInsights([t], [], cpm, { today: "2026-09-04" }).staleDays,
    ).toBeNull();
    expect(
      deriveInsights([t], [], cpm, { dataDate: DATA_DATE }).staleDays,
    ).toBeNull();
  });
  it("flags inconsistent actual dates", () => {
    const done = (name: string, actualStart?: string, actualFinish?: string) => ({
      ...makeTask({ name, status: "DONE", progress: 100 }),
      actualStart,
      actualFinish,
    });
    const tasks = [
      done("noFinish"),
      done("reversed", "2026-08-20", "2026-08-10"),
      done("future", "2026-08-20", "2026-09-05"),
      makeTask({ name: "noStart", status: "IN_PROGRESS", progress: 30 }),
      makeTask({ name: "ms", isMilestone: true, status: "DONE", progress: 100 }),
      done("ok", "2026-08-20", "2026-08-25"),
    ];
    const cpm = computeCpm(tasks, [], DATA_DATE);
    const issues = (opts?: InsightOptions) =>
      deriveInsights(tasks, [], cpm, opts).dataIssues.map((i) => [
        i.task.name,
        i.message,
      ]);
    const expected = [
      ["noFinish", "実績完了日が未入力"],
      ["reversed", "実績開始日が実績完了日より後"],
      ["future", "実績日が基準日より後"],
      ["noStart", "実績開始日が未入力"],
    ];
    expect(issues({ dataDate: DATA_DATE })).toEqual(expected);
    // 基準日の指定が無ければ CPM の開始基準日で判定する
    expect(issues()).toEqual(expected);
  });
  it("the example is anchored to a Monday status date with actuals, a baseline and visible slips", () => {
    const doc = showcaseDoc("2026-11-19");
    expect(doc.project.dataDate).toBe("2026-11-16");
    expect(showcaseDoc("2026-11-22").project.dataDate).toBe("2026-11-16");
    expect(validateDoc(doc).ok).toBe(true);
    expect(doc.viewState.collapsedWbs).toEqual([]);
    // 状態は依存順と矛盾しない（完了の先行は完了、着手の先行は着手以上）
    const rank = { NOT_STARTED: 0, ON_HOLD: 1, IN_PROGRESS: 1, DONE: 2 };
    const byId = new Map(doc.tasks.map((t) => [t.id, t]));
    for (const d of doc.dependencies)
      expect(rank[byId.get(d.predecessorId)!.status]).toBeGreaterThanOrEqual(
        rank[byId.get(d.successorId)!.status],
      );
    expect(doc.tasks.every((t) => !!t.baselineStart && !!t.baselineFinish)).toBe(
      true,
    );
    const cpm = computeCpm(
      doc.tasks,
      doc.dependencies,
      doc.project.dataDate,
      doc.calendars[0],
    );
    const result = deriveInsights(doc.tasks, doc.dependencies, cpm, {
      today: "2026-11-19",
      dataDate: doc.project.dataDate,
    });
    expect(result.hasBaseline).toBe(true);
    expect(result.dataIssues).toEqual([]);
    expect(result.staleDays).toBe(3);
    expect(result.slipped[0]).toMatchObject({
      task: { name: "基礎工事" },
      days: 7,
    });
    expect(result.overdue.map((t) => t.name)).toEqual([
      "主要機器の仕様確定",
      "基礎工事",
    ]);
    // 完成は当初計画より1日遅れ
    const baselineEnd = doc.tasks
      .map((t) => t.baselineFinish ?? "")
      .sort()
      .pop()!;
    expect(baselineEnd).toBe("2027-02-02");
    expect(cpm.projectFinishDate).toBe("2027-02-03");
    expect(daysBetween(baselineEnd, cpm.projectFinishDate)).toBe(1);
    // 1週間後に開いても締め日からの見え方は同じ
    const later = showcaseDoc("2026-11-26");
    expect(later.project.dataDate).toBe("2026-11-23");
    expect(
      computeCpm(
        later.tasks,
        later.dependencies,
        later.project.dataDate,
        later.calendars[0],
      ).projectEnd,
    ).toBe(cpm.projectEnd);
  });
});
