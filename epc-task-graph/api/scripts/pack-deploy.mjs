// SWA マネージド Functions へ載せる api パッケージを作る（CI の deploy-azure と api ジョブで使用）。
// mssql(tedious) はバンドルせず実行時依存として同梱し、バンドルの require が想定外のものを含まないか検査する。
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const apiDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.resolve(apiDir, process.argv[2] ?? '../api-deploy');
const runtimeDeps = ['mssql'];

execFileSync(process.execPath, ['build.mjs'], {
  cwd: apiDir,
  stdio: 'inherit',
  env: { ...process.env, EXTERNALS: runtimeDeps.join(',') },
});

const bundle = readFileSync(path.join(apiDir, 'dist/index.js'), 'utf8');
const allowed = new Set([...builtinModules, '@azure/functions-core', ...runtimeDeps]);
const unexpected = [...bundle.matchAll(/\brequire\("([^"]+)"\)/g)]
  .map((m) => m[1].replace(/^node:/, ''))
  .filter((id) => !allowed.has(id) && !allowed.has(id.split('/')[0]));
if (unexpected.length) {
  console.error('Unexpected runtime requires in bundle:', [...new Set(unexpected)]);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(path.join(apiDir, 'dist'), path.join(outDir, 'dist'), { recursive: true });
cpSync(path.join(apiDir, 'host.json'), path.join(outDir, 'host.json'));
const pkg = JSON.parse(readFileSync(path.join(apiDir, 'package.json'), 'utf8'));
const dependencies = Object.fromEntries(
  runtimeDeps.map((d) => [d, JSON.parse(readFileSync(path.join(apiDir, 'node_modules', d, 'package.json'), 'utf8')).version]),
);
writeFileSync(
  path.join(outDir, 'package.json'),
  JSON.stringify({ name: pkg.name, version: pkg.version, private: true, main: pkg.main, dependencies }, null, 2) + '\n',
);
console.log(`deploy package written to ${outDir} (runtime deps: ${JSON.stringify(dependencies)})`);