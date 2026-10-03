import { createHash, randomUUID } from 'node:crypto';
import { savedProjectFixture } from '../test/saved-project-fixture.js';
import { expect, it } from 'vitest';
import {
  RuntimeLocalCommandToolInputSchema,
  localProjectResultMatchesPayload,
} from '@allrice/contracts';
import { readSavedProjectInputs } from './local-command-inputs.js';

const hash = (s: string) =>
  `sha256:${createHash('sha256').update(s).digest('hex')}`;
it.each(['pnpm', 'uv'] as const)(
  'restores exact %s source from immutable bytes without a host folder',
  (manager) => {
    const f = savedProjectFixture(manager),
      restored = readSavedProjectInputs(f.command);
    expect(
      Object.fromEntries(
        restored.files.map((v) => [v.path, Buffer.from(v.content, 'base64')]),
      ),
    ).toEqual(f.files);
    const {
      imageDigest,
      isolation,
      network,
      projectSource,
      files,
      ...publicArgs
    } = f.command.arguments;
    expect([imageDigest, isolation, network]).toHaveLength(3);
    expect(
      RuntimeLocalCommandToolInputSchema.parse({
        ...publicArgs,
        project: projectSource!.project,
      }).project,
    ).toEqual(projectSource!.project);
    expect(() =>
      RuntimeLocalCommandToolInputSchema.parse({
        ...publicArgs,
        files,
        project: projectSource!.project,
      }),
    ).toThrow();
    expect(() =>
      RuntimeLocalCommandToolInputSchema.parse({
        ...publicArgs,
        project: projectSource!.project,
        projectSource,
      }),
    ).toThrow();
  },
);
it('rejects changed bytes, source checksum and manifest identity before restoration', () => {
  const f = savedProjectFixture();
  const changed = structuredClone(f.command);
  changed.arguments.projectSource!.snapshot.files[0]!.contentBase64 =
    Buffer.from('changed').toString('base64');
  expect(() => readSavedProjectInputs(changed)).toThrow(
    'PROJECT_SOURCE_CHANGED',
  );
  changed.arguments.projectSource!.project.snapshot.checksum = hash(
    JSON.stringify(changed.arguments.projectSource!.snapshot),
  );
  expect(() => readSavedProjectInputs(changed)).toThrow(
    'PROJECT_SOURCE_CHANGED',
  );
});
it('requires exact restored source, cache key and architecture in successful and stopped receipts', () => {
  const f = savedProjectFixture(),
    s = f.command.arguments.projectSource!,
    p = f.command.arguments.projectPreparation!;
  const result = {
    backend: 'local-vm-container-v1' as const,
    containerId: 'a'.repeat(64),
    imageDigest: f.command.arguments.imageDigest,
    stopped: true as const,
    exitCode: 0,
    reason: 'exited' as const,
    stdout: '',
    stderr: '',
    truncated: false,
    workCopy: 'local_isolated_copy' as const,
    sourceDirectoryModified: false as const,
    projectPreparation: {
      ...p,
      cacheKey: s.cacheKey,
      platform: 'linux-amd64' as const,
      runtimeImage: f.command.arguments.imageDigest,
      packageCount: p.packages.length,
      archiveHits: 1,
      downloadedArchives: 0,
      downloadedBytes: 0,
      installation: 'succeeded' as const,
      cacheVolume: `allrice-project-cache-${s.cacheKey.slice(7)}`,
      sourceDirectoryModified: false as const,
      hostEnvironmentModified: false as const,
      savedSource: { project: s.project, restoredDigest: p.sourceDigest },
    },
  };
  expect(localProjectResultMatchesPayload(f.command, result)).toBe(true);
  for (const proof of [
    { savedSource: { project: s.project, restoredDigest: null } },
    { platform: 'linux-arm64' as const },
    { cacheKey: `sha256:${'b'.repeat(64)}` },
    {
      savedSource: {
        project: {
          ...s.project,
          snapshot: { ...s.project.snapshot, id: randomUUID() },
        },
        restoredDigest: p.sourceDigest,
      },
    },
  ])
    expect(
      localProjectResultMatchesPayload(f.command, {
        ...result,
        projectPreparation: { ...result.projectPreparation, ...proof },
      }),
    ).toBe(false);
  expect(
    localProjectResultMatchesPayload(f.command, {
      ...result,
      reason: 'canceled',
      exitCode: 137,
      projectPreparation: {
        ...result.projectPreparation,
        installation: 'interrupted',
        savedSource: { project: s.project, restoredDigest: null },
      },
    }),
  ).toBe(true);
});
