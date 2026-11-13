import { openEditor } from "./openEditor";
import { test, expect } from "@playwright/test";

// Web Locks による単一ライタ制御: 2枚目のタブは待機画面になり、1枚目を閉じると自動で使えるようになる。

const TITLE = "このアプリは別のタブで開かれています";

test("2つ目のタブは待機オーバーレイになり、先のタブを閉じると編集・保存できる", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);

  const page1 = page;
  await page1.goto("/");
  await openEditor(page1);
  await page1.waitForFunction(() => !!(window as any).__APP, undefined, {
    timeout: 15_000,
  });

  const page2 = await context.newPage();
  await page2.goto("/");
  await expect(page2.getByText(TITLE)).toBeVisible({ timeout: 15_000 });
  // 待機中はストアを起動せず、DB へ書き込まない
  expect(await page2.evaluate(() => !!(window as any).__APP)).toBe(false);

  await page1.close();

  await expect(page2.getByText(TITLE)).toBeHidden({ timeout: 20_000 });
  await page2.waitForFunction(() => !!(window as any).__APP, undefined, {
    timeout: 20_000,
  });

  // 引き継いだタブで編集が保存される（リロード後も残る）
  await openEditor(page2);
  await page2.evaluate(() => {
    (window as any).__APP
      .getState()
      .addTask({ name: "別タブ後の編集", durationDays: 3 }, { edit: false });
  });
  await expect(page2.getByTestId("savebadge")).toHaveText(/保存済み/, {
    timeout: 15_000,
  });

  await page2.reload();
  await page2.waitForFunction(() => !!(window as any).__APP, undefined, {
    timeout: 20_000,
  });
  await expect
    .poll(
      async () =>
        await page2.evaluate(() =>
          (window as any).__APP
            .getState()
            .tasks.some((t: any) => t.name === "別タブ後の編集"),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
});
