import { RepositoryPublicationSourceSchema } from './platform-repository-publication-contracts.ts';
import {
  RepairFrozenSchema,
  repairFrozenValid,
} from './platform-repair-authority.ts';
import {
  RepairReportSchema,
  RepositoryCandidateSchema,
  repairProductPath,
} from './platform-repair-contracts.ts';
import {
  repositoryCandidate,
  repositoryDigest,
} from './platform-repository-source.ts';
import { repairTemplateSlot } from './platform-repair-template.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import { gitBlobId } from './platform-repository-git.ts';

/** The canonical completed task is read under owner isolation before this function. */
export function freezeRepositoryPublicationSource(
  row: {
    id: string;
    run_id: string;
    job_id: string;
    status: string;
    frozen: unknown;
    candidate: unknown;
    report: unknown;
  },
  currentReleaseSha: string,
) {
  if (row.status !== 'succeeded' || !repairFrozenValid(row.frozen))
    throw Error('REPOSITORY_SOURCE_NOT_ACCEPTED');
  const frozen = RepairFrozenSchema.parse(row.frozen);
  const candidate = RepositoryCandidateSchema.parse(row.candidate);
  const report = RepairReportSchema.parse(row.report);
  const patch = candidate.files[0];
  if (
    frozen.verificationMode !== 'compiled_packages' ||
    frozen.releaseSha !== currentReleaseSha ||
    frozen.baseline.sourceSha !== currentReleaseSha ||
    !patch ||
    candidate.revision < 1 ||
    report.after.revision !== candidate.revision ||
    repositoryCandidate(candidate.revision, candidate.files).checksum !==
      candidate.checksum ||
    patch.beforeChecksum !== repositoryDigest(frozen.baselineText) ||
    report.candidateChecksum !== candidate.checksum ||
    report.after.report.version !== (frozen.version === 2 ? 3 : 2) ||
    report.before.report.version !== (frozen.version === 2 ? 3 : 2) ||
    report.after.report.candidateChecksum !== candidate.checksum ||
    report.after.report.actualMaterialDigest !==
      report.after.report.candidateMaterialDigest ||
    !report.after.report.assertions.every((a) => a.passed) ||
    [report.before.report, report.after.report].some(
      (r) =>
        r.baselineId !== frozen.baseline.id ||
        r.sourceSha !== frozen.baseline.sourceSha ||
        r.baselineSourceDigest !== frozen.baseline.sourceDigest ||
        r.restoredDigest !== frozen.baseline.sourceDigest ||
        r.harnessChecksum !== frozen.harnessChecksum ||
        r.sourceFileCount !== frozen.baseline.fileCount ||
        r.sourceBytes !==
          frozen.baseline.sourceBytes +
            (frozen.version === 2 && r.candidateChecksum === candidate.checksum
              ? Buffer.from(patch.afterBase64, 'base64').length -
                Buffer.byteLength(frozen.baselineText)
              : 0) ||
        (frozen.version === 2 &&
          (r.version !== 3 ||
            r.verificationPlanDigest !==
              frozen.maintenance.verificationPlanDigest ||
            r.manifestDigest !==
              technicalDigest(
                frozen.maintenance.verificationPlan.approvedFiles,
              ))) ||
        r.compiled.dependencyBundleChecksum !==
          frozen.baseline.compiledDependencies?.bundleChecksum ||
        r.compiled.dependencyMaterialDigest !==
          frozen.baseline.compiledDependencies?.materialDigest ||
        r.compiled.planDigest !==
          frozen.baseline.compiledDependencies?.planDigest ||
        r.rootLockChecksum !== frozen.baseline.rootLockChecksum ||
        r.dependencyConfigurationDigest !==
          frozen.baseline.dependencyConfigurationDigest,
    )
  )
    throw Error('REPOSITORY_SOURCE_NOT_ACCEPTED');
  const after = Buffer.from(patch.afterBase64, 'base64');
  if (after.toString('base64') !== patch.afterBase64 || after.length > 50_000)
    throw Error('REPOSITORY_SOURCE_NOT_ACCEPTED');
  const text = new TextDecoder('utf8', { fatal: true }).decode(after);
  if (frozen.version === 1) repairTemplateSlot(frozen.baselineText, text);
  else {
    const a = frozen.maintenance.verificationPlan.approvedFiles;
    if (
      a.length !== 1 ||
      a[0]?.path !== patch.path ||
      a[0].mode !== '100644' ||
      a[0].beforeChecksum !== patch.beforeChecksum ||
      after.length > a[0].maxBytes ||
      after.includes(0) ||
      !text
    )
      throw Error('REPOSITORY_SOURCE_NOT_ACCEPTED');
  }
  return RepositoryPublicationSourceSchema.parse({
    version: frozen.version === 2 ? 2 : 1,
    ...(frozen.version === 2
      ? {
          maintenance: {
            grantId: frozen.maintenance.grantId,
            grantDigest: frozen.maintenance.grantDigest,
            attemptId: frozen.maintenance.attemptId,
            verificationPlanDigest: frozen.maintenance.verificationPlanDigest,
            manifestDigest: technicalDigest(
              frozen.maintenance.verificationPlan.approvedFiles,
            ),
          },
        }
      : {}),
    repairTaskId: row.id,
    repairRunId: row.run_id,
    repairJobId: row.job_id,
    baseSha: frozen.baseline.sourceSha,
    baseTree: frozen.baseline.gitTree,
    baselineSourceDigest: frozen.baseline.sourceDigest,
    candidateChecksum: candidate.checksum,
    candidateMaterialDigest: report.after.report.actualMaterialDigest,
    reportDigest: technicalDigest(report),
    rootLockChecksum: frozen.baseline.rootLockChecksum,
    dependencyConfigurationDigest:
      frozen.baseline.dependencyConfigurationDigest,
    beforeChecksum: patch.beforeChecksum,
    afterChecksum: repositoryDigest(after),
    beforeBlob: gitBlobId(Buffer.from(frozen.baselineText)),
    afterBlob: gitBlobId(after),
    afterBase64: patch.afterBase64,
    path: repairProductPath,
    mode: '100644',
  });
}
