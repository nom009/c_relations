import { test, expect } from "@playwright/test";
test("初回からサンプル工程の概要を確認できる", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "プロジェクト概要", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "工程の見通し" }),
  ).toBeVisible();
});
test("担当を設定して、自分の工程へ移動できる", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "ワークスペース設定", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "プロジェクト設定" });
  await dialog.getByLabel("あなたの担当部署").fill("設計1課");
  await dialog.getByRole("button", { name: "変更を保存" }).click();
  await page.getByRole("button", { name: "自分のタスク", exact: true }).click();
  await expect(page.getByTestId("filter-banner")).toContainText("設計1課");
  await expect(page.getByTestId("table-scroll")).toBeVisible();
});
test("設定ダイアログの祝日プリセットはキャンセルで破棄、保存で反映される", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__APP);
  const holidayCount = () =>
    page.evaluate(() => {
      const s = (window as any).__APP.getState();
      const cal =
        s.calendars.find((c: any) => c.id === s.project.calendarId) ??
        s.calendars[0];
      return cal.holidays.length as number;
    });
  const before = await holidayCount();
  const openPresets = async () => {
    await page
      .getByRole("button", { name: "ワークスペース設定", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "プロジェクト設定" });
    await dialog.getByText("祝日・休業日を設定").click();
    await dialog.getByRole("button", { name: "日本の祝日を追加" }).click();
    await expect(
      dialog.getByTestId("holiday-presets").getByRole("status"),
    ).toContainText("変更を保存");
    return dialog;
  };

  let dialog = await openPresets();
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await holidayCount()).toBe(before);

  dialog = await openPresets();
  await dialog.getByRole("button", { name: "変更を保存" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(holidayCount).toBeGreaterThan(before);
});
test("追加したタスクの工期変更はプレビューを確認してから適用する", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "タスクを追加", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "タスクを追加" });
  await dialog.getByLabel("タスク名").fill("E2E 工期確認");
  await dialog
    .getByRole("button", { name: "タスクを追加", exact: true })
    .click();
  await expect(page.locator(".redesigned-inspector h2")).toHaveText(
    "E2E 工期確認",
  );
  await page
    .getByRole("spinbutton", { name: "所要日数", exact: true })
    .fill("15");
  await expect(
    page.getByText("変更を適用するまで、工程は更新されません。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "変更を適用", exact: true }).click();
  await expect(
    page.getByText("変更を適用するまで、工程は更新されません。"),
  ).toHaveCount(0);
});
