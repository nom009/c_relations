import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";

// アクセシビリティ自動検査（axe-core）。主要画面を WCAG 2.1 A/AA で走査し、
// serious/critical の違反が無いことを保証する。軽微なもの（moderate/minor）は記録のみ。
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function audit(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  for (const v of result.violations) {
    const targets = v.nodes
      .slice(0, 5)
      .map((n) => n.target.join(" "))
      .join(" | ");
    console.log(
      `[a11y:${label}] ${v.impact} ${v.id} x${v.nodes.length} — ${v.help} — ${targets}`,
    );
  }
  const blocking = result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) =>
        `${v.id}: ${v.nodes
          .slice(0, 5)
          .map((n) => n.target.join(" "))
          .join(", ")}`,
    );
  expect(blocking, `${label} の重大なアクセシビリティ違反`).toEqual([]);
}

async function openView(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "メインナビゲーション" })
    .getByRole("button", { name, exact: true })
    .click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "プロジェクト概要", exact: true }),
  ).toBeVisible();
});

test("a11y: プロジェクト概要", async ({ page }) => {
  await audit(page, "概要");
});

test("a11y: 依存関係グラフ", async ({ page }) => {
  await openView(page, "依存関係");
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await audit(page, "グラフ");
});

test("a11y: ガントチャート", async ({ page }) => {
  await openView(page, "ガントチャート");
  await expect(page.getByTestId("gantt-scroll")).toBeVisible();
  await expect(page.locator(".gantt-bar").first()).toBeVisible();
  await audit(page, "ガント");
});

test("a11y: タスク一覧", async ({ page }) => {
  await openView(page, "タスク一覧");
  await expect(page.getByTestId("table-scroll")).toBeVisible();
  await expect(page.locator(".trow").first()).toBeVisible();
  await audit(page, "テーブル");
});

test("a11y: プロジェクト設定ダイアログ", async ({ page }) => {
  await page
    .getByRole("button", { name: "ワークスペース設定", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "プロジェクト設定" }),
  ).toBeVisible();
  await audit(page, "設定");
});
