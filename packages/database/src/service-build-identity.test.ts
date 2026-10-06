import {
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  readFile,
  symlink,
  realpath,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';
import {
  prepareServiceBuildManifest,
  verifyServiceBuildIdentity,
} from './service-build-identity.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'allrice-build-identity-'));
  roots.push(root);
  const files: Record<string, string> = {
    'apps/web/server.mjs': 'export const web = true;',
    'apps/web/server/gateway.mjs': 'export const gateway = true;',
    'apps/web/.next/server/page.js': 'export default "measured-page";',
    'apps/web/.next/static/chunk.js': 'console.log("measured-chunk")',
    'apps/web/.next/BUILD_ID': 'known-build',
    'apps/worker/dist/index.js': 'console.log("measured-worker")',
    'apps/web/package.json': JSON.stringify({
      name: '@allrice/web',
      dependencies: { '@allrice/database': 'workspace:*' },
    }),
    'apps/worker/package.json': JSON.stringify({
      name: '@allrice/worker',
      dependencies: { '@allrice/database': 'workspace:*' },
    }),
    'packages/database/package.json': JSON.stringify({
      name: '@allrice/database',
      exports: './dist/index.js',
      dependencies: { '@allrice/storage': 'workspace:*' },
    }),
    'packages/database/dist/index.js': 'export const transitive = true;',
    'packages/storage/package.json': JSON.stringify({
      name: '@allrice/storage',
      exports: {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      },
    }),
    'packages/storage/dist/index.js': 'export const storage = true;',
    'package.json': '{"name":"allrice"}',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'pnpm-workspace.yaml': 'packages: [apps/*, packages/*]\n',
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  for (const [importer, dependency] of [
    ['apps/web', 'database'],
    ['apps/worker', 'database'],
    ['packages/database', 'storage'],
  ]) {
    const link = join(root, importer!, 'node_modules/@allrice', dependency!);
    await mkdir(dirname(link), { recursive: true });
    await symlink(join(root, 'packages', dependency!), link);
  }
  const manifest = await prepareServiceBuildManifest({
    root,
    sourceSha: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
  });
  await mkdir(join(root, '.local'));
  await writeFile(
    join(root, '.local/dev-build-identity.json'),
    JSON.stringify(manifest),
  );
  return {
    root,
    manifest,
    verify: (service: 'web' | 'worker', claimedSha = 'a'.repeat(40)) =>
      verifyServiceBuildIdentity({
        service,
        claimedSha,
        mode: 'production',
        entrypoint: join(
          root,
          service === 'web'
            ? 'apps/web/server.mjs'
            : 'apps/worker/dist/index.js',
        ),
      }),
  };
}
it('measures actual service files and transitive compiled packages; roles share the sealed manifest but retain distinct artifacts and boots', async () => {
  const f = await fixture(),
    web = await f.verify('web'),
    worker = await f.verify('worker');
  expect(web?.manifestDigest).toBe(f.manifest.manifestDigest);
  expect(worker?.manifestDigest).toBe(web?.manifestDigest);
  expect(worker?.runtimeGraphDigest).toBe(web?.runtimeGraphDigest);
  expect(worker?.artifactDigest).not.toBe(web?.artifactDigest);
  expect(worker?.bootId).not.toBe(web?.bootId);
  expect(web?.pid).toBe(process.pid);
  expect(worker?.protocols.releaseAdmission).toBe('disabled');
});
it('cannot obtain verified identity from a correct release env SHA with an absent or swapped manifest', async () => {
  const f = await fixture();
  await expect(f.verify('web', 'c'.repeat(40))).rejects.toThrow(
    'DEV_BUILD_IDENTITY_INVALID',
  );
  await rm(join(f.root, '.local/dev-build-identity.json'));
  expect(await f.verify('web')).toBeNull();
});
it('rejects changed Web output, Worker entrypoint and transitive runtime graph while declared SHA stays correct', async () => {
  for (const [path, service] of [
    ['apps/web/.next/server/page.js', 'web'],
    ['apps/worker/dist/index.js', 'worker'],
    ['packages/database/dist/index.js', 'web'],
    ['packages/database/dist/index.js', 'worker'],
  ] as const) {
    const f = await fixture();
    await writeFile(join(f.root, path), 'changed bytes');
    await expect(f.verify(service)).rejects.toThrow(
      'DEV_BUILD_IDENTITY_INVALID',
    );
  }
});
it('rejects traversal, manifest tampering and linked artifacts instead of reporting a different service as the target', async () => {
  const f = await fixture();
  expect(
    await verifyServiceBuildIdentity({
      entrypoint: join(f.root, 'apps/web/server.mjs'),
      service: 'worker',
      mode: 'production',
    }),
  ).toBeNull();
  await writeFile(
    join(f.root, '.local/dev-build-identity.json'),
    JSON.stringify({ ...f.manifest, sourceTree: 'c'.repeat(40) }),
  );
  await expect(f.verify('web')).rejects.toThrow('DEV_BUILD_IDENTITY_INVALID');
  await writeFile(
    join(f.root, '.local/dev-build-identity.json'),
    JSON.stringify(f.manifest),
  );
  const target = join(f.root, 'apps/web/.next/server/page.js');
  const original = await readFile(target);
  await rm(target);
  const outside = join(f.root, 'same-bytes.js');
  await writeFile(outside, original);
  await symlink(outside, target);
  await expect(f.verify('web')).rejects.toThrow('DEV_BUILD_IDENTITY_INVALID');
});
it('does not attest a development server with retained correct production artifacts and SHA', async () => {
  const f = await fixture();
  expect(
    await verifyServiceBuildIdentity({
      service: 'web',
      mode: 'development',
      claimedSha: 'a'.repeat(40),
      entrypoint: join(f.root, 'apps/web/server.mjs'),
    }),
  ).toBeNull();
});
it('rejects direct and transitive workspace links redirected to an identical package in another release', async () => {
  for (const [importer, dependency] of [
    ['apps/worker', 'database'],
    ['packages/database', 'storage'],
  ] as const) {
    const f = await fixture(),
      other = await fixture();
    const link = join(f.root, importer, 'node_modules/@allrice', dependency);
    await rm(link);
    await symlink(join(other.root, 'packages', dependency), link);
    await expect(f.verify('worker')).rejects.toThrow(
      'DEV_BUILD_IDENTITY_INVALID',
    );
    await expect(
      prepareServiceBuildManifest({
        root: f.root,
        sourceSha: 'a'.repeat(40),
        sourceTree: 'b'.repeat(40),
      }),
    ).rejects.toThrow('DEV_BUILD_RUNTIME_GRAPH_INVALID');
    await rm(link);
    await symlink(join(f.root, 'packages', dependency), link);
    expect((await f.verify('worker'))?.manifestDigest).toBe(
      f.manifest.manifestDigest,
    );
  }
});
it('rejects new nearer runtime resolver layers even when all sealed bytes and root package links remain unchanged', async () => {
  for (const importer of [
    'apps/worker/dist',
    'packages/database/dist',
    'apps/web/.next',
  ]) {
    const f = await fixture(),
      other = await fixture();
    const dependency =
      importer === 'packages/database/dist' ? 'storage' : 'database';
    const link = join(f.root, importer, 'node_modules/@allrice', dependency);
    await mkdir(dirname(link), { recursive: true });
    await symlink(join(other.root, 'packages', dependency), link);
    const resolver = createRequire(join(f.root, importer, 'entry.js'));
    expect(resolver.resolve('@allrice/' + dependency)).toBe(
      await realpath(join(other.root, 'packages', dependency, 'dist/index.js')),
    );
    await expect(f.verify('worker')).rejects.toThrow(
      'DEV_BUILD_IDENTITY_INVALID',
    );
    await expect(f.verify('web')).rejects.toThrow('DEV_BUILD_IDENTITY_INVALID');
  }
});
