import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { defineConfig } from 'eslint/config';

export default defineConfig(
  { ignores: ['dist', 'node_modules', 'test-results', 'playwright-report', '*.config.{js,ts}'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // §7.4: ストア直接変更禁止の担保。ストア外からの setState 直呼びでアクションを迂回させない。
      'no-restricted-syntax': [
        'warn',
        {
          selector: "MemberExpression[object.name='useApp'][property.name='setState']",
          message: 'ストアの直接 setState は禁止。定義済みアクション経由で状態を更新してください（§7.4）。',
        },
      ],
    },
  },
  {
    // ストア定義自身とテストは setState を正当に使う。
    files: ['src/store/store.ts', 'src/store/apiSync.ts', 'tests/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
