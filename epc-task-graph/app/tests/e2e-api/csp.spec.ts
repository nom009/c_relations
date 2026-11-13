import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { openEditor } from "../e2e/openEditor";

// SWA に載せる Content-Security-Policy（swa/staticwebapp.config.json）の下でも
// アプリが違反なく動くことを、本番ビルドに同じヘッダーを付けて確認する。
const config = JSON.parse(
  readFileSync(new URL("../../../swa/staticwebapp.config.json", import.meta.url), "utf8"),
) as { globalHeaders: Record<string, string> };
const CSP = config.globalHeaders["Content-Security-Policy"];

const principal = Buffer.from(
  JSON.stringify({
    identityProvider: "aad",
    userId: "u-csp",
    userDetails: "csp-user@example.com",
    userRoles: ["anonymous", "authenticated"],
    claims: [{ typ: "name", val: "csp" }],
  }),
).toString("base64");

test("CSP の下でも起動・表示切替・レイアウト計算が違反なく動く", async ({ browser }) => {
  expect(CSP).toBeTruthy();
  const ctx = await browser.newContext({
    baseURL: "http://localhost:4174",
    extraHTTPHeaders: { "x-ms-client-principal": principal },
  });
  await ctx.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const res = await route.fetch();
    await route.fulfill({
      response: res,
      headers: { ...res.headers(), "content-security-policy": CSP },
    });
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    (window as any).__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as any).__cspViolations.push(
        `${e.violatedDirective} ${e.blockedURI} @${e.sourceFile}:${e.lineNumber}:${e.columnNumber} ${e.sample}`,
      ),
    );
  });
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) consoleErrors.push(m.text());
  });

  await page.goto("/");
  await expect(page.getByTestId("savebadge")).toHaveText(/保存済み/);
  await openEditor(page);
  await page.waitForFunction(() => !!(window as any).__APP);
  await page.evaluate(() => {
    const app = (window as any).__APP.getState();
    const t = app.addTask({ wbsCode: "95", name: "CSP", durationDays: 3 });
    app.setSelection({ taskId: t.id });
  });
  await page.getByRole("tab", { name: "日程", exact: true }).click();
  await page.getByRole("tab", { name: /つながり/ }).click();
  await page.waitForTimeout(500);

  expect(await page.evaluate(() => (window as any).__cspViolations)).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await ctx.close();
});
