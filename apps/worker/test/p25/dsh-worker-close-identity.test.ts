import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceBuildIdentity } from '@allrice/database';
import { observeDshWorkerCloseIdentity } from '../../src/harness/dsh-worker-close-identity.js';

const checksum = (value: string) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
const nativeArtifactId = checksum(
  'synthetic native identity; never installed or spawned',
);
const locations: string[] = [];
let argv: string[];
beforeEach(() => {
  argv = process.argv;
});
afterEach(async () => {
  process.argv = argv;
  vi.restoreAllMocks();
  for (const path of locations.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function tree(mode = 'dist') {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-close-identity-')),
  );
  locations.push(root);
  const directory = join(root, mode);
  await mkdir(join(directory, 'harness'), { recursive: true });
  const entrypoint = join(directory, mode === 'src' ? 'index.ts' : 'index.js');
  await writeFile(
    entrypoint,
    '// synthetic execution bytes, not an actual Worker\n',
  );
  await writeFile(
    join(directory, 'harness', 'close.js'),
    'export const mode = 1;\n',
  );
  process.argv = [process.execPath, entrypoint];
  return { directory, entrypoint };
}
function input(entrypoint: string) {
  return {
    workerId: randomUUID(),
    workerBootId: randomUUID(),
    entrypoint: pathToFileURL(entrypoint).href,
    nativeArtifactId,
    serviceBuildIdentity: null,
  };
}
describe('Worker close identity measurements without Dev release authority', () => {
  it.each(['dist', 'src'])(
    'measures actual %s bytes in stable order without requiring a Dev manifest',
    async (mode) => {
      const t = await tree(mode),
        request = input(t.entrypoint);
      // Deliberately outside the bounded execution directory; never scanned.
      await writeFile(join(t.directory, '..', 'unrelated'), 'not runtime');
      const first = await observeDshWorkerCloseIdentity(request);
      const second = await observeDshWorkerCloseIdentity(request);
      expect(first.kind).toBe('observed-worker-close-v1');
      expect(first.identity).toEqual(second.identity);
      expect(first.identity).toMatchObject({
        workerId: request.workerId,
        workerBootId: request.workerBootId,
      });
      expect(first.identity.serviceManifestDigest).toMatch(
        /^sha256:[a-f0-9]{64}$/,
      );
      expect(first).not.toHaveProperty('sourceSha');
      expect(first).not.toHaveProperty('sourceTree');
      expect(first.measurement.files).toBe(2);
      expect(first.measurement.bytes).toBe(
        (await readFile(t.entrypoint)).length +
          (await readFile(join(t.directory, 'harness', 'close.js'))).length,
      );
      expect(first.measurement.durationMs).toBeGreaterThanOrEqual(0);
      expect(Object.isFrozen(first.identity)).toBe(true);
      await writeFile(
        join(t.directory, 'harness', 'close.js'),
        'export const mode = 2;\n',
      );
      const changed = await observeDshWorkerCloseIdentity(request);
      expect(changed.identity.serviceManifestDigest).not.toBe(
        first.identity.serviceManifestDigest,
      );
    },
  );
  it('new boot keeps content identity but receives a distinct durable owner tuple', async () => {
    const t = await tree(),
      request = input(t.entrypoint);
    const first = await observeDshWorkerCloseIdentity(request);
    const second = await observeDshWorkerCloseIdentity({
      ...request,
      workerBootId: randomUUID(),
    });
    expect(first.identity.serviceManifestDigest).toBe(
      second.identity.serviceManifestDigest,
    );
    expect(first.identity.workerBootId).not.toBe(second.identity.workerBootId);
  });
  it('retains the fully verified Dev manifest identity and same real boot without scanning files again', async () => {
    const request = input('/absent-not-read');
    const sealed = {
      version: 1,
      environment: 'dev',
      service: 'worker',
      mode: 'production',
      sourceSha: 'a'.repeat(40),
      sourceTree: 'b'.repeat(40),
      manifestDigest: checksum(
        'unit fixture for the already-verified Dev branch',
      ),
      artifactDigest: checksum('worker'),
      runtimeGraphDigest: checksum('graph'),
      webBuildId: 'fixture',
      bootId: request.workerBootId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      nodeVersion: process.version,
      protocols: {
        identity: 1,
        ordinaryConsumer: 1,
        releaseAdmission: 'disabled',
      },
    } satisfies ServiceBuildIdentity;
    const result = await observeDshWorkerCloseIdentity({
      ...request,
      serviceBuildIdentity: sealed,
    });
    expect(result.kind).toBe('sealed-dev-close-v1');
    expect(result.identity).toEqual({
      workerId: request.workerId,
      workerBootId: sealed.bootId,
      serviceManifestDigest: sealed.manifestDigest,
    });
    expect(result.measurement.files).toBe(0);
    await expect(
      observeDshWorkerCloseIdentity({
        ...request,
        serviceBuildIdentity: { ...sealed, bootId: randomUUID() },
      }),
    ).rejects.toThrow('DSH_CLOSE_WORKER_IDENTITY_INVALID');
    await expect(
      observeDshWorkerCloseIdentity({
        ...request,
        serviceBuildIdentity: { ...sealed, pid: process.pid + 1 },
      }),
    ).rejects.toThrow('DSH_CLOSE_WORKER_IDENTITY_INVALID');
  });
  it.each(['entrypoint', 'nested', 'directory'])(
    'rejects an unexpected %s symbolic link rather than measuring a substituted tree',
    async (location) => {
      const t = await tree(),
        request = input(t.entrypoint);
      if (location === 'entrypoint') {
        await symlink(t.entrypoint, join(t.directory, 'other.js'));
        request.entrypoint = pathToFileURL(join(t.directory, 'other.js')).href;
      } else if (location === 'nested') {
        await symlink(
          t.entrypoint,
          join(t.directory, 'harness', 'override.js'),
        );
      } else {
        await symlink(join(t.directory, 'harness'), join(t.directory, 'alias'));
      }
      await expect(observeDshWorkerCloseIdentity(request)).rejects.toThrow(
        'DSH_CLOSE_WORKER_IDENTITY_INVALID',
      );
    },
  );
  it('rejects another process entrypoint and invalid native or boot identity', async () => {
    const t = await tree(),
      request = input(t.entrypoint);
    process.argv = [process.execPath, join(t.directory, 'harness', 'close.js')];
    await expect(observeDshWorkerCloseIdentity(request)).rejects.toThrow(
      'DSH_CLOSE_WORKER_IDENTITY_INVALID',
    );
    process.argv = [process.execPath, t.entrypoint];
    await expect(
      observeDshWorkerCloseIdentity({ ...request, nativeArtifactId: '' }),
    ).rejects.toThrow('DSH_CLOSE_WORKER_IDENTITY_INVALID');
    await expect(
      observeDshWorkerCloseIdentity({ ...request, workerBootId: 'unknown' }),
    ).rejects.toThrow('DSH_CLOSE_WORKER_IDENTITY_INVALID');
  });
  it('does not turn an unreadable entrypoint into a synthetic identity', async () => {
    const t = await tree();
    await rm(t.entrypoint);
    await expect(
      observeDshWorkerCloseIdentity(input(t.entrypoint)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses a nested module installation and an execution directory without a known Worker entrypoint', async () => {
    const t = await tree(),
      request = input(t.entrypoint);
    await mkdir(join(t.directory, 'node_modules'));
    await expect(observeDshWorkerCloseIdentity(request)).rejects.toThrow(
      'DSH_CLOSE_WORKER_IDENTITY_INVALID',
    );
    const bad = await tree('arbitrary');
    await expect(
      observeDshWorkerCloseIdentity(input(bad.entrypoint)),
    ).rejects.toThrow('DSH_CLOSE_WORKER_IDENTITY_INVALID');
  });
});
