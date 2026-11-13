import { openEditor } from "./openEditor";
import { test, expect, type Page } from "@playwright/test";

// クリックで依存を接続/切断する「つなぐモード」＋接続時の通電エフェクト。
function depsLen(page: Page) {
  return page.evaluate(
    () => (window as any).__APP.getState().dependencies.length,
  );
}

test("つなぐモード: クリックで接続→通電エフェクト→もう一度で切断", async ({
  page,
}) => {
  await page.goto("/");
  await openEditor(page);
  await page.waitForFunction(() => !!(window as any).__APP);

  // 未接続の2タスク A,B を作る。
  const ids: string[] = await page.evaluate(() => {
    const app = (window as any).__APP.getState();
    const a = app.addTask(
      { name: "CA", position: { x: 0, y: 0 } },
      { edit: false },
    );
    const b = app.addTask(
      { name: "CB", position: { x: 260, y: 0 } },
      { edit: false },
    );
    app.setSelection({ taskId: null });
    return [a.id, b.id];
  });
  await page.getByTestId("viewtab-graph").click();
  await page.evaluate(() =>
    (window as any).__APP.getState().runners.fitView?.(),
  );
  const before = await depsLen(page);

  // つなぐモードON。
  await page.getByTestId("connect-toggle").click();
  await expect(page.getByTestId("connect-hint")).toBeVisible();

  // 始点=A → 終点=B をクリックで接続。
  const nodeA = page.locator(`.react-flow__node[data-id="${ids[0]}"]`);
  const nodeB = page.locator(`.react-flow__node[data-id="${ids[1]}"]`);
  await nodeA.click();
  await nodeB.click();
  await expect.poll(async () => await depsLen(page)).toBe(before + 1);
  // A→B の依存が実在。
  const connected = await page.evaluate(
    (p) =>
      (window as any).__APP
        .getState()
        .dependencies.some(
          (d: any) => d.predecessorId === p[0] && d.successorId === p[1],
        ),
    ids,
  );
  expect(connected).toBe(true);

  // 通電エフェクト: energized エッジが一時的に現れる。
  await expect(page.locator(".react-flow__edge.energized")).toHaveCount(1);
  // 起点で回路が走る: burst が A→B にセットされる（一瞬）。
  const burst = await page.evaluate(
    (p) => {
      const b = (window as any).__APP.getState().burst;
      return b?.source === p[0] && b?.target === p[1];
    },
    ids,
  );
  expect(burst).toBe(true);

  // 同じ A→B をもう一度クリックで切断（始点は保持されているので B を押すだけ）。
  await nodeB.click();
  await expect.poll(async () => await depsLen(page)).toBe(before);

  // Esc でモード終了。
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("connect-hint")).toHaveCount(0);
});
