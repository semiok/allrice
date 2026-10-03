import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RuntimeLocalCommandSchema,
  RuntimeProjectPreparationSchema,
  localCommandToolchainImageV1,
} from '@allrice/contracts';
import { projectFixture } from '../test/project-fixture.js';
import {
  ProjectPreparation,
  projectCacheKey,
  projectSourceDigest,
  projectDependencyArchiveLimit,
  projectInstallLock,
  validateProjectPreparation,
} from './project-preparation.js';
import { parseDocument } from 'yaml';
import { createLocalPythonArchive } from './local-python-archive.js';

const scope = () => ({
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  ownerId: randomUUID(),
});
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true });
});
describe('project preparation source, scope and immutable dependency cache', () => {
  it.each(['pnpm', 'uv'] as const)(
    'validates the exact %s source and lock before preparation',
    (manager) => {
      const f = projectFixture(manager);
      expect(validateProjectPreparation(f.command, f.bundle).manager).toBe(
        manager,
      );
      const changed = structuredClone(f.command);
      changed.arguments.files[0]!.sha256 = 'sha256:' + 'f'.repeat(64);
      expect(() => validateProjectPreparation(changed, f.bundle)).toThrow(
        'PROJECT_SOURCE_CHANGED',
      );
      const changedBytes = f.bundle.map((file) =>
        file.path === f.command.arguments.projectPreparation!.lockPath
          ? { ...file, content: Buffer.from('changed').toString('base64') }
          : file,
      );
      expect(() => validateProjectPreparation(f.command, changedBytes)).toThrow(
        'PROJECT_SOURCE_CHANGED',
      );
      expect(
        projectSourceDigest([...f.command.arguments.files].reverse()),
      ).toBe(f.command.arguments.projectPreparation!.sourceDigest);
    },
  );
  it('requires a pinned manager and prevents preparation from acquiring service/candidate authority', () => {
    const f = projectFixture('pnpm'),
      a = f.command.arguments;
    expect(
      RuntimeProjectPreparationSchema.safeParse({
        ...a.projectPreparation,
        managerVersion: 'latest',
      }).success,
    ).toBe(false);
    expect(
      RuntimeLocalCommandSchema.safeParse({
        ...f.command,
        arguments: {
          ...a,
          dependencies: {
            manager: 'npm',
            strategy: 'locked_ci',
            registry: 'https://registry.npmjs.org',
            scripts: 'disabled',
            packages: [],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      RuntimeLocalCommandSchema.safeParse({
        ...f.command,
        arguments: { ...a, executable: '/workspace/.venv/bin/python' },
      }).success,
    ).toBe(false);
  });
  it('projects only approved tarball locations for installation while preserving original lock bytes, versions and SRI', () => {
    const f = projectFixture('pnpm');
    const lock = projectInstallLock(f.command, f.bundle)!;
    expect(lock.original).toEqual(f.files['pnpm-lock.yaml']);
    const original = parseDocument(lock.original.toString()).toJS();
    const installed = JSON.parse(lock.projected.toString());
    for (const entry of Object.values(installed.packages) as {
      resolution: { tarball?: string };
    }[]) {
      expect(entry.resolution.tarball).toMatch(
        /^file:\/tmp\/work\/\.allrice\/archives\/\d+\.tgz$/,
      );
      delete entry.resolution.tarball;
    }
    expect(installed).toEqual(original);
  });
  it('separates architecture, runtime, lock, project and employee caches, while source-only edits reuse compatible dependencies', () => {
    const f = projectFixture('pnpm'),
      spec = f.command.arguments.projectPreparation!,
      s = scope();
    const value = {
        spec,
        scope: s,
        image: localCommandToolchainImageV1,
        architecture: 'amd64',
      },
      key = projectCacheKey(value);
    for (const changed of [
      { ...value, architecture: 'arm64' },
      { ...value, image: 'sha256:' + 'a'.repeat(64) },
      { ...value, spec: { ...spec, lockChecksum: 'sha256:' + 'b'.repeat(64) } },
      { ...value, spec: { ...spec, projectId: randomUUID() } },
      { ...value, scope: { ...s, ownerId: randomUUID() } },
      { ...value, scope: { ...s, organizationId: randomUUID() } },
    ])
      expect(projectCacheKey(changed)).not.toBe(key);
    expect(
      projectCacheKey({
        ...value,
        spec: { ...spec, sourceDigest: 'sha256:' + 'c'.repeat(64) },
      }),
    ).toBe(key);
  });
  it.each(['pnpm', 'uv'] as const)(
    'reuses verified %s archives without replacing a successful cache after a failure',
    async (manager) => {
      const root = await mkdtemp(join(tmpdir(), 'allrice-project-cache-test-'));
      roots.push(root);
      const f = projectFixture(manager),
        s = scope(),
        p = new ProjectPreparation(root),
        input = {
          command: f.command,
          files: f.bundle,
          scope: s,
          signal: AbortSignal.timeout(2000),
        };
      const first = await p.archives(input);
      expect(first.archiveHits).toBe(0);
      expect(first.downloadedArchives).toBe(0);
      const second = await p.archives(input);
      expect(second.archiveHits).toBe(1);
      expect(second.files[0]!.bytes).toEqual(first.files[0]!.bytes);
      const rejected = structuredClone(f.command);
      rejected.arguments.projectPreparation!.packages[0]!.archivePath =
        undefined;
      rejected.arguments.projectPreparation!.offline = true;
      await expect(
        p.archives({
          ...input,
          command: rejected,
          scope: { ...s, ownerId: randomUUID() },
        }),
      ).rejects.toThrow('PROJECT_DEPENDENCY_OFFLINE_MISS');
      expect((await p.archives(input)).archiveHits).toBe(1);
    },
  );
  it('does not prepare dependencies after cancellation or lease loss', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allrice-project-cache-test-'));
    roots.push(root);
    const f = projectFixture('pnpm'),
      p = new ProjectPreparation(root),
      s = scope();
    await expect(
      p.archives({
        command: f.command,
        files: f.bundle,
        scope: s,
        signal: AbortSignal.timeout(2000),
        maintainLease: async () => false,
      }),
    ).rejects.toThrow('EXECUTION_REVOKED');
    const c = new AbortController();
    c.abort();
    await expect(
      p.archives({
        command: f.command,
        files: f.bundle,
        scope: s,
        signal: c.signal,
      }),
    ).rejects.toThrow('EXECUTION_REVOKED');
  });
  it('refuses a symlink cache root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allrice-project-cache-test-'));
    roots.push(root);
    await symlink(root, join(root, 'link'));
    const f = projectFixture('pnpm');
    await expect(
      new ProjectPreparation(join(root, 'link')).archives({
        command: f.command,
        files: f.bundle,
        scope: scope(),
        signal: AbortSignal.timeout(2000),
      }),
    ).rejects.toThrow('PROJECT_CACHE_UNSAFE');
  });
  it('rejects an oversized dependency before caching or staging, and admits the declared transport boundary', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'allrice-project-archive-limit-'),
    );
    roots.push(root);
    const f = projectFixture('uv'),
      p = new ProjectPreparation(root);
    const archive = f.command.arguments.projectPreparation!.packages[0]!;
    const oversized = f.bundle.map((file) =>
      file.path === archive.archivePath
        ? {
            ...file,
            content: Buffer.alloc(projectDependencyArchiveLimit + 1).toString(
              'base64',
            ),
          }
        : file,
    );
    await expect(
      p.archives({
        command: f.command,
        files: oversized,
        scope: scope(),
        signal: AbortSignal.timeout(3000),
      }),
    ).rejects.toThrow('PROJECT_DEPENDENCY_LIMIT');
    expect(
      createLocalPythonArchive([
        {
          path: '.allrice/archives/package.whl',
          bytes: Buffer.alloc(projectDependencyArchiveLimit),
        },
      ]).byteLength,
    ).toBeLessThanOrEqual(24_000_000);
  });
});
