import { defineConfig, devices } from "@playwright/test";

// サーバー版（VITE_STORAGE=api）の共同編集 E2E。ローカル版の playwright.config.ts とは独立。
// API は epc-task-graph/api の開発サーバー（ALLOW_MEMORY_STORE=1 でメモリ保存）。
// 認証は x-ms-client-principal ヘッダー（開発サーバーが信頼する）をテスト側で付与する。
export default defineConfig({
  testDir: "./tests/e2e-api",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4174",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm --prefix ../api run dev",
      url: "http://localhost:7071/api/health",
      env: { PORT: "7071", ALLOW_MEMORY_STORE: "1" },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command:
        "VITE_STORAGE=api VITE_E2E=true npm run build && npm run preview -- --port 4174",
      url: "http://localhost:4174",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
