import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../..');
const source = process.env.WORKDAY_FIXTURE_SOURCE;
const cacheDir = process.env.WORKDAY_FIXTURE_CACHE;
if (!source || !cacheDir)
  throw new Error('Explicit fixture source/cache required');
const paths = JSON.parse(
  readFileSync(resolve(source, 'tsconfig.base.json'), 'utf8'),
).compilerOptions.paths;
const aliases = Object.entries(paths)
  .filter(([key]) => !key.includes('*'))
  .map(([key, [target]]) => ({
    find: new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    replacement: resolve(source, target),
  }));
const dependencies = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8'),
);

export default defineConfig({
  root,
  cacheDir,
  resolve: {
    alias: aliases,
    dedupe: [
      'vitest',
      'ws',
      ...Object.keys(dependencies.dependencies ?? {}),
      ...Object.keys(dependencies.devDependencies ?? {}),
    ],
  },
  server: { fs: { allow: [root, source] } },
  test: {
    include: [resolve(directory, 'native-entry.fixture.test.ts')],
    setupFiles: [],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
