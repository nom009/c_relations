import { openEditor } from "./openEditor";
import { test, expect, type Page } from "@playwright/test";

// 設計書 §12.6 PR-T1 受入基準のスモーク:
// タブ切替 → 4,000生成 → 仮想化(実DOM行≤50) → フィルタ反映 → 行選択がグラフと同期 →
// インライン編集(ストアアクション経由・Undo可) → リロード復元 のうち可能な範囲を実駆動で確認。

function tasksLen(page: Page) {
  return page.evaluate(() => (window as any).__APP.getState().tasks.length);
}
function selTaskId(page: Page) {
  return page.evaluate(() => (window as any).__APP.getState().selection.taskId);
}
function nameOf(page: Page, id: string) {
  return page.evaluate(
    (tid) =>
      (window as any).__APP.getState().tasks.find((t: any) => t.id === tid)
        ?.name,
    id,
  );
}
function activeView(page: Page) {
  return page.evaluate(() => (window as any).__APP.getState().activeView);
}
function depsLen(page: Page) {
  return page.evaluate(
    () => (window as any).__APP.getState().dependencies.length,
  );
}
function wbsCodeOf(page: Page, id: string) {
  return page.evaluate(
    (tid) =>
      (window as any).__APP.getState().tasks.find((t: any) => t.id === tid)
        ?.wbsCode,
    id,
  );
}
function statusOf(page: Page, id: string) {
  return page.evaluate(
    (tid) =>
      (window as any).__APP.getState().tasks.find((t: any) => t.id === tid)
        ?.status,
    id,
  );
}
function selectedCount(page: Page) {
  return page.evaluate(
    () => (window as any).__APP.getState().selectedIds.length,
  );
}

test("テーブル: タブ切替→4000→仮想化→フィルタ→選択同期→インライン編集→Undo", async ({
  page,
}) => {
  await page.goto("/");
  await openEditor(page);
  await page.waitForFunction(() => !!(window as any).__APP);

  // ---- タブ切替（グラフ⇄テーブル・display切替で常駐マウント）----
  await page.getByTestId("viewtab-table").click();
  await expect(page.getByTestId("table-scroll")).toBeVisible();

  // ---- 4,000ノード生成 → テーブルへ反映 ----
  const t0 = Date.now();
  await page.evaluate(() => (window as any).__APP.getState().generateDemo());
  await expect.poll(async () => await tasksLen(page)).toBe(4000);
  // 全WBS展開（4,000タスク行＋WBS行で仮想化を実スケール検証。既定は Lv2 集約）。
  await page.evaluate(() => (window as any).__APP.getState().setExpandLevel(9));
  // 最初のタスク行が現れるまで（初期表示）
  await expect(page.locator(".trow:not(.trow-wbs)").first()).toBeVisible();
  const initialMs = Date.now() - t0;
  console.log("[table] 4000生成→全展開→初期表示 wall-clock =", initialMs, "ms");

  // ---- (a) 仮想化: 実DOM行が視界＋オーバースキャン分だけ（≤50。総行数は4,000超）----
  await expect
    .poll(async () => await page.getByTestId("table-count").innerText())
    .toMatch(/全 4000/);
  const domRows = await page.locator(".trow").count();
  console.log("[table] 実DOM .trow 行数 =", domRows);
  expect(domRows).toBeGreaterThan(0);
  expect(domRows).toBeLessThanOrEqual(50);

  // ---- (b) フィルタ反映（ISOLATE + 工種E）: タスク行数が 4,000 未満へ ----
  await page.evaluate(() => {
    const app = (window as any).__APP;
    app.getState().setDisplayMode("ISOLATE");
    app.getState().setFilter({ disciplines: ["E"] });
  });
  await expect
    .poll(async () => {
      const txt = await page.getByTestId("table-count").innerText();
      const m = txt.match(/タスク\s*(\d+)/);
      return m ? Number(m[1]) : -1;
    })
    .toBeLessThan(4000);
  // フィルタ解除して以降の編集を安定化
  await page.evaluate(() => (window as any).__APP.getState().clearFilter());

  // ---- (d) 行選択 ⇄ ノード選択の同期＋タブ往復で保持 ----
  const firstRow = page.locator(".trow:not(.trow-wbs)").first();
  const rowId = await firstRow.getAttribute("data-id");
  expect(rowId).toBeTruthy();
  await firstRow.click();
  await expect.poll(async () => await selTaskId(page)).toBe(rowId);
  // グラフへ切替 → 選択保持
  await page.getByTestId("viewtab-graph").click();
  expect(await selTaskId(page)).toBe(rowId);
  // テーブルへ戻る → 選択保持
  await page.getByTestId("viewtab-table").click();
  expect(await selTaskId(page)).toBe(rowId);

  // ---- (e) インライン編集（ダブルクリック→入力→Enter）＝ updateTask 経由 ----
  const nameCell = page.locator(`.trow[data-id="${rowId}"] .tcell-name`);
  await nameCell.dblclick();
  const input = page.locator(".trow input.task-name-input");
  await expect(input).toBeVisible();
  await input.fill("テーブル編集A");
  await input.press("Enter");
  await expect
    .poll(async () => await nameOf(page, rowId!))
    .toBe("テーブル編集A");
  // Enter の「次行へ前進」で開いた編集をキャンセルしてフォーカスを外す
  await page.keyboard.press("Escape");
  await page.locator(".table-toolbar").click();

  // ---- Undo（全ビュー共通・Cmd/Ctrl+Z）で編集が1確定=1単位で戻る ----
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+z" : "Control+z",
  );
  await expect
    .poll(async () => await nameOf(page, rowId!))
    .not.toBe("テーブル編集A");
});

// 設計書 §12.6 PR-T2: ビュー切替ショートカット(g/t) / Tab後続作成 / WBS行の日付集計。
test("テーブル: g/t切替・Tab後続作成・WBS日付集計", async ({ page }) => {
  await page.goto("/");
  await openEditor(page);
  await page.waitForFunction(() => !!(window as any).__APP);

  // ---- ⑦ ビュー切替ショートカット: t=テーブル / g=グラフ ----
  await page.locator("body").click();
  await page.keyboard.press("t");
  await expect.poll(async () => await activeView(page)).toBe("table");
  await expect(page.getByTestId("table-scroll")).toBeVisible();
  await page.keyboard.press("g");
  await expect.poll(async () => await activeView(page)).toBe("graph");
  await page.keyboard.press("t");
  await expect.poll(async () => await activeView(page)).toBe("table");

  // ---- デモ生成（CPMが効く依存つき）----
  await page.evaluate(() => (window as any).__APP.getState().generateDemo());
  await expect.poll(async () => await tasksLen(page)).toBe(4000);
  await page.evaluate(() => (window as any).__APP.getState().setExpandLevel(9));
  await expect(page.locator(".trow:not(.trow-wbs)").first()).toBeVisible();

  // ---- ③ WBS行の日付集計: WBS行の ES 列が yyyy-mm-dd を表示する ----
  const wbsEs = page.locator(".trow-wbs .tcell-es .wbs-agg").first();
  await expect(wbsEs).toHaveText(/\d{4}-\d{2}-\d{2}/);

  // ---- ⑥ Tab後続作成: タスク選択→Tab で tasks/deps が +1、新行の名前編集が開く ----
  const firstTask = page.locator(".trow:not(.trow-wbs)").first();
  const srcId = await firstTask.getAttribute("data-id");
  await firstTask.click();
  await expect.poll(async () => await selTaskId(page)).toBe(srcId);
  const beforeT = await tasksLen(page);
  const beforeD = await depsLen(page);
  await page.keyboard.press("Tab");
  await expect.poll(async () => await tasksLen(page)).toBe(beforeT + 1);
  await expect.poll(async () => await depsLen(page)).toBe(beforeD + 1);
  // 新タスクが選択され、名前セルの編集入力が開く。
  await expect(page.locator(".trow input.task-name-input")).toBeVisible();
  await page.keyboard.press("Escape");
});

// 設計書 §12.6 PR-T2 ⑤: wbsCode セル編集 → 確定でツリー再配置（新WBS配下へ移動）。
test("テーブル: wbsCodeセル編集で行が新WBSへ再配置される", async ({ page }) => {
  await page.goto("/");
  await openEditor(page);
  await page.waitForFunction(() => !!(window as any).__APP);
  await page.getByTestId("viewtab-table").click();
  await expect(page.getByTestId("table-scroll")).toBeVisible();

  // 既知のwbsCodeでタスクを1件用意して選択（addTask が選択も行う）。
  const id = await page.evaluate(
    () =>
      (window as any).__APP
        .getState()
        .addTask({ wbsCode: "7.1", name: "WB移動" }).id,
  );
  await page.evaluate(() => (window as any).__APP.getState().setExpandLevel(9));
  const wcCell = page.locator(`.trow[data-id="${id}"] .tcell-wbsCode`);
  await expect(wcCell).toBeVisible();
  expect(await wbsCodeOf(page, id)).toBe("7.1");

  // wbsCode を 8.2 へ編集（ダブルクリック→入力→Enter）。
  await wcCell.dblclick();
  const input = page.locator(".trow input.task-name-input");
  await expect(input).toBeVisible();
  await input.fill("8.2");
  await input.press("Enter");

  // ストア上で wbsCode が更新され、DOM上で新WBSグループ行(wbs::8 / wbs::8.2)が現れる。
  await expect.poll(async () => await wbsCodeOf(page, id)).toBe("8.2");
  await expect(page.locator('[data-id="wbs::8.2"]')).toBeVisible();
  await page.keyboard.press("Escape");
});

// 設計書 §12.6 PR-T2 ②: 複数行選択（Cmd/Ctrl・Shift）と一括操作（削除/ステータス）。
test("テーブル: 複数選択と一括操作（一括ステータス・一括削除→Undo）", async ({
  page,
}) => {
  await page.goto("/");
  await openEditor(page);
  await page.waitForFunction(() => !!(window as any).__APP);
  await page.getByTestId("viewtab-table").click();
  await expect(page.getByTestId("table-scroll")).toBeVisible();

  // wbsCode '99' で3タスクを隔離作成（表内で連続・他行と混ざらない）。
  const ids: string[] = await page.evaluate(() => {
    const app = (window as any).__APP.getState();
    const a = app.addTask({ wbsCode: "99", name: "MA" });
    const b = app.addTask({ wbsCode: "99", name: "MB" });
    const c = app.addTask({ wbsCode: "99", name: "MC" });
    app.setSelection({ taskId: null }); // 選択リセット
    return [a.id, b.id, c.id];
  });
  await page.evaluate(() => (window as any).__APP.getState().setExpandLevel(9));
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  const rowA = page.locator(`.trow[data-id="${ids[0]}"]`);
  const rowB = page.locator(`.trow[data-id="${ids[1]}"]`);
  const rowC = page.locator(`.trow[data-id="${ids[2]}"]`);
  // 表は仮想化されており WBS '99' は末尾のため、最下部までスクロールして描画させる。
  await page
    .getByTestId("table-scroll")
    .evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(rowC).toBeVisible();

  // 単一選択では一括バーは出ない。
  await rowA.click();
  await expect(page.getByTestId("bulkbar")).toHaveCount(0);

  // ---- Cmd/Ctrl+クリックのトグルで MA,MB を選択（2件）----
  await rowB.click({ modifiers: [mod] });
  await expect.poll(async () => await selectedCount(page)).toBe(2);
  await expect(page.getByTestId("bulkbar")).toBeVisible();

  // ---- 一括ステータス変更（DONE）: MA,MB が DONE、MC は非DONE ----
  await page.getByTestId("bulk-status").selectOption("DONE");
  await expect.poll(async () => await statusOf(page, ids[0])).toBe("DONE");
  await expect.poll(async () => await statusOf(page, ids[1])).toBe("DONE");
  expect(await statusOf(page, ids[2])).not.toBe("DONE");

  // ---- Shift+クリックで範囲選択（MA..MC = 3件）----
  await rowA.click();
  await rowC.click({ modifiers: ["Shift"] });
  await expect.poll(async () => await selectedCount(page)).toBe(3);

  // ---- 一括削除 → 3件減 → Undo で復元 ----
  const before = await tasksLen(page);
  await page.getByTestId("bulk-delete").click();
  await expect.poll(async () => await tasksLen(page)).toBe(before - 3);
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+z" : "Control+z",
  );
  await expect.poll(async () => await tasksLen(page)).toBe(before);
});
