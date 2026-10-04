import { createRequire } from 'node:module';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('tsx/package.json'))('esbuild');
const directory = await mkdtemp(
  join(tmpdir(), 'allrice-static-browser-build-'),
);
try {
  await esbuild.build({
    absWorkingDir: resolve('.'),
    entryPoints: ['apps/worker/src/browser-control/static-runner.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: ['playwright-core'],
    alias: {
      '@allrice/browser-control': resolve(
        'packages/browser-control/src/index.ts',
      ),
      '@allrice/contracts': resolve('packages/contracts/src/index.ts'),
    },
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    outfile: join(directory, 'runner.mjs'),
  });
  await copyFile(
    'infra/docker/Dockerfile.static-browser',
    join(directory, 'Dockerfile'),
  );
  execFileSync(
    '/usr/local/bin/docker',
    [
      '--host',
      'unix:///Users/a123/.colima/allrice-cloud-b4/docker.sock',
      'build',
      '--target',
      'runtime',
      '-t',
      'allrice-static-browser:release-v1',
      directory,
    ],
    { stdio: 'inherit', timeout: 300_000 },
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
