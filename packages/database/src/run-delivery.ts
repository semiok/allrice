import type { TransactionSql } from 'postgres';
import { getDatabase } from './core/client.ts';
import { readWorkerFinalDeliveryEvidenceTransaction } from './artifact-review.ts';
import { readFinalDeliveryReferences } from './final-delivery-references.ts';
import {
  assertRunDeliveryAuthority,
  type RunDeliveryAuthority,
} from './run-delivery-authority.ts';
import { continuingProjectServiceIds } from './project-services.ts';
import {
  captureFinalDeliveryProof,
  checkedResultAnswer,
  finalDeliveryFactsDigest,
  finalDeliveryTextDigest,
  finalDeliveryUnavailable,
  registerJobCompletionGuard,
  type FinalDeliveryCommitProof,
  type JobCompletionGuard,
} from './final-delivery-commit.ts';
export type { RunDeliveryAuthority } from './run-delivery-authority.ts';
export type { JobCompletionGuard } from './final-delivery-commit.ts';

async function readSnapshot(
  tx: TransactionSql,
  authority: RunDeliveryAuthority,
) {
  return readWorkerFinalDeliveryEvidenceTransaction(tx, async () => {
    const { task } = await assertRunDeliveryAuthority(tx, authority);
    return {
      task,
      ownership: 'root_run' as const,
      explicitReferences: await readFinalDeliveryReferences({
        transaction: tx,
        task,
      }),
    };
  });
}

/** Worker-only independent evidence port. No rollout or native wait is implied. */
export async function readDeliverySnapshot(authority: RunDeliveryAuthority) {
  const captured = structuredClone(authority);
  return getDatabase().begin('isolation level read committed', (tx) =>
    readSnapshot(tx, captured),
  );
}

/** Called only after the trusted native candidate has passed Worker validation.
 * completeJob rechecks evidence and the actual stored reply in its transaction. */
export function createDeliveryCommitGuard(input: {
  authority: RunDeliveryAuthority;
  proof: FinalDeliveryCommitProof;
}): JobCompletionGuard {
  const authority = structuredClone(input.authority);
  const proof = captureFinalDeliveryProof(input.proof);
  return registerJobCompletionGuard(async (tx, job, result) => {
    const { worker, rootRunId } = authority;
    if (
      job.id !== worker.jobId ||
      job.run_id !== rootRunId ||
      job.worker_id !== worker.workerId ||
      job.lease_token !== worker.leaseToken ||
      job.attempt !== worker.attempt ||
      job.attempt !== proof.attempt ||
      worker.generation !== proof.generation ||
      job.status !== 'running' ||
      job.cancel_requested_at ||
      job.drain_reason
    )
      finalDeliveryUnavailable();
    const answer = checkedResultAnswer(result);
    if (finalDeliveryTextDigest(answer) !== proof.candidateDigest)
      finalDeliveryUnavailable();
    const current = await assertRunDeliveryAuthority(tx, authority);
    if (current.nativeSessionId !== proof.nativeSessionId)
      finalDeliveryUnavailable();
    const facts = await readSnapshot(tx, authority);
    if (finalDeliveryFactsDigest(facts) !== proof.factSetDigest)
      finalDeliveryUnavailable();
    const services = await continuingProjectServiceIds(tx, rootRunId);
    const [pending] =
      await tx`select id from allrice_runtime_operations where root_run_id=${rootRunId}
      and not (id=any(${services}::uuid[])) and snapshot->>'status' not in ('succeeded','failed','partial','canceled') limit 1`;
    if (pending) finalDeliveryUnavailable();
    const deadlines = [
      ...current.deadlines,
      ...facts.artifacts.flatMap((a) =>
        a.retentionUntil ? [new Date(a.retentionUntil)] : [],
      ),
    ];
    return {
      assertCommitted: async () => {
        const [stored] = await tx<
          {
            answer: string;
            text: string;
            job_status: string;
            run_state: string;
            now: Date;
          }[]
        >`
          select r.result->>'answer' answer,m.content->>'text' text,j.status job_status,r.state run_state,clock_timestamp() now
          from allrice_jobs j join allrice_runs r on r.id=j.run_id
          join allrice_employee_runs e on e.run_id=r.id and e.assistant_message_id=${current.assistantMessageId}
          join allrice_messages m on m.id=e.assistant_message_id and m.session_id=e.session_id and m.owner_id=e.owner_id
          where j.id=${job.id} and r.id=${rootRunId}`;
        if (
          !stored ||
          stored.job_status !== 'succeeded' ||
          stored.run_state !== 'succeeded' ||
          stored.answer !== answer ||
          stored.text !== answer ||
          checkedResultAnswer(result) !== answer ||
          deadlines.some(
            (d) => !Number.isFinite(d.getTime()) || d <= stored.now,
          )
        )
          finalDeliveryUnavailable();
      },
    };
  });
}
