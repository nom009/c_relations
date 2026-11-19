import { readFileSync } from "node:fs";
import { openEditor } from "./openEditor";
import { test, expect } from "@playwright/test";

// CSV（Excel）連携: 標準テンプレートを書き出し、そのまま取り込むと新プロジェクトとして復元される。
test("CSV: テンプレート書き出し→取込 で新プロジェクトを作成", async ({ page }) => {
  await page.goto("/");
  await openEditor(page);
  await page.waitForFunction(() => !!(window as any).__APP);
  const beforeProjectId = await page.evaluate(
    () => (window as any).__APP.getState().project.id,
  );

  await page.getByTestId("data-menu").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /CSVテンプレートを書き出す/ }).click(),
  ]);
  const path = await download.path();
  expect(path).toBeTruthy();
  const header = readFileSync(path!, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)[0].split(",");
  expect(header).toHaveLength(16);
  expect([header[0], header[3], header[6], header[15]]).toEqual(["No", "工種", "先行タスク", "ID"]);

  await page.getByTestId("csv-file").setInputFiles(path!);

  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__APP.getState().project.id),
    )
    .not.toBe(beforeProjectId);
  const state = await page.evaluate(() => {
    const s = (window as any).__APP.getState();
    return {
      tasks: s.tasks.length,
      deps: s.dependencies.length,
      dataDate: s.project.dataDate,
      milestone: s.tasks.some((t: any) => t.name === "試運転完了" && t.isMilestone),
    };
  });
  expect(state).toEqual({ tasks: 7, deps: 7, dataDate: "2026-04-01", milestone: true });
});

// 現在のプロジェクトの更新: ID で照合し、名前の変更・ID 無し行の追加・CSV に無い行の削除を1回で反映する。
test("CSV: ID で照合して現在のプロジェクトを更新（追加・更新・削除）", async ({ page }) => {
  await page.goto("/");
  await openEditor(page);
  await page.waitForFunction(() => !!(window as any).__APP);
  await page.evaluate(() => {
    const app = (window as any).__APP.getState();
    const a = app.addTask(
      { wbsCode: "88", name: "CSVUPD-A", durationDays: 4, assignee: "設計課" },
      { edit: false },
    );
    const b = app.addTask({ wbsCode: "88", name: "CSVUPD-B", durationDays: 2 }, { edit: false });
    app.addDependencyChecked(a.id, b.id);
    app.setSelection({ taskId: null });
  });

  // 現在の状態から CSV を組み立てる（A を改名、B を除外、ID 無しの新規行を A の後続に追加）。
  const before = await page.evaluate(() => {
    const s = (window as any).__APP.getState();
    const a = s.tasks.find((t: any) => t.name === "CSVUPD-A");
    const b = s.tasks.find((t: any) => t.name === "CSVUPD-B");
    const keep = s.tasks.filter((t: any) => t.id !== b.id);
    const no = new Map<string, string>(keep.map((t: any, i: number) => [t.id, String(i + 1)]));
    const q = (v: string) => '"' + String(v).replace(/"/g, '""') + '"';
    const lines = ["No,WBS,タスク名,所要日数,先行タスク,ID"];
    for (const t of keep) {
      const preds = s.dependencies
        .filter((d: any) => d.successorId === t.id && no.has(d.predecessorId))
        .map((d: any) => no.get(d.predecessorId) + d.type + (d.lagDays < 0 ? "" : "+") + d.lagDays);
      const name = t.id === a.id ? "CSVUPD-A改" : t.name;
      lines.push(
        [no.get(t.id), q(t.wbsCode), q(name), String(t.durationDays), q(preds.join(",")), t.id].join(","),
      );
    }
    lines.push([String(keep.length + 1), "88", "CSVUPD-NEW", "3", no.get(a.id), ""].join(","));
    return {
      csv: lines.join("\r\n") + "\r\n",
      projectId: s.project.id as string,
      tasks: s.tasks.length as number,
      deps:
        s.dependencies.filter((d: any) => d.predecessorId !== b.id && d.successorId !== b.id)
          .length + 1,
      aId: a.id as string,
      bId: b.id as string,
    };
  });

  await page.getByTestId("csv-update-file").setInputFiles({
    name: "update.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(before.csv, "utf8"),
  });
  await expect(page.getByTestId("csv-merge-dialog")).toBeVisible();
  await expect(page.getByTestId("csv-merge-added")).toHaveText("1");
  await expect(page.getByTestId("csv-merge-updated")).toHaveText("1");
  await expect(page.getByTestId("csv-merge-removed")).toHaveText("1");
  await page.getByTestId("csv-merge-apply").click();

  await expect
    .poll(() =>
      page.evaluate(
        (bId) => !(window as any).__APP.getState().tasks.some((t: any) => t.id === bId),
        before.bId,
      ),
    )
    .toBe(true);
  const after = await page.evaluate(
    ({ aId }) => {
      const s = (window as any).__APP.getState();
      const a = s.tasks.find((t: any) => t.id === aId);
      const n = s.tasks.find((t: any) => t.name === "CSVUPD-NEW");
      return {
        projectId: s.project.id,
        tasks: s.tasks.length,
        deps: s.dependencies.length,
        aName: a?.name,
        aAssignee: a?.assignee,
        newDep: !!n && s.dependencies.some((d: any) => d.predecessorId === aId && d.successorId === n.id),
      };
    },
    { aId: before.aId },
  );
  expect(after).toEqual({
    projectId: before.projectId,
    tasks: before.tasks,
    deps: before.deps,
    aName: "CSVUPD-A改",
    aAssignee: "設計課",
    newDep: true,
  });
});
