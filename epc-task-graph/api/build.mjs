// esbuild で src/index.ts を dist/index.js（CommonJS 単一ファイル）にバンドルする。
// ../app/src/domain 配下の 'zod' も api 側の node_modules/zod に解決して二重化を防ぐ
// （app 側の node_modules が無い環境＝SWA の api ビルドでも動く）。
// 外部化: '@azure/functions-core' は Functions ワーカーが実行時に提供する仮想モジュール。
// 追加で外部化したいパッケージは EXTERNALS=mssql,... で指定できる（その場合 dist と一緒に node_modules が必要）。
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const apiDir = fileURLToPath(new URL('.', import.meta.url));

const zodFromApi = {
  name: 'zod-from-api',
  setup(b) {
    b.onResolve({ filter: /^zod(\/.*)?$/ }, async (args) => {
      if (args.pluginData === 'zod-from-api') return undefined;
      const r = await b.resolve(args.path, {
        resolveDir: apiDir,
        kind: args.kind,
        pluginData: 'zod-from-api',
      });
      return r.errors.length ? undefined : { path: r.path };
    });
  },
};

const extra = (process.env.EXTERNALS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

await build({
  entryPoints: [apiDir + 'src/index.ts'],
  outfile: apiDir + 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  external: ['@azure/functions-core', ...extra],
  plugins: [zodFromApi],
});
