import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Phase 1: Vite + React 18 + TypeScript（設計書 §4.2）。
// domain 層は React/DOM 非依存の純関数のみで、Vitest（node環境）で単体テストする。
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
