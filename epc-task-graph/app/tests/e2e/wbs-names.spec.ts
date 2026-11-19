import { openEditor } from "./openEditor";
import { test, expect, type Page } from "@playwright/test";

// WBS 名称（ProjectMeta.wbsNames）: ダイアログで名称を付け、WBSツリーに表示され、リロード後も残る。
function wbsName(page: Page, code: string) {
  return page.evaluate(
    (c) => (window as any).__APP.getState().project.wbsNames?.[c] ?? null,
    code,
  );
}

test("WBS名称: ダイアログで付けた名称がツリーに表示され、リロード後も残る", async ({
  page,
}) => {
  await page.goto("/");
  await openEditor(page);
  await page.waitForFunction(() => !!(window as any).__APP);

  await page.evaluate(() => {
    const app = (window as any).__APP.getState();
    app.addTask({ wbsCode: "93.1", name: "WN" }, { edit: false });
  });

  const tree = page.getByTestId("wbs-tree");
  await expect(tree.locator('[data-prefix="93"]')).toBeVisible();

  // ツリー見出しの「名称を編集」→ 祖先コード 93 にも入力欄がある。
  await page.getByRole("button", { name: "名称を編集", exact: true }).click();
  await expect(page.getByTestId("wbs-names-dialog")).toBeVisible();
  await expect(page.getByTestId("wbs-name-input-93.1")).toBeVisible();
  await page.getByTestId("wbs-name-input-93").fill("  テスト工区  ");
  await page.getByTestId("wbs-names-save").click();
  await expect(page.getByTestId("wbs-names-dialog")).toHaveCount(0);

  // 前後空白は除いて保存され、ツリーのラベルは「93 テスト工区 (1)」。
  await expect.poll(() => wbsName(page, "93")).toBe("テスト工区");
  await expect(tree.locator('[data-prefix="93"]')).toContainText("テスト工区");
  await expect(tree.locator('[data-prefix="93"]')).toContainText("(1)");

  // 1 回の「戻す」で取り消せる → やり直しで戻る。
  await page.evaluate(() => (window as any).__APP.getState().undo());
  await expect.poll(() => wbsName(page, "93")).toBeNull();
  await page.evaluate(() => (window as any).__APP.getState().redo());
  await expect.poll(() => wbsName(page, "93")).toBe("テスト工区");

  // 自動保存（デバウンス500ms）の完了を待ってリロード。
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__APP.getState().saveStatus),
    )
    .toBe("saved");
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__APP);
  await expect.poll(() => wbsName(page, "93")).toBe("テスト工区");
  await openEditor(page);
  await expect(
    page.getByTestId("wbs-tree").locator('[data-prefix="93"]'),
  ).toContainText("テスト工区");
});
