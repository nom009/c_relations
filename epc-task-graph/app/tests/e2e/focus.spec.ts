import { openEditor } from "./openEditor";
import { test, expect, type Page } from "@playwright/test";

// 設計書 §2.9 / ユーザー要望（2026-07-22）: 自分に関係するタスクを世代つきでハイライト。
// 近傍フォーカス(H)＝関係ハイライト（全体を残し近傍を強調）を既定に、世代数UIで上流/下流を調整。

function pickConnected(page: Page) {
  return page.evaluate(() => {
    const s = (window as any).__APP.getState();
    const hasPred = new Set(s.dependencies.map((d: any) => d.successorId));
    const hasSucc = new Set(s.dependencies.map((d: any) => d.predecessorId));
    const t = s.tasks.find((x: any) => hasPred.has(x.id) && hasSucc.has(x.id));
    s.setSelection({ taskId: t.id });
    return t.id;
  });
}

test("関係ハイライト: 近傍にリング＋世代バッジ、非近傍は文脈として残る→抽出で絞る", async ({
  page,
}) => {
  await page.goto("/");
  await openEditor(page);
  await page.waitForFunction(() => !!(window as any).__APP);
  await page.evaluate(() => (window as any).__APP.getState().generateDemo());
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__APP.getState().tasks.length),
    )
    .toBe(4000);

  const id = await pickConnected(page);
  // H 相当（toggleFocus）＝関係ハイライト既定
  await page.evaluate(
    (tid) => (window as any).__APP.getState().toggleFocus(tid),
    id,
  );

  // 統計は「詳細設定」に折り畳まれているため開く。
  await page.getByTestId("details-toggle").click();
  // 集約数は統計パネルから読む（React Flow のビューポート・カリングでDOMは変動するため）。
  const aggCount = async () => {
    const txt = await page.getByTestId("visible-count").innerText();
    const m = txt.match(/集約\s*(\d+)/);
    return m ? Number(m[1]) : -1;
  };

  // フォーカスバー（ハイライトが on）
  await expect(page.locator(".focusbar")).toBeVisible();
  // フォーカス切替後の自動 fitView（4000件ではズーム<0.4＝LOD描画）が終わってから起点へ寄せる。
  await page.waitForTimeout(800);
  await expect
    .poll(async () => {
      await page.evaluate(() =>
        (window as any).__APP.getState().runners.centerSelected?.(),
      );
      return page.locator(".task-node.origin").count();
    })
    .toBeGreaterThan(0);
  // 近傍タスクにリング（.related）＋世代バッジ、起点バッジ
  await expect
    .poll(async () => await page.locator(".task-node.related").count())
    .toBeGreaterThan(1);
  await expect(page.locator(".gen-badge.origin")).toBeVisible();

  // 非近傍は隠れず集約ノードとして文脈に残る（highlight は集約>0）。
  await expect.poll(aggCount).toBeGreaterThan(0);
  const aggBefore = await aggCount();

  // 抽出モードへ → 近傍だけに絞られ、文脈の集約が減る
  await page.evaluate(() =>
    (window as any).__APP.getState().setFocusMode("isolate"),
  );
  await expect.poll(aggCount).toBeLessThan(aggBefore);
  // 起点は残る
  await expect(page.locator(".task-node.origin")).toBeVisible();
});
