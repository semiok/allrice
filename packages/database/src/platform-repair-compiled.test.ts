import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  CreateRepairTaskSchema,
  RepositoryBaselineSchema,
  RepositoryExecutionProofSchema,
  repairProfileId,
} from './platform-repair-contracts.ts';
import { compiledRepairProfileId } from './platform-repair-compiled-contracts.ts';
import {
  dependencyMaterialDigest,
  readCompiledDependencies,
} from './platform-repair-dependencies.ts';
import {
  repositoryCandidate,
  repositoryDigest,
} from './platform-repository-source.ts';
import {
  repositoryVerificationCommand,
  repairHarnessChecksum,
  repairHarnessChecksumFor,
} from './platform-repair-profile.ts';

import { compiledDependencyFixture as dependencyFixture } from './platform-repair-compiled.fixture.ts';

describe('finite compiled repository verification boundaries', () => {
  it('binds both original dependency configuration and all frozen bytes, including the separate generated plan', () => {
    const f = dependencyFixture();
    expect(
      readCompiledDependencies(f.bytes, f.descriptor, f.baseline).bundle.files,
    ).toHaveLength(11);
    for (const change of [
      { rootLockChecksum: repositoryDigest('another lock') },
      { dependencyConfigurationDigest: repositoryDigest('another config') },
      { bundleChecksum: repositoryDigest('another bundle') },
      { materialDigest: repositoryDigest('another material') },
      { planDigest: repositoryDigest('another projection') },
      {
        manager: {
          ...f.descriptor.manager,
          checksum: repositoryDigest('another manager'),
        },
      },
      {
        packages: f.descriptor.packages.map((p, i) =>
          i ? p : { ...p, checksum: repositoryDigest('another archive') },
        ),
      },
    ])
      expect(() =>
        readCompiledDependencies(
          f.bytes,
          { ...f.descriptor, ...change },
          f.baseline,
        ),
      ).toThrow();
    expect(() =>
      readCompiledDependencies(
        f.bytes.subarray(0, -1),
        f.descriptor,
        f.baseline,
      ),
    ).toThrow();
  });

  it('rejects extra, aliased and changed package payloads even when an attacker recalculates transport hashes', () => {
    const f = dependencyFixture();
    for (const files of [
      [...f.bundle.files, f.bundle.files[0]!],
      f.bundle.files.map((v, i) =>
        i === 1 ? { ...v, path: 'archives/../manager.tgz' } : v,
      ),
      f.bundle.files.map((v, i) =>
        i === 1 ? { ...v, path: 'archives/6.tgz' } : v,
      ),
      f.bundle.files.map((v, i) =>
        i === 1
          ? { ...v, contentBase64: Buffer.from('changed').toString('base64') }
          : v,
      ),
    ]) {
      const bytes = gzipSync(
        Buffer.from(JSON.stringify({ ...f.bundle, files })),
      );
      expect(() =>
        readCompiledDependencies(
          bytes,
          {
            ...f.descriptor,
            bundleChecksum: repositoryDigest(bytes),
            bundleBytes: bytes.length,
            materialDigest: dependencyMaterialDigest(files),
          },
          f.baseline,
        ),
      ).toThrow();
    }
  });

  it('separates private input budgets and the immutable harness without silently upgrading historical requests', () => {
    const old = { requestId: randomUUID(), baselineId: randomUUID() };
    expect(CreateRepairTaskSchema.parse(old)).toEqual(old);
    for (const field of [
      'reuseSeed',
      'candidate',
      'compilerUid',
      'tmpfsMiB',
      'inputLimit',
      'modelUsed',
    ])
      expect(
        CreateRepairTaskSchema.safeParse({ ...old, [field]: true }).success,
      ).toBe(false);
    const common = {
      commandDigest: repositoryDigest('command'),
      baselineId: old.baselineId,
      candidateChecksum: repositoryCandidate(0, []).checksum,
    };
    const v1 = {
      ...common,
      version: 1,
      profileId: repairProfileId,
      inputLimit: 12_000_000,
      tmpfsMiB: 64,
    };
    expect(RepositoryExecutionProofSchema.parse(v1)).toEqual(v1);
    expect(
      RepositoryExecutionProofSchema.safeParse({ ...v1, tmpfsMiB: 128 })
        .success,
    ).toBe(false);
    const v2 = {
      ...common,
      version: 2,
      profileId: compiledRepairProfileId,
      inputLimit: 23_000_000,
      tmpfsMiB: 128,
      dependencyChecksum: repositoryDigest('dependencies'),
      planDigest: repositoryDigest('plan'),
      timeoutMs: 300_000,
      memoryMiB: 768,
    };
    expect(RepositoryExecutionProofSchema.parse(v2)).toEqual(v2);
    expect(
      RepositoryExecutionProofSchema.safeParse({
        ...v2,
        inputLimit: 24_000_000,
      }).success,
    ).toBe(false);
    expect(repairHarnessChecksumFor(false)).toBe(repairHarnessChecksum);
    expect(repairHarnessChecksumFor(true)).not.toBe(repairHarnessChecksum);
  });

  it('generates a valid trusted handoff and Node production-export verifier, while v1 remains one-input', () => {
    const f = dependencyFixture();
    const baseline = RepositoryBaselineSchema.parse({
      version: 1,
      id: randomUUID(),
      repositoryId: 'semiok/allrice',
      sourceSha: 'a'.repeat(40),
      gitTree: 'b'.repeat(40),
      sourceDigest: repositoryDigest('source'),
      ...f.baseline,
      archiveChecksum: repositoryDigest('archive'),
      archiveBytes: 1000,
      fileCount: 4,
      sourceBytes: 2000,
      observedDevSha: 'a'.repeat(40),
      registeredAt: new Date().toISOString(),
      materializer: 'git-tracked-json-gzip-v1',
      profileId: repairProfileId,
      dependencyMode: 'runtime_builtins_only',
      monorepoDependenciesInstalled: false,
      compiledDependencies: f.descriptor,
    });
    const input = {
      baseline,
      candidate: repositoryCandidate(0, []),
      object: { id: randomUUID(), checksum: baseline.archiveChecksum },
    };
    const old = repositoryVerificationCommand(input);
    const compiled = repositoryVerificationCommand({
      ...input,
      compiled: {
        descriptor: f.descriptor,
        object: { id: randomUUID(), checksum: f.descriptor.bundleChecksum },
      },
    });
    for (const c of [old, compiled])
      execFileSync(process.execPath, ['--input-type=module', '--check'], {
        input: c.script,
      });
    expect(old.inputs).toHaveLength(1);
    expect(compiled.inputs).toHaveLength(2);
    expect(compiled.limits).toEqual(old.limits);
    expect(compiled.script).toContain('process.execve');
    expect(compiled.script).toContain('production_package_export');
    expect(compiled.script).toContain('workBytesAfterBuild');
    expect(compiled.script).not.toContain('peakWorkBytes');
    const reordered = JSON.parse(
      JSON.stringify(f.descriptor, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value,
      ),
    );
    expect(
      repositoryVerificationCommand({
        ...input,
        compiled: {
          descriptor: reordered,
          object: {
            id: compiled.inputs[1]!.objectId,
            checksum: f.descriptor.bundleChecksum,
          },
        },
      }),
    ).toEqual(compiled);
  });
});
