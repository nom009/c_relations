import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// サーバー版（VITE_STORAGE=api）の開発/プレビューでは /api を API サーバー（既定: Functions ローカル 7071）へ転送する。
// ローカル版のビルド成果物には影響しない（dev/preview サーバーの設定のみ）。
const apiProxy = {
  '/api': { target: process.env.API_PROXY_TARGET || 'http://localhost:7071', changeOrigin: true },
};

// Phase 1: Vite + React 18 + TypeScript（設計書 §4.2）。
// domain 層は React/DOM 非依存の純関数のみで、Vitest（node環境）で単体テストする。
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
