import { z } from 'zod';
import { UuidSchema } from '@allrice/contracts';
import { ChecksumSchema } from '@allrice/contracts';
import { RepositoryCiReceiptSchema } from './platform-repository-ci-contracts.ts';
import { QueueError } from './execution/queue.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import { repositoryCommitIdentity } from './platform-repository-git.ts';
import {
  withRepositoryAction,
  type RepositoryActionLease,
} from './platform-repository-publication-authority.ts';
import {
  RepositoryGitShaSchema,
  RepositoryPublicationRemoteSchema,
  RepositoryPublicationCiSchema,
  RepositoryPublicationSteps,
  RepositoryPublicationStepSchema,
  type RepositoryPublicationStep,
} from './platform-repository-publication-contracts.ts';

export const RepositoryPublicationMetadataSchema = z
  .object({
    tree: RepositoryGitShaSchema,
    commit: RepositoryGitShaSchema,
    workflowBlob: RepositoryGitShaSchema,
    author: z
      .object({
        login: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
        userId: z.number().int().positive(),
        timestamp: z.string(),
        message: z.string().max(200),
      })
      .strict(),
  })
  .strict();
export const RepositoryStoredStepSchema = z
  .object({
    state: z.enum(['started', 'confirmed']),
    intentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    startedActionId: UuidSchema,
    startedAttempt: z.number().int().positive(),
  })
  .strict();
export const RepositoryStoredStepsSchema = z.partialRecord(
  RepositoryPublicationStepSchema,
  RepositoryStoredStepSchema,
);
export const RepositoryActionReceiptSchema = z
  .object({
    version: z.literal(1),
    publicationId: UuidSchema,
    inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    jobAttempt: z.number().int().positive(),
    action: z.enum(['publish', 'inspect']),
    factsDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export function repositoryFactsDigest(row: Record<string, unknown>) {
  return technicalDigest({
    metadata: row.metadata,
    steps: row.steps,
    remote: row.remote,
    ci: row.ci,
    ciEvidence: row.ci_evidence ?? null,
  });
}
export async function readRepositoryAction(lease: RepositoryActionLease) {
  return withRepositoryAction(lease, async (_tx, d) => ({
    id: d.row.publication_id as string,
    mode: d.request.action,
    source: d.source,
    createdAt: (d.row.publication_created_at as Date).toISOString(),
    metadata: d.row.metadata
      ? RepositoryPublicationMetadataSchema.parse(d.row.metadata)
      : null,
    steps: RepositoryStoredStepsSchema.parse(d.row.steps),
    remote: d.row.remote
      ? RepositoryPublicationRemoteSchema.parse(d.row.remote)
      : null,
  }));
}
export async function freezeRepositoryPublicationMetadata(
  lease: RepositoryActionLease,
  raw: unknown,
) {
  const metadata = RepositoryPublicationMetadataSchema.parse(raw);
  return withRepositoryAction(lease, async (tx, d) => {
    if (d.row.metadata) {
      if (technicalDigest(d.row.metadata) !== technicalDigest(metadata))
        throw new QueueError('conflict');
      return RepositoryPublicationMetadataSchema.parse(d.row.metadata);
    }
    if (
      d.request.action !== 'publish' ||
      Object.keys(d.row.steps).length ||
      repositoryCommitIdentity(metadata.tree, d.source.baseSha, metadata.author)
        .sha !== metadata.commit
    )
      throw new QueueError('conflict');
    await tx`update allrice_platform_repository_publications set metadata=${tx.json(metadata)},revision=revision+1,updated_at=clock_timestamp() where id=${d.row.publication_id}`;
    return metadata;
  });
}
/** Returns true only for the first durable START. An earlier unknown write is never replayed. */
export async function startRepositoryPublicationStep(
  lease: RepositoryActionLease,
  step: RepositoryPublicationStep,
) {
  RepositoryPublicationStepSchema.parse(step);
  return withRepositoryAction(lease, async (tx, d, job) => {
    const metadata = RepositoryPublicationMetadataSchema.parse(d.row.metadata),
      steps = RepositoryStoredStepsSchema.parse(d.row.steps);
    const digest = technicalDigest({
      step,
      sourceDigest: d.row.source_digest,
      metadata,
    });
    const old = steps[step];
    if (old) {
      if (old.intentDigest !== digest) throw new QueueError('conflict');
      return false;
    }
    if (
      d.request.action !== 'publish' ||
      RepositoryPublicationSteps.slice(
        0,
        RepositoryPublicationSteps.indexOf(step),
      ).some((s) => steps[s]?.state !== 'confirmed')
    )
      throw new QueueError('conflict');
    steps[step] = {
      state: 'started',
      intentDigest: digest,
      startedActionId: d.row.id,
      startedAttempt: job.attempt,
    };
    await tx`update allrice_platform_repository_publications set steps=${tx.json(steps)},revision=revision+1,updated_at=clock_timestamp() where id=${d.row.publication_id}`;
    return true;
  });
}
export async function confirmRepositoryPublicationStep(
  lease: RepositoryActionLease,
  step: RepositoryPublicationStep,
  identity: unknown,
) {
  RepositoryPublicationStepSchema.parse(step);
  return withRepositoryAction(lease, async (tx, d) => {
    const metadata = RepositoryPublicationMetadataSchema.parse(d.row.metadata),
      steps = RepositoryStoredStepsSchema.parse(d.row.steps);
    const old = steps[step],
      expected = technicalDigest({
        step,
        sourceDigest: d.row.source_digest,
        metadata,
      });
    if (!old || old.intentDigest !== expected) throw new QueueError('conflict');
    let remote = d.row.remote;
    if (step === 'pull') {
      remote = RepositoryPublicationRemoteSchema.parse(identity);
      if (
        remote.branch !== `allrice/repairs/${d.row.publication_id}` ||
        remote.headSha !== metadata.commit ||
        remote.tree !== metadata.tree ||
        remote.baseSha !== d.source.baseSha ||
        (d.row.remote &&
          technicalDigest(d.row.remote) !== technicalDigest(remote))
      )
        throw new QueueError('conflict');
    } else {
      const sha = RepositoryGitShaSchema.parse(identity);
      if (
        sha !==
        (step === 'blob'
          ? d.source.afterBlob
          : step === 'tree'
            ? metadata.tree
            : metadata.commit)
      )
        throw new QueueError('conflict');
    }
    steps[step] = { ...old, state: 'confirmed' };
    await tx`update allrice_platform_repository_publications set steps=${tx.json(steps)},remote=${remote ? tx.json(remote) : null},revision=revision+1,updated_at=clock_timestamp() where id=${d.row.publication_id}`;
  });
}
export async function recordRepositoryCiObservation(
  lease: RepositoryActionLease,
  raw: unknown,
  rawEvidence: unknown = [],
) {
  const ci = RepositoryPublicationCiSchema.parse(raw);
  const evidence = z
    .array(
      z
        .object({
          artifactId: z.number().int().positive(),
          archiveDigest: ChecksumSchema,
          receipt: RepositoryCiReceiptSchema,
        })
        .strict(),
    )
    .max(4)
    .parse(rawEvidence);
  if (
    new Set(evidence.map((e) => e.artifactId)).size !== evidence.length ||
    new Set(evidence.map((e) => e.receipt.job)).size !== evidence.length
  )
    throw new QueueError('conflict');
  return withRepositoryAction(lease, async (tx, d, job) => {
    const metadata = d.row.metadata
        ? RepositoryPublicationMetadataSchema.parse(d.row.metadata)
        : null,
      remote = d.row.remote
        ? RepositoryPublicationRemoteSchema.parse(d.row.remote)
        : null;
    if (
      ci.headSha !== (metadata?.commit ?? null) ||
      !ci.observedAt ||
      (remote && remote.headSha !== ci.headSha) ||
      (ci.state === 'passed' &&
        (!remote ||
          !metadata ||
          ci.checkoutTree !== metadata.tree ||
          ci.materialDigest !== d.source.candidateMaterialDigest))
    )
      throw new QueueError('conflict');
    if (ci.state === 'passed') {
      if (evidence.length !== 4) throw new QueueError('conflict');
      for (const e of evidence) {
        const r = e.receipt,
          publicReceipt = ci.receipts.find((p) => p.name === r.job);
        if (
          !publicReceipt ||
          publicReceipt.artifactId !== e.artifactId ||
          publicReceipt.archiveDigest !== e.archiveDigest ||
          publicReceipt.receiptDigest !== technicalDigest(r) ||
          r.workflowRunId !== ci.workflowRunId ||
          r.runAttempt !== ci.runAttempt ||
          r.headSha !== metadata!.commit ||
          r.baseSha !== d.source.baseSha ||
          r.pullRequest !== remote!.number ||
          r.event !== 'pull_request' ||
          r.workflowBlob !== metadata!.workflowBlob ||
          r.checkoutSha !== ci.checkoutSha ||
          r.checkoutTree !== metadata!.tree ||
          r.materialDigest !== d.source.candidateMaterialDigest ||
          r.rootLockChecksum !== d.source.rootLockChecksum ||
          r.dependencyConfigurationDigest !==
            d.source.dependencyConfigurationDigest
        )
          throw new QueueError('conflict');
      }
    } else if (evidence.length || ci.receipts.length)
      throw new QueueError('conflict');
    await tx`update allrice_platform_repository_publications set ci=${tx.json(ci)},ci_evidence=${evidence.length ? tx.json(evidence) : null},revision=revision+1,updated_at=clock_timestamp() where id=${d.row.publication_id}`;
    const observation = {
      inputDigest: d.row.input_digest,
      jobAttempt: job.attempt,
      factsDigest: repositoryFactsDigest({
        ...d.row,
        ci,
        ci_evidence: evidence.length ? evidence : null,
      }),
    };
    await tx`update allrice_platform_repository_actions set observation=${tx.json(observation)} where id=${d.row.id}`;
  });
}
export async function finishRepositoryAction(lease: RepositoryActionLease) {
  return withRepositoryAction(lease, async (tx, d, job) => {
    const metadata = d.row.metadata
        ? RepositoryPublicationMetadataSchema.parse(d.row.metadata)
        : null,
      steps = RepositoryStoredStepsSchema.parse(d.row.steps);
    if (
      d.request.action === 'publish' &&
      (RepositoryPublicationSteps.some(
        (s) => steps[s]?.state !== 'confirmed',
      ) ||
        !d.row.remote)
    )
      throw new QueueError('conflict');
    if (d.row.remote) {
      const remote = RepositoryPublicationRemoteSchema.parse(d.row.remote);
      if (
        !metadata ||
        remote.headSha !== metadata.commit ||
        remote.tree !== metadata.tree ||
        remote.baseSha !== d.source.baseSha ||
        remote.branch !== `allrice/repairs/${d.row.publication_id}`
      )
        throw new QueueError('conflict');
    }
    if (
      d.request.action === 'inspect' &&
      (!d.row.observation ||
        d.row.observation.inputDigest !== d.row.input_digest ||
        d.row.observation.jobAttempt !== job.attempt ||
        d.row.observation.factsDigest !== repositoryFactsDigest(d.row))
    )
      throw new QueueError('conflict');
    const receipt = RepositoryActionReceiptSchema.parse({
      version: 1,
      publicationId: d.row.publication_id,
      inputDigest: d.row.input_digest,
      sourceDigest: d.row.source_digest,
      jobAttempt: job.attempt,
      action: d.request.action,
      factsDigest: repositoryFactsDigest(d.row),
    });
    await tx`update allrice_platform_repository_actions set receipt=${tx.json(receipt)} where id=${d.row.id}`;
    return {
      publicationId: d.row.publication_id as string,
      action: d.request.action,
    };
  });
}
