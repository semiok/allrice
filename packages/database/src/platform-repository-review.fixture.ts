/** Synthetic canonical records for deterministic tests; not physical/model CI evidence. */
import { randomUUID } from 'node:crypto';
import { acceptedRepositoryFixture } from './platform-repository-publication.fixture.ts';
import { freezeRepositoryPublicationSource } from './platform-repository-publication-source.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import {
  repositoryRequiredChecks,
  RepositoryPublicationSteps,
} from './platform-repository-publication-contracts.ts';
import { RepositoryCiReceiptSchema } from './platform-repository-ci-contracts.ts';
import { repositoryFactsDigest } from './platform-repository-publication-ledger.ts';

export function repositoryReviewFixture(
  loginId: string = randomUUID(),
  authenticatedAt = new Date().toISOString(),
) {
  const accepted = acceptedRepositoryFixture(loginId, authenticatedAt);
  const repair = {
    id: randomUUID() as string,
    run_id: randomUUID() as string,
    job_id: randomUUID() as string,
    status: 'succeeded',
    frozen: accepted.frozen,
    candidate: accepted.candidate,
    report: accepted.report,
  };
  const source = freezeRepositoryPublicationSource(
    repair,
    accepted.frozen.baseline.sourceSha,
  );
  const id = randomUUID(),
    head = 'c'.repeat(40),
    tree = 'd'.repeat(40),
    workflowBlob = 'e'.repeat(40),
    checksum = technicalDigest('synthetic-ci');
  const metadata = {
    tree,
    commit: head,
    workflowBlob,
    author: {
      login: 'fixture',
      userId: 1,
      timestamp: new Date().toISOString(),
      message: 'fix',
    },
  };
  const remote = {
    repositoryId: 1323769790 as const,
    repository: 'semiok/allrice' as const,
    branch: `allrice/repairs/${id}`,
    number: 312,
    url: 'https://github.com/semiok/allrice/pull/312',
    headSha: head,
    tree,
    baseSha: source.baseSha,
  };
  const evidence = repositoryRequiredChecks.map((job, i) => ({
    artifactId: 300 + i,
    archiveDigest: checksum,
    receipt: RepositoryCiReceiptSchema.parse({
      version: 1,
      scope: 'allrice.repository-ci.v1',
      repositoryId: remote.repositoryId,
      repository: remote.repository,
      workflowPath: '.github/workflows/ci.yml',
      workflowBlob,
      workflowRunId: 100,
      runAttempt: 1,
      job,
      event: 'pull_request',
      pullRequest: remote.number,
      headSha: head,
      baseSha: source.baseSha,
      checkoutSha: 'f'.repeat(40),
      checkoutTree: tree,
      materialDigest: source.candidateMaterialDigest,
      rootLockChecksum: source.rootLockChecksum,
      dependencyConfigurationDigest: source.dependencyConfigurationDigest,
      nodeVersion: 'v22.23.2',
      runnerOs: 'Linux',
      runnerArch: 'X64',
      build:
        job === 'validate'
          ? {
              rootScript: 'pnpm -r --if-present run build',
              packages: [
                {
                  name: '@allrice/worker',
                  path: 'apps/worker',
                  scriptChecksum: checksum,
                  outputDigest: checksum,
                  fileCount: 1,
                  sizeBytes: 1,
                },
              ],
            }
          : null,
    }),
  }));
  const ci = {
    state: 'passed' as const,
    observedAt: new Date().toISOString(),
    workflowRunId: 100,
    runAttempt: 1,
    headSha: head,
    checkoutSha: 'f'.repeat(40),
    checkoutTree: tree,
    materialDigest: source.candidateMaterialDigest,
    checks: repositoryRequiredChecks.map((name, i) => ({
      name,
      id: 200 + i,
      conclusion: 'success' as const,
    })),
    receipts: evidence.map((e) => ({
      name: e.receipt.job,
      artifactId: e.artifactId,
      archiveDigest: e.archiveDigest,
      receiptDigest: technicalDigest(e.receipt),
    })),
  };
  const publication = {
    id,
    owner_id: randomUUID() as string,
    organization_id: randomUUID() as string,
    workspace_id: randomUUID() as string,
    source,
    source_digest: technicalDigest(source),
    metadata,
    remote,
    ci,
    ci_evidence: evidence,
    steps: Object.fromEntries(
      RepositoryPublicationSteps.map((step) => [
        step,
        {
          state: 'confirmed',
          intentDigest: checksum,
          startedActionId: randomUUID(),
          startedAttempt: 1,
        },
      ]),
    ),
  };
  const inspection = {
    mode: 'inspect',
    status: 'succeeded',
    receipt: {
      version: 1,
      publicationId: id,
      inputDigest: checksum,
      sourceDigest: publication.source_digest,
      jobAttempt: 1,
      action: 'inspect',
      factsDigest: repositoryFactsDigest(publication),
    },
  };
  return { accepted, repair, publication, inspection };
}
