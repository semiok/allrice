import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  cloudToolchainImageV1,
  runtimeNpmPackageUrl,
} from '@allrice/contracts';
import { ProjectPreparation } from './project-preparation.js';
import { readResolvedProject } from './project-resolution.js';
import { downloadPublicPackage } from './npm-registry-download.js';
vi.mock('./npm-registry-download.js', () => ({
  downloadPublicPackage: vi.fn(),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'allrice-archive-concurrency-'));
  roots.push(root);
  const packages = Array.from({ length: 5 }, (_, i) => ({
    name: 'synthetic-' + i,
    version: '1.0.0',
  }));
  const bytes = packages.map((p) => Buffer.from('verified:' + p.name));
  const integrity = bytes.map(
    (b) => 'sha512-' + createHash('sha512').update(b).digest('base64'),
  );
  const lock =
    "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n" +
    packages
      .map((p) => `      ${p.name}: {specifier: 1.0.0, version: 1.0.0}\n`)
      .join('') +
    'packages:\n' +
    packages
      .map(
        (p, i) =>
          `  ${p.name}@1.0.0:\n    resolution: {integrity: ${integrity[i]}}\n`,
      )
      .join('') +
    'snapshots:\n' +
    packages.map((p) => `  ${p.name}@1.0.0: {}\n`).join('');
  const resolved = readResolvedProject(
    {
      action: 'resolve',
      manager: 'pnpm',
      resourceProfile: 'standard',
      packages,
    },
    Buffer.from(
      JSON.stringify({
        version: 1,
        manager: 'pnpm',
        phase: 'lock_validation',
        status: 'resolved',
        exitCode: 0,
        diagnostics: '',
        lock,
      }),
    ),
  );
  const spec = resolved.forProject!(randomUUID());
  const input: Parameters<ProjectPreparation['archives']>[0] = {
    command: {
      arguments: {
        executable: '/usr/local/bin/node',
        args: [],
        path: '.',
        files: resolved.files!.map((f) => ({
          path: f.path,
          sha256: 'sha256:' + createHash('sha256').update(f.text).digest('hex'),
        })),
        imageDigest: cloudToolchainImageV1,
        limits: {
          timeoutMs: 60000,
          outputBytes: 16384,
          memoryMiB: 512,
          cpuMillis: 1000,
          pids: 64,
        },
        projectPreparation: spec,
      },
    },
    files: resolved.files!.map((f) => ({
      path: f.path,
      content: Buffer.from(f.text).toString('base64'),
    })),
    scope: {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      ownerId: randomUUID(),
    },
    signal: AbortSignal.timeout(5000),
  };
  return {
    root,
    input,
    p: new ProjectPreparation(root),
    bytes,
    urls:
      spec.manager === 'pnpm' ? spec.packages.map(runtimeNpmPackageUrl) : [],
  };
}
it('overlaps only two verified downloads, preserves staging order and reuses exact cached bytes', async () => {
  const f = await fixture();
  let active = 0,
    peak = 0;
  vi.mocked(downloadPublicPackage).mockImplementation(async (url) => {
    active++;
    peak = Math.max(peak, active);
    const i = f.urls.indexOf(url.href);
    expect(i).toBeGreaterThanOrEqual(0);
    try {
      await new Promise((r) => setTimeout(r, i % 2 ? 5 : 20));
      return f.bytes[i]!;
    } finally {
      active--;
    }
  });
  const result = await f.p.archives(f.input);
  expect(peak).toBe(2);
  expect(active).toBe(0);
  expect(result.downloadedArchives).toBe(5);
  expect(result.files.slice(0, 5).map((f) => f.bytes)).toEqual(f.bytes);
  const reused = await f.p.archives(f.input);
  expect(reused.archiveHits).toBe(5);
  expect(reused.downloadedArchives).toBe(0);
  expect(downloadPublicPackage).toHaveBeenCalledTimes(5);
});
it('a bad hash aborts and drains its peer before releasing cache pins or admitting more downloads', async () => {
  const f = await fixture();
  let active = 0,
    aborted = false;
  vi.mocked(downloadPublicPackage).mockImplementation(async (url, signal) => {
    active++;
    try {
      if (url.href === f.urls[0]) {
        await new Promise((r) => setTimeout(r, 20));
        return Buffer.from('tampered');
      }
      return await new Promise<Buffer>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(Error('aborted'));
          },
          { once: true },
        );
      });
    } finally {
      active--;
    }
  });
  await expect(f.p.archives(f.input)).rejects.toThrow(
    'PROJECT_DEPENDENCY_INTEGRITY',
  );
  expect(active).toBe(0);
  expect(aborted).toBe(true);
  expect(downloadPublicPackage).toHaveBeenCalledTimes(2);
  const entries = await readdir(join(f.root, 'archives'), { recursive: true });
  expect(entries.some((n) => n.endsWith('.part'))).toBe(false);
});
