import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  truncateSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RepositoryBaselineSchema,
  RepositoryVerificationSchema,
  repairProfileId,
  repairProductPath,
  repositorySourceLimits,
} from './platform-repair-contracts.ts';
import {
  validateRepositoryArchive,
  readRepositoryArchive,
  repositoryDigest,
  repositoryMaterialDigest,
  repositoryDependencyDigest,
  repositoryCandidate,
  applyRepositoryCandidate,
  loadRepositoryBaseline,
  repositoryCatalog,
} from './platform-repository-source.ts';
import {
  repairAssertionCases,
  repairHarnessChecksum,
  readRepositoryVerification,
  repositoryVerificationCommand,
} from './platform-repair-profile.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const file = (path: string, text: string) => {
  const bytes = Buffer.from(text);
  return {
    path,
    mode: '100644' as const,
    sizeBytes: bytes.length,
    checksum: repositoryDigest(bytes),
    contentBase64: bytes.toString('base64'),
  };
};
function fixture() {
  const archive = validateRepositoryArchive({
    version: 1,
    files: [
      file('pnpm-lock.yaml', 'lockfileVersion: 9.0\n'),
      file('pnpm-workspace.yaml', "packages: ['packages/*']\n"),
      file('package.json', '{}\n'),
      file('.npmrc', 'engine-strict=true\nstrict-peer-dependencies=false\n'),
      file(repairProductPath, 'export const fixture = 1;\n'),
    ],
  });
  const bytes = gzipSync(Buffer.from(JSON.stringify(archive)));
  const baseline = RepositoryBaselineSchema.parse({
    version: 1,
    id: randomUUID(),
    repositoryId: 'semiok/allrice',
    sourceSha: '1'.repeat(40),
    gitTree: '2'.repeat(40),
    sourceDigest: repositoryMaterialDigest(archive.files),
    rootLockChecksum: archive.files[0]!.checksum,
    dependencyConfigurationDigest: repositoryDependencyDigest(archive.files),
    archiveChecksum: repositoryDigest(bytes),
    archiveBytes: bytes.length,
    fileCount: archive.files.length,
    sourceBytes: archive.files.reduce((n, f) => n + f.sizeBytes, 0),
    observedDevSha: '3'.repeat(40),
    registeredAt: new Date().toISOString(),
    materializer: 'git-tracked-json-gzip-v1',
    profileId: repairProfileId,
    dependencyMode: 'runtime_builtins_only',
    monorepoDependenciesInstalled: false,
  });
  return { archive, bytes, baseline };
}
describe('operator-owned immutable full repository source boundary', () => {
  it('binds original archive bytes, every source mode/hash, lock and dependency configuration independently', () => {
    const { archive, bytes, baseline } = fixture();
    expect(readRepositoryArchive(bytes, baseline)).toEqual(archive);
    for (const change of [
      { archiveChecksum: repositoryDigest('other') },
      { fileCount: 4 },
      { sourceDigest: repositoryDigest('other') },
      { rootLockChecksum: repositoryDigest('other') },
      { dependencyConfigurationDigest: repositoryDigest('other') },
    ])
      expect(() =>
        readRepositoryArchive(bytes, { ...baseline, ...change }),
      ).toThrow();
    expect(() =>
      validateRepositoryArchive({
        ...archive,
        files: archive.files.map((f) =>
          f.path === repairProductPath
            ? {
                ...f,
                contentBase64: Buffer.from('different').toString('base64'),
              }
            : f,
        ),
      }),
    ).toThrow('REPOSITORY_SOURCE_CHANGED');
  });
  it('rejects traversal, case aliases, links, overlapping paths even with a sorted intervening name, and private host configuration', () => {
    for (const path of [
      '../secret',
      'x/../../secret',
      '/secret',
      '.git/config',
      'foo/.npmrc',
      '.env',
      '.credentials.yaml',
      '.ssh/id_rsa',
    ])
      expect(() =>
        validateRepositoryArchive({
          version: 1,
          files: [file(path, 'synthetic')],
        }),
      ).toThrow();
    expect(() =>
      validateRepositoryArchive({
        version: 1,
        files: [file('A.ts', 'a'), file('a.ts', 'b')],
      }),
    ).toThrow();
    expect(() =>
      validateRepositoryArchive({
        version: 1,
        files: [file('a', 'a'), file('a.a', 'b'), file('a/x', 'c')],
      }),
    ).toThrow();
    expect(() =>
      validateRepositoryArchive({
        version: 1,
        files: [{ ...file('a', 'b'), mode: '120000' }],
      }),
    ).toThrow();
    expect(() =>
      validateRepositoryArchive({
        version: 1,
        files: [
          file('.npmrc', '//registry.example/:_authToken=synthetic-hidden'),
        ],
      }),
    ).toThrow();
    expect(
      validateRepositoryArchive({
        version: 1,
        files: [file('.npmrc', 'engine-strict=true\n')],
      }).files,
    ).toHaveLength(1);
  });
  it('does not promote a finite module snapshot to a full repository; the separate budgets reject overlarge and noncanonical bytes', () => {
    const entry = file('large.txt', 'x'.repeat(200_001));
    expect(
      validateRepositoryArchive({ version: 1, files: [entry] }).files[0]!
        .sizeBytes,
    ).toBe(200_001);
    expect(() =>
      validateRepositoryArchive({
        version: 1,
        files: [{ ...entry, contentBase64: entry.contentBase64 + '\n' }],
      }),
    ).toThrow();
    expect(() =>
      validateRepositoryArchive({
        version: 1,
        files: [
          file('over.txt', 'x'.repeat(repositorySourceLimits.fileBytes + 1)),
        ],
      }),
    ).toThrow();
  });
  it('applies only the exact product path and original before checksum, preserving every other file and changing the material digest', () => {
    const { archive } = fixture(),
      before = archive.files.at(-1)!;
    const candidate = repositoryCandidate(1, [
      {
        path: repairProductPath,
        beforeChecksum: before.checksum,
        afterBase64: Buffer.from('export const fixture = 2;\n').toString(
          'base64',
        ),
      },
    ]);
    const applied = applyRepositoryCandidate(archive, candidate);
    expect(applied.archive.files.slice(0, -1)).toEqual(
      archive.files.slice(0, -1),
    );
    expect(repositoryMaterialDigest(applied.archive.files)).not.toBe(
      repositoryMaterialDigest(archive.files),
    );
    expect(() =>
      applyRepositoryCandidate(archive, {
        ...candidate,
        checksum: repositoryDigest('invented'),
      }),
    ).toThrow();
    expect(() =>
      applyRepositoryCandidate(
        archive,
        repositoryCandidate(1, [
          {
            path: repairProductPath,
            beforeChecksum: repositoryDigest('stale'),
            afterBase64: candidate.files[0]!.afterBase64,
          },
        ]),
      ),
    ).toThrow();
    expect(() => repositoryCandidate(0, candidate.files)).not.toThrow();
    expect(() =>
      applyRepositoryCandidate(
        archive,
        repositoryCandidate(0, candidate.files),
      ),
    ).toThrow();
  });
  it('bounds original file reads, rejects catalog symlinks and corrupted/sparse oversized archives, and clears invalid catalog output', () => {
    const { baseline, bytes } = fixture(),
      root = realpathSync(
        mkdtempSync(join(tmpdir(), 'allrice-repository-unit-')),
      );
    roots.push(root);
    const folder = join(root, baseline.id);
    mkdirSync(folder);
    writeFileSync(join(folder, 'baseline.json'), JSON.stringify(baseline));
    writeFileSync(join(folder, 'source.json.gz'), bytes);
    expect(loadRepositoryBaseline(root, baseline.id).baseline).toEqual(
      baseline,
    );
    expect(repositoryCatalog(root).state).toBe('available');
    rmSync(join(folder, 'source.json.gz'));
    symlinkSync(join(folder, 'baseline.json'), join(folder, 'source.json.gz'));
    expect(() => loadRepositoryBaseline(root, baseline.id)).toThrow();
    expect(repositoryCatalog(root)).toEqual({
      state: 'unavailable',
      baselines: [],
    });
    rmSync(join(folder, 'source.json.gz'));
    writeFileSync(join(folder, 'source.json.gz'), 'x');
    truncateSync(
      join(folder, 'source.json.gz'),
      repositorySourceLimits.archiveBytes + 1,
    );
    expect(() => loadRepositoryBaseline(root, baseline.id)).toThrow();
  });
  it('keeps the immutable harness and public assertion schema in parity before a physical command, and binds readback to exact candidate material', () => {
    const { baseline } = fixture(),
      candidate = repositoryCandidate(0, []),
      object = { id: randomUUID(), checksum: baseline.archiveChecksum };
    const command = repositoryVerificationCommand({
      baseline,
      candidate,
      object,
    });
    expect(command.inputs).toEqual([
      {
        path: 'repository.json.gz',
        objectId: object.id,
        checksum: object.checksum,
      },
    ]);
    expect(command.limits.timeoutMs).toBe(60000);
    const proof = RepositoryVerificationSchema.parse({
      version: 1,
      baselineId: baseline.id,
      sourceSha: baseline.sourceSha,
      baselineSourceDigest: baseline.sourceDigest,
      restoredDigest: baseline.sourceDigest,
      candidateChecksum: candidate.checksum,
      candidateMaterialDigest: baseline.sourceDigest,
      actualMaterialDigest: baseline.sourceDigest,
      rootLockChecksum: baseline.rootLockChecksum,
      dependencyConfigurationDigest: baseline.dependencyConfigurationDigest,
      profileId: repairProfileId,
      harnessChecksum: repairHarnessChecksum,
      dependencyMode: 'runtime_builtins_only',
      monorepoDependenciesInstalled: false,
      nodeVersion: 'v22.23.2',
      sourceFileCount: baseline.fileCount,
      sourceBytes: baseline.sourceBytes,
      candidateIdentity: { uid: 1001, gid: 1001, capabilities: 'none' },
      assertions: repairAssertionCases.map((c) => ({ id: c.id, passed: true })),
      failureKind: null,
      exitCode: 0,
    });
    const output = 'ALLRICE_REPOSITORY_VERIFICATION ' + JSON.stringify(proof);
    expect(
      readRepositoryVerification(output, baseline, candidate, {
        digest: baseline.sourceDigest,
        sourceBytes: baseline.sourceBytes,
      }),
    ).toEqual(proof);
    expect(() =>
      readRepositoryVerification(output, baseline, candidate, {
        digest: repositoryDigest('other'),
        sourceBytes: baseline.sourceBytes,
      }),
    ).toThrow();
    expect(() =>
      readRepositoryVerification(output + '\n' + output, baseline, candidate, {
        digest: baseline.sourceDigest,
        sourceBytes: baseline.sourceBytes,
      }),
    ).toThrow();
    expect(() =>
      readRepositoryVerification(
        'ALLRICE_REPOSITORY_VERIFICATION ' +
          JSON.stringify({ ...proof, exitCode: 1 }),
        baseline,
        candidate,
        { digest: baseline.sourceDigest, sourceBytes: baseline.sourceBytes },
      ),
    ).toThrow();
  });
});
