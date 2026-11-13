import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const apiDir = fileURLToPath(new URL('.', import.meta.url));

// ../app/src/domain の 'zod' を api 側の node_modules/zod に解決する（app 側の依存が未インストールでも動く）。
const zodFromApi = {
  name: 'zod-from-api',
  enforce: 'pre' as const,
  async resolveId(
    this: { resolve: (s: string, i: string, o: Record<string, unknown>) => Promise<unknown> },
    source: string,
    importer: string | undefined,
    options: Record<string, unknown>,
  ) {
    if (!importer || !/^zod(\/.*)?$/.test(source)) return null;
    const r = await this.resolve(source, apiDir + 'src/index.ts', { ...options, skipSelf: true });
    return r ?? null;
  },
};

export default defineConfig({
  plugins: [zodFromApi],
  test: { include: ['tests/**/*.test.ts'] },
});
