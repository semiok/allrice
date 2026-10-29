/** Ordinary Run identity fixture; frozen references are prepared before INSERT. */
export { createRunAuthorityFixture as createFinalReferenceAuthorityFixture } from '../../../packages/database/src/run-authority.fixture.ts';
import { randomUUID } from 'node:crypto';
import type { createRunAuthorityFixture } from '../../../packages/database/src/run-authority.fixture.ts';
import { createRunDeliveryPort } from '../src/final-delivery/run-delivery.ts';

/** Explicit synthetic Host identity for isolated evidence/commit tests. No model. */
export async function prepareDeliveryAuthorityFixture(
  f: Awaited<ReturnType<typeof createRunAuthorityFixture>>,
  options: { startTurn?: boolean } = {},
) {
  const { db } = f;
  const native = `dsh-${f.session}`;
  await db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
  await db`update allrice_conversation_runtimes set thread_id=${native} where session_id=${f.session}`;
  await db`insert into allrice_native_session_bindings(native_session_id,organization_id,workspace_id,owner_id,context_kind,context_id,
    storage_context_key,storage_namespace,artifact_id,artifact_manifest_digest,distribution_generation,profile_id,first_run_id,first_job_id,first_attempt,binding_basis)
    values(${native},${f.org},${f.workspace},${f.user},'chat',${f.session},${f.session},${'/synthetic/' + f.session},
    ${'sha256:' + 'a'.repeat(64)},${'sha256:' + 'a'.repeat(64)},'fixture','restricted',${randomUUID()},${randomUUID()},7,'approved_compatibility_reader')`;
  const authority = {
    scope: f.task.scope,
    rootRunId: f.rootRunId,
    worker: { ...f.worker, attempt: 1 },
  };
  const port = createRunDeliveryPort(authority);
  async function startTurn(turn = 1) {
    const id = randomUUID(),
      turnId = `${native}:turn:${turn}`;
    await db`update allrice_conversation_runtimes set active_turn_id=${turnId} where session_id=${f.session}`;
    const [event] =
      await db`insert into allrice_run_events(id,run_id,organization_id,workspace_id,sequence,event_type,payload)
      select ${id},${f.rootRunId},${f.org},${f.workspace},coalesce(max(sequence),0)+1,'turn.started',${db.json({ source: 'dsh', threadId: native, turnId, generation: 1 })}
      from allrice_run_events where run_id=${f.rootRunId} returning sequence`;
    return {
      runEventId: id,
      runEventSequence: Number(event!.sequence),
      turnId,
    };
  }
  if (options.startTurn) await startTurn();
  return { native, authority, port, startTurn };
}
