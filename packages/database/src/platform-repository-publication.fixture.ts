/** Synthetic accepted data for transaction tests, never physical compilation proof. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compiledDependencyFixture } from './platform-repair-compiled.fixture.ts';
import { repairHarnessChecksumFor } from './platform-repair-profile.ts';
import {
  repositoryCandidate,
  repositoryDigest,
} from './platform-repository-source.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import { compiledRepairProfileId } from './platform-repair-compiled-contracts.ts';
import {
  RepositoryBaselineSchema,
  repairProfileId,
  repairProductPath,
  RepairReportSchema,
} from './platform-repair-contracts.ts';
export function acceptedRepositoryFixture(
  loginId: string,
  authenticatedAt: string,
) {
  const d = compiledDependencyFixture(),
    digest = repositoryDigest('synthetic'),
    now = new Date().toISOString();
  const before = readFileSync(
      new URL('../../project-runtime/src/command-output.ts', import.meta.url),
      'utf8',
    ),
    after = before.replace("'$1[REDACTED]',", "'$1[REDACTED] ',");
  const baseline = RepositoryBaselineSchema.parse({
    version: 1,
    id: randomUUID(),
    repositoryId: 'semiok/allrice',
    sourceSha: 'a'.repeat(40),
    gitTree: 'b'.repeat(40),
    sourceDigest: digest,
    ...d.baseline,
    archiveChecksum: digest,
    archiveBytes: 1000,
    fileCount: 4,
    sourceBytes: 10000,
    observedDevSha: 'a'.repeat(40),
    registeredAt: now,
    materializer: 'git-tracked-json-gzip-v1',
    profileId: repairProfileId,
    dependencyMode: 'runtime_builtins_only',
    monorepoDependenciesInstalled: false,
    compiledDependencies: d.descriptor,
  });
  const fields = {
    requestId: randomUUID(),
    baselineId: baseline.id,
    verificationMode: 'compiled_packages' as const,
    version: 1,
    baseline,
    baselineText: before,
    harnessChecksum: repairHarnessChecksumFor(true),
    releaseSha: baseline.sourceSha,
    assignmentId: randomUUID(),
    employeeVersionId: randomUUID(),
    employeeRevisionId: randomUUID(),
    userMessageId: randomUUID(),
    assistantMessageId: randomUUID(),
    loginSessionId: loginId,
    loginAuthenticatedAt: authenticatedAt,
    timeoutMs: 900000,
  };
  const frozen = { ...fields, fingerprint: technicalDigest(fields) },
    candidate = repositoryCandidate(1, [
      {
        path: repairProductPath,
        beforeChecksum: repositoryDigest(before),
        afterBase64: Buffer.from(after).toString('base64'),
      },
    ]);
  function report(revision: number) {
    return {
      version: 2,
      profileId: compiledRepairProfileId,
      dependencyMode: 'pnpm_frozen_two_packages',
      baselineId: baseline.id,
      sourceSha: baseline.sourceSha,
      baselineSourceDigest: baseline.sourceDigest,
      restoredDigest: baseline.sourceDigest,
      candidateChecksum: revision
        ? candidate.checksum
        : repositoryCandidate(0, []).checksum,
      candidateMaterialDigest: digest,
      actualMaterialDigest: digest,
      ...d.baseline,
      harnessChecksum: frozen.harnessChecksum,
      monorepoDependenciesInstalled: false,
      nodeVersion: 'v22.23.2',
      sourceFileCount: 4,
      sourceBytes: 10000,
      candidateIdentity: { uid: 1001, gid: 1001, capabilities: 'none' },
      assertions: Array.from({ length: 8 }, (_, i) => ({
        id: 'case_' + i,
        passed: !!revision,
      })),
      failureKind: revision ? null : 'assertion_failed',
      exitCode: revision ? 0 : 1,
      compiled: {
        dependencyBundleChecksum: d.descriptor.bundleChecksum,
        dependencyMaterialDigest: d.descriptor.materialDigest,
        planDigest: d.descriptor.planDigest,
        managerVersion: '10.33.3',
        compilerVersion: '5.9.3',
        compilerIdentity: { uid: 1002, gid: 1002, capabilities: 'none' },
        steps: ['dependencies', 'build_contracts', 'build_project_runtime'].map(
          (id) => ({
            id,
            argv: ['fixture'],
            cwd: 'workspace',
            originalScript: null,
            exitCode: 0,
            signal: null,
            elapsedMs: 1,
            outputDigest: digest,
            outputBytes: 1,
            outputTruncated: false,
            status: 'passed',
          }),
        ),
        packages: ['@allrice/contracts', '@allrice/project-runtime'].map(
          (name) => ({ name, digest, fileCount: 1, sizeBytes: 1 }),
        ),
        productionEntry: 'packages/project-runtime/dist/index.js',
        executionTarget: 'production_package_export',
        timeoutMs: 300000,
        memoryMiB: 768,
        compilerHeapMiB: 384,
        generatedTreeDigest: digest,
        sourceProjectionDigest: digest,
        workBytesAfterBuild: 1000,
        offline: true,
        lifecycleScripts: 'disabled',
        wholeWorkspaceDependenciesInstalled: false,
      },
    };
  }
  const accepted = RepairReportSchema.parse({
    version: 1,
    candidateChecksum: candidate.checksum,
    before: {
      completedAt: now,
      revision: 0,
      operationId: randomUUID(),
      report: report(0),
      stopped: true,
      cleanup: 'confirmed',
    },
    after: {
      completedAt: now,
      revision: 1,
      operationId: randomUUID(),
      report: report(1),
      stopped: true,
      cleanup: 'confirmed',
    },
    artifacts: ['candidate', 'report'].map((kind) => ({
      kind,
      artifactId: randomUUID(),
      versionId: randomUUID(),
      objectId: randomUUID(),
      checksum: digest,
      fileName: kind + '.json',
      sizeBytes: 100,
    })),
    completedAt: now,
    verdict: 'fixed_assertions_passed',
    publishedToMain: false,
    wholeRepositoryBuildVerified: false,
  });
  return { frozen, candidate, report: accepted };
}
