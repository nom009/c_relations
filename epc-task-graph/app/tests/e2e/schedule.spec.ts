import { openEditor } from "./openEditor";
import { test, expect } from "@playwright/test";

// 進捗スケジュール（P6 方式）: ステータスを進行中にすると実績開始日が自動で記録され、
// ベースライン保存後は計画との差異が詳細パネルと概要（ベースライン比の遅れ）に出る。
test("進捗: 進行中で実績開始日を記録し、ベースライン比の遅れを表示する", async ({
  page,
}) => {
  await page.goto("/");
  await openEditor(page);
  await page.waitForFunction(() => !!(window as any).__APP);

  // サンプル工程（実績日つき）を除き、全曜日稼働・過去の基準日で決定的に（実績開始＝基準日）。
  const id = await page.evaluate(() => {
    const app = (window as any).__APP.getState();
    app.deleteTasks(app.tasks.map((t: any) => t.id));
    app.updateCalendar({ workingDays: [0, 1, 2, 3, 4, 5, 6] });
    app.setDataDate("2025-06-02");
    const t = app.addTask({ wbsCode: "97", name: "SCHED-E2E", durationDays: 3 });
    app.setSelection({ taskId: t.id });
    return t.id as string;
  });

  const inspector = page.locator(".redesigned-inspector");
  await inspector
    .getByRole("combobox", { name: /^ステータス/ })
    .selectOption("IN_PROGRESS");
  await inspector.getByRole("tab", { name: "日程", exact: true }).click();
  await expect(page.getByTestId("actual-start")).toHaveValue("2025-06-02");
  await expect(page.getByTestId("schedule-note")).toContainText("着手済み");
  await expect(page.getByTestId("baseline-variance")).toHaveText("—");

  // 操作メニューから現在の計画をベースラインとして保存 → 差異なし。
  await page.getByTestId("actions-menu").click();
  await page
    .getByRole("button", { name: "ベースラインを保存（現在の計画）", exact: true })
    .click();
  await expect(page.getByTestId("baseline-variance")).toHaveText("差異なし");

  // 工期を 3→5 日に延ばすと、ベースライン比 +2 日の遅れ。
  await page.evaluate(
    (tid) =>
      (window as any).__APP.getState().updateTask(tid, { durationDays: 5 }),
    id,
  );
  await expect(page.getByTestId("baseline-variance")).toHaveText("+2日遅れ");

  // 概要の「ベースライン比の遅れ」にも表示される。
  await page
    .getByRole("navigation", { name: "メインナビゲーション" })
    .getByRole("button", { name: "プロジェクト概要", exact: true })
    .click();
  const slipped = page.getByTestId("slipped-list");
  await expect(slipped).toContainText("SCHED-E2E");
  await expect(slipped).toContainText("+2日");
});
