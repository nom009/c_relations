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
