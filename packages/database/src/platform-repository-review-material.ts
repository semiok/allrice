import { technicalDigest } from './platform-technical-tasks.ts';
import {
  RepairFrozenSchema,
  repairFrozenValid,
} from './platform-repair-authority.ts';
import {
  RepairReportSchema,
  RepositoryCandidateSchema,
} from './platform-repair-contracts.ts';
import { freezeRepositoryPublicationSource } from './platform-repository-publication-source.ts';
import {
  RepositoryPublicationMetadataSchema,
  RepositoryPublicationRemoteSchema,
} from './platform-repository-publication-contracts.ts';
import {
  validateRepositoryCiEvidence,
  RepositoryActionReceiptSchema,
  repositoryFactsDigest,
  RepositoryStoredStepsSchema,
} from './platform-repository-publication-ledger.ts';
import { RepositoryReviewMaterialSchema } from './platform-repository-review-contracts.ts';
import {
  repositoryCandidate,
  repositoryDigest,
} from './platform-repository-source.ts';
import { repairTemplateSlot } from './platform-repair-template.ts';

/** A read-only projection of canonical publication, completed inspection and
 * repair records. Browser/model arguments never supply any of this evidence. */
export function freezeRepositoryReviewMaterial(
  publication: {
    id: string;
    owner_id: string;
    organization_id: string;
    workspace_id: string;
    source: unknown;
    source_digest: string;
    metadata: unknown;
    remote: unknown;
    steps: unknown;
    ci: unknown;
    ci_evidence: unknown;
  },
  repairs: Array<{
    id: string;
    run_id: string;
    job_id: string;
    status: string;
    frozen: unknown;
    candidate: unknown;
    report: unknown;
  }>,
  inspection: { status: string; mode: string; receipt: unknown },
) {
  const first = repairs[0];
  if (!first || repairs.length > 16)
    throw Error('repository_review_source_required');
  const frozen = RepairFrozenSchema.parse(first.frozen);
  const source = freezeRepositoryPublicationSource(
    first,
    frozen.baseline.sourceSha,
  );
  if (
    technicalDigest(source) !== publication.source_digest ||
    technicalDigest(source) !== technicalDigest(publication.source)
  )
    throw Error('repository_review_source_mismatch');
  const metadata = RepositoryPublicationMetadataSchema.parse(
    publication.metadata,
  );
  const remote = RepositoryPublicationRemoteSchema.parse(publication.remote);
  const steps = RepositoryStoredStepsSchema.parse(publication.steps);
  if (
    ['blob', 'tree', 'commit', 'branch', 'pull'].some(
      (step) => steps[step as keyof typeof steps]?.state !== 'confirmed',
    ) ||
    remote.headSha !== metadata.commit ||
    remote.tree !== metadata.tree ||
    remote.baseSha !== source.baseSha ||
    remote.branch !== `allrice/repairs/${publication.id}`
  )
    throw Error('repository_review_publication_required');
  const { ci, evidence } = validateRepositoryCiEvidence(
    publication.ci,
    publication.ci_evidence,
    source,
    metadata,
    remote,
  );
  const receipt = RepositoryActionReceiptSchema.parse(inspection.receipt);
  if (
    inspection.status !== 'succeeded' ||
    inspection.mode !== 'inspect' ||
    receipt.action !== 'inspect' ||
    receipt.publicationId !== publication.id ||
    receipt.sourceDigest !== publication.source_digest ||
    receipt.factsDigest !== repositoryFactsDigest(publication) ||
    ci.state !== 'passed'
  )
    throw Error('repository_review_current_ci_required');
  const authorRunIds = repositoryReviewAuthorRunIds(repairs, source);
  const report = RepairReportSchema.parse(first.report);
  const evidenceDigest = technicalDigest({
    sourceReportDigest: source.reportDigest,
    evidence: [...evidence].sort((a, b) =>
      a.receipt.job.localeCompare(b.receipt.job, 'en'),
    ),
  });
  // Observed time, action/revision counters and request/reviewer identity are
  // audit fields. A refresh of unchanged evidence must not erase a review.
  const stableCi = { ...ci, observedAt: null };
  stableCi.checks = [...stableCi.checks].sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  );
  stableCi.receipts = [...stableCi.receipts].sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  );
  const candidateContentDigest = technicalDigest({
    repositoryId: remote.repositoryId,
    baseTree: source.baseTree,
    baselineSourceDigest: source.baselineSourceDigest,
    candidateMaterialDigest: source.candidateMaterialDigest,
    path: source.path,
    mode: source.mode,
    beforeChecksum: source.beforeChecksum,
    afterChecksum: source.afterChecksum,
  });
  const subjectDigest = technicalDigest({
    version: 1,
    source,
    metadata,
    remote,
    ci: stableCi,
    evidenceDigest,
    authorRunIds,
  });
  return RepositoryReviewMaterialSchema.parse({
    version: 1,
    publicationId: publication.id,
    ownerId: publication.owner_id,
    organizationId: publication.organization_id,
    workspaceId: publication.workspace_id,
    source,
    metadata,
    remote,
    ci,
    report,
    beforeText: frozen.baselineText,
    authorRunIds,
    subjectDigest,
    evidenceDigest,
    candidateContentDigest,
  });
}

/** Validate persisted source authors independently of current remote CI. A
 * completed review is retained after the pull request closes. */
export function repositoryReviewAuthorRunIds(
  repairs: Parameters<typeof freezeRepositoryReviewMaterial>[1],
  source: ReturnType<typeof freezeRepositoryPublicationSource>,
) {
  // Reverification may adopt an earlier accepted patch. Trace every canonical
  // source author, not merely the newest revalidation Run or a role label.
  for (let i = 0; i < repairs.length; i++) {
    const current = repairs[i]!;
    if (!repairFrozenValid(current.frozen) || current.status !== 'succeeded')
      throw Error('repository_review_author_chain_invalid');
    const f = RepairFrozenSchema.parse(current.frozen);
    const parent = repairs[i + 1];
    if (!f.reuseSeed) {
      if (parent) throw Error('repository_review_author_chain_invalid');
      continue;
    }
    // An author may predate compiled_packages. Its actual accepted report and
    // exact adopted bytes remain provenance, without being promoted to full CI.
    if (
      !parent ||
      !repairFrozenValid(parent.frozen) ||
      parent.status !== 'succeeded'
    )
      throw Error('repository_review_author_chain_invalid');
    const pf = RepairFrozenSchema.parse(parent.frozen),
      pc = RepositoryCandidateSchema.parse(parent.candidate),
      pr = RepairReportSchema.parse(parent.report),
      patch = pc.files[0];
    if (
      !patch ||
      pc.revision < 1 ||
      repositoryCandidate(pc.revision, pc.files).checksum !== pc.checksum ||
      pr.candidateChecksum !== pc.checksum ||
      pr.after.revision !== pc.revision ||
      pr.after.report.candidateChecksum !== pc.checksum ||
      !pr.after.report.assertions.every((a) => a.passed) ||
      patch.beforeChecksum !== repositoryDigest(pf.baselineText) ||
      pf.baseline.rootLockChecksum !== f.baseline.rootLockChecksum ||
      pf.baseline.dependencyConfigurationDigest !==
        f.baseline.dependencyConfigurationDigest
    )
      throw Error('repository_review_author_chain_invalid');
    const after = Buffer.from(patch.afterBase64, 'base64');
    if (after.toString('base64') !== patch.afterBase64)
      throw Error('repository_review_author_chain_invalid');
    repairTemplateSlot(
      pf.baselineText,
      new TextDecoder('utf8', { fatal: true }).decode(after),
    );
    if (
      parent.id !== f.reuseAcceptedTaskId ||
      parent.id !== f.reuseSeed.sourceTaskId ||
      pc.checksum !== f.reuseSeed.sourceCandidateChecksum ||
      technicalDigest(pr) !== f.reuseSeed.sourceReportDigest ||
      patch.beforeChecksum !== f.reuseSeed.beforeChecksum ||
      repositoryDigest(after) !== f.reuseSeed.afterChecksum ||
      patch.afterBase64 !== f.reuseSeed.afterBase64 ||
      patch.afterBase64 !== source.afterBase64 ||
      patch.beforeChecksum !== source.beforeChecksum
    )
      throw Error('repository_review_author_chain_invalid');
  }
  const authorRunIds = [...new Set(repairs.map((r) => r.run_id))].sort();
  if (authorRunIds.length !== repairs.length)
    throw Error('repository_review_author_chain_invalid');
  return authorRunIds;
}
