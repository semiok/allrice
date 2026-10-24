import { createRequire } from 'node:module';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
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
  // Same socket the Worker uses (ALLRICE_CLOUD_DOCKER_SOCKET); images are
  // native to that VM, so build there and pin the resulting ID per arch.
  const socket =
    process.env.ALLRICE_CLOUD_DOCKER_SOCKET ??
    join(
      homedir(),
      `.colima/${process.env.ALLRICE_CLOUD_PROFILE ?? 'allrice-cloud-b4'}/docker.sock`,
    );
  execFileSync(
    process.env.ALLRICE_DOCKER_CLI ?? '/usr/local/bin/docker',
    [
      '--host',
      `unix://${socket}`,
      'build',
      ...(process.env.ALLRICE_CHROMIUM_VERSION
        ? [
            '--build-arg',
            `CHROMIUM_VERSION=${process.env.ALLRICE_CHROMIUM_VERSION}`,
          ]
        : []),
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
