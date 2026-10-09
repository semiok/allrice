import type { MaintenanceRepairPlan } from './platform-maintenance-authority-contracts.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import { MaintenanceRepairPlanSchema } from './platform-maintenance-authority-contracts.ts';
import {
  maintenanceRepositoryHarness,
  maintenanceVerificationHarnessChecksum,
  maintenanceCompiledProfileId,
} from './platform-maintenance-profile.ts';
import { CloudCommandInputSchema } from '@allrice/contracts';
import {
  RepositoryBaselineSchema,
  RepositoryCandidateSchema,
  RepositoryVerificationSchema,
  repairProfileId,
  repairProductPath,
  repositorySourceLimits,
  compiledRepairProfileId,
  CompiledDependencyDescriptorSchema,
  type CompiledDependencyDescriptor,
  type RepositoryBaseline,
  type RepositoryCandidate,
} from './platform-repair-contracts.ts';
import { repositoryDigest } from './platform-repository-source.ts';
import {
  repairSlotStart,
  repairSlotClose,
  repairSlotPattern,
  repairReplacementPattern,
} from './platform-repair-template.ts';
import {
  compiledRepairChildHarness,
  compiledRepositoryHarness,
  compiledHarnessChecksum,
} from './platform-repair-compiled-profile.ts';

import {
  repairAssertionCases,
  repositoryHarness,
  childHarness,
} from './platform-repair-oracle.ts';
export {
  repairAssertionCases,
  repositoryHarness,
} from './platform-repair-oracle.ts';
export const repairHarnessChecksum = repositoryDigest(
  JSON.stringify({
    harness: repositoryHarness,
    childHarness,
    cases: repairAssertionCases,
    slot: {
      start: repairSlotStart,
      close: repairSlotClose,
      pattern: repairSlotPattern,
      replacement: repairReplacementPattern,
    },
  }),
);
export function repositoryVerificationCommand(input: {
  baseline: RepositoryBaseline;
  candidate: RepositoryCandidate;
  object: { id: string; checksum: string };
  maintenance?: {
    verificationPlan: MaintenanceRepairPlan;
    verificationPlanDigest: string;
  };
  compiled?: {
    descriptor: CompiledDependencyDescriptor;
    object: { id: string; checksum: string };
  };
}) {
  const baseline = RepositoryBaselineSchema.parse(input.baseline),
    candidate = RepositoryCandidateSchema.parse(input.candidate);
  const maintenance = input.maintenance
    ? {
        ...input.maintenance,
        verificationPlan: MaintenanceRepairPlanSchema.parse(
          input.maintenance.verificationPlan,
        ),
        profileId: maintenanceCompiledProfileId,
        manifestDigest: technicalDigest(
          input.maintenance.verificationPlan.approvedFiles,
        ),
      }
    : undefined;
  if (
    maintenance &&
    (!input.compiled ||
      maintenance.verificationPlanDigest !==
        technicalDigest(maintenance.verificationPlan) ||
      maintenance.verificationPlan.harnessChecksum !==
        maintenanceVerificationHarnessChecksum)
  )
    throw Error('MAINTENANCE_VERIFICATION_PLAN_CHANGED');
  const config = {
    baseline,
    candidate,
    profileId: input.compiled ? compiledRepairProfileId : repairProfileId,
    productPath: repairProductPath,
    childHarness: input.compiled ? compiledRepairChildHarness : childHarness,
    slot: {
      start: repairSlotStart,
      close: repairSlotClose,
      pattern: repairSlotPattern,
      replacement: repairReplacementPattern,
    },
    cases: repairAssertionCases,
    harnessChecksum: maintenance
      ? maintenanceVerificationHarnessChecksum
      : repairHarnessChecksumFor(!!input.compiled),
    ...(maintenance ? { maintenance } : {}),
    limits: repositorySourceLimits,
    // PostgreSQL jsonb reorders keys. Schema parsing produces the same ordered
    // descriptor for preparation, lease checks and recovery command digests.
    ...(input.compiled
      ? {
          compiled: CompiledDependencyDescriptorSchema.parse(
            input.compiled.descriptor,
          ),
        }
      : {}),
  };
  return CloudCommandInputSchema.parse({
    script:
      'const config=' +
      JSON.stringify(config) +
      ';\n' +
      (maintenance
        ? maintenanceRepositoryHarness()
        : input.compiled
          ? compiledRepositoryHarness(repositoryHarness)
          : repositoryHarness),
    inputs: [
      {
        path: 'repository.json.gz',
        objectId: input.object.id,
        checksum: input.object.checksum,
      },
      ...(input.compiled
        ? [
            {
              path: 'dependencies.json.gz',
              objectId: input.compiled.object.id,
              checksum: input.compiled.object.checksum,
            },
          ]
        : []),
    ],
    outputs: [
      {
        path: 'verification.json',
        fileName: '仓库候选验证.json',
        format: 'json',
      },
    ],
    limits: {
      timeoutMs: 60000,
      outputBytes: 16384,
      artifactBytes: 16384,
      memoryMiB: 512,
      cpuMillis: 1000,
      pids: 64,
    },
  });
}
export function readRepositoryVerification(
  output: string,
  baseline: RepositoryBaseline,
  candidate: RepositoryCandidate,
  expectedMaterial: { digest: string; sourceBytes: number },
  compiled?: CompiledDependencyDescriptor,
  maintenance?: {
    verificationPlan: MaintenanceRepairPlan;
    verificationPlanDigest: string;
  },
) {
  const lines = output
    .split('\n')
    .filter((line) => line.startsWith('ALLRICE_REPOSITORY_VERIFICATION '));
  if (lines.length !== 1) throw Error('REPOSITORY_VERIFICATION_MISSING');
  const proof = RepositoryVerificationSchema.parse(
    JSON.parse(lines[0]!.slice('ALLRICE_REPOSITORY_VERIFICATION '.length)),
  );
  if (
    proof.baselineId !== baseline.id ||
    proof.sourceSha !== baseline.sourceSha ||
    proof.baselineSourceDigest !== baseline.sourceDigest ||
    proof.restoredDigest !== baseline.sourceDigest ||
    proof.rootLockChecksum !== baseline.rootLockChecksum ||
    proof.dependencyConfigurationDigest !==
      baseline.dependencyConfigurationDigest ||
    proof.candidateChecksum !== candidate.checksum ||
    proof.actualMaterialDigest !== proof.candidateMaterialDigest ||
    proof.actualMaterialDigest !== expectedMaterial.digest ||
    proof.sourceBytes !== expectedMaterial.sourceBytes ||
    proof.harnessChecksum !==
      (maintenance
        ? maintenanceVerificationHarnessChecksum
        : repairHarnessChecksumFor(!!compiled)) ||
    proof.version !== (maintenance ? 3 : compiled ? 2 : 1) ||
    (maintenance &&
      (proof.version !== 3 ||
        proof.verificationPlanDigest !== maintenance.verificationPlanDigest ||
        proof.manifestDigest !==
          technicalDigest(maintenance.verificationPlan.approvedFiles))) ||
    proof.sourceFileCount !== baseline.fileCount ||
    proof.assertions.some((a, i) => a.id !== repairAssertionCases[i]!.id) ||
    (proof.exitCode === 0) !==
      (proof.failureKind === null && proof.assertions.every((a) => a.passed)) ||
    (proof.exitCode === 1) !==
      (proof.failureKind === 'assertion_failed' &&
        proof.assertions.some((a) => !a.passed)) ||
    (proof.exitCode === 3) !== (proof.failureKind === 'harness_error')
  )
    throw Error('REPOSITORY_VERIFICATION_CHANGED');
  if (
    compiled &&
    proof.version !== 1 &&
    (proof.nodeVersion !== compiled.nodeVersion ||
      proof.compiled.timeoutMs !== compiled.timeoutMs ||
      proof.compiled.memoryMiB !== compiled.memoryMiB ||
      proof.compiled.compilerHeapMiB !== compiled.compilerHeapMiB ||
      proof.compiled.dependencyBundleChecksum !== compiled.bundleChecksum ||
      proof.compiled.dependencyMaterialDigest !== compiled.materialDigest ||
      proof.compiled.planDigest !== compiled.planDigest ||
      (proof.exitCode !== 3 &&
        proof.compiled.steps.some(
          (s) =>
            s.status !== 'passed' ||
            s.exitCode !== 0 ||
            s.signal !== null ||
            s.outputTruncated,
        )) ||
      proof.compiled.steps.some(
        (s, i) =>
          s.id !==
          ['dependencies', 'build_contracts', 'build_project_runtime'][i],
      ) ||
      proof.compiled.packages.some(
        (p, i) =>
          p.name !== ['@allrice/contracts', '@allrice/project-runtime'][i] ||
          (proof.exitCode !== 3 && p.fileCount === 0),
      ))
  )
    throw Error('REPOSITORY_COMPILED_VERIFICATION_CHANGED');
  return proof;
}
export function repairHarnessChecksumFor(compiled: boolean) {
  return compiled
    ? compiledHarnessChecksum(repositoryHarness)
    : repairHarnessChecksum;
}
