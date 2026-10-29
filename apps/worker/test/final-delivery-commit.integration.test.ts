/** Real isolated PG only. Native receipt identities are explicit synthetic
 * trusted-host fixtures; no SDK/model/provider or production account is run. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeLedgerTransaction } from '../../../packages/database/src/runtime-ledger/types.ts';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { ExecutionContextSchema } from '@allrice/contracts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from '../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../../../packages/database/src/assistant-authority.fixture.ts';
import { assertAssistantAuthority } from '../../../packages/database/src/assistant-authority.ts';
import { closeDatabase } from '../../../packages/database/src/core/client.ts';
import {
  createAssistantRuntime,
  cancelAssistantRootTransaction,
} from '../../../packages/database/src/assistant-runtime.ts';
import {
  completeJob,
  appendJobEvent,
} from '../../../packages/database/src/execution/queue.ts';
import { recordConversationTurn } from '../../../packages/database/src/conversation/conversation-runtime.ts';
import {
  finalDeliveryFactsDigest,
  finalDeliveryTextDigest,
  type AssistantFinalDeliveryProof,
  type JobCompletionGuard,
} from '../../../packages/database/src/final-delivery-commit.ts';
import { publishWorkbenchArtifact } from '../../../packages/database/src/artifact-review.ts';
const out = process.env.MET184_DB_COMMIT_EVIDENCE;
const originalEnvironment = Object.fromEntries(
  [
    'DATABASE_URL',
    'ALLRICE_ASSISTANTS_ENABLED',
    'ALLRICE_WORKBENCH_ENABLED',
  ].map((key) => [key, process.env[key]]),
);
const save = (name: string, data: unknown) => {
  if (out)
    writeFileSync(
      join(out, name + '.json'),
      JSON.stringify(data, null, 2) + '\n',
    );
};
const facts: { name: string; detail: unknown }[] = [];
const record = (name: string, detail: unknown) => {
  facts.push({ name, detail });
  save('case-facts', facts);
};
let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
const db = () => database.db;
const storage = () => assistantFixtureStorage(db());
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => (resolve = yes));
  return { promise, resolve };
};
async function waitFor(check: () => Promise<boolean>, name: string) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Barrier not observed: ' + name);
}
async function fixture(
  pin: {
    organizationId?: string;
    workspaceId?: string;
    ownerId?: string;
    contextId?: string;
    profileId?: 'restricted' | 'technical';
  } = {},
) {
  const f = await createAssistantAuthorityFixture(db(), {
    memberRole: 'member',
    snapshot: (value) => ({
      ...value,
      finalDeliveryPolicy: {
        version: 1,
        mode: 'checked_native_v1',
        artifactId: 'sha256:' + 'a'.repeat(64),
      },
    }),
    allowedTools: [
      'assistant.delegate',
      'assistant.report',
      'workspace.export.create',
      'workspace.document.read',
    ],
  });
  const native = 'dsh-' + f.session;
  await db()`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
  await db()`update allrice_assistant_instances set native_session_id=${native} where run_id=${f.rootRunId}`;
  await db()`update allrice_conversation_runtimes set thread_id=${native} where session_id=${f.session}`;
  const pinScope = {
    organizationId: f.org,
    workspaceId: f.workspace,
    ownerId: f.user,
    contextId: f.session,
    profileId: 'restricted',
    ...pin,
  };
  // Existing historical pin deliberately belongs to earlier Run/Job IDs.
  await db()`insert into allrice_native_session_bindings(native_session_id,organization_id,workspace_id,owner_id,context_kind,context_id,
  storage_context_key,storage_namespace,artifact_id,artifact_manifest_digest,distribution_generation,profile_id,
  first_run_id,first_job_id,first_attempt,binding_basis)
  values(${native},${pinScope.organizationId},${pinScope.workspaceId},${pinScope.ownerId},'chat',${pinScope.contextId},${f.session},${'/synthetic/' + f.org + '/' + f.workspace + '/' + f.user + '/' + f.session + '/sessions'},
  ${'sha256:' + 'a'.repeat(64)},${'sha256:' + 'a'.repeat(64)},'fixture-approved-reader',${pinScope.profileId},${randomUUID()},${randomUUID()},7,'approved_compatibility_reader')`;
  const runtime = createAssistantRuntime({
    database: db(),
    authorize: assertAssistantAuthority,
    checkedDelivery: true,
    readFinalDeliveryReferences: async ({ transaction, task }) => {
      const rows = await transaction<
        { object_id: string; version_id: string; checksum: string }[]
      >`select object_id,version_id,checksum from met184_frozen_refs where root_run_id=${task.rootRunId} order by version_id for share`;
      return rows.map((r) => ({
        objectId: r.object_id,
        versionId: r.version_id,
        checksum: r.checksum,
      }));
    },
  });
  const input = {
    scope: f.task.scope,
    rootRunId: f.rootRunId,
    worker: f.worker,
  };
  const [policy] =
    await db()`select payload,issued_at,expires_at from allrice_policy_snapshots where id=${f.policy}`;
  assert.ok(policy);
  const context = ExecutionContextSchema.parse({
    executionId: randomUUID(),
    runId: f.rootRunId,
    jobId: f.worker.jobId,
    worker: { type: 'worker', id: f.worker.workerId },
    delegatedBy: { type: 'user', id: f.user },
    organizationId: f.org,
    workspaceId: f.workspace,
    startedAt: new Date().toISOString(),
    policySnapshot: {
      id: f.policy,
      organizationId: f.org,
      subjectId: f.user,
      version: 1,
      issuedAt: policy.issued_at.toISOString(),
      expiresAt: policy.expires_at.toISOString(),
      ...policy.payload,
    },
  });
  const publish = async (
    name = 'receipt.txt',
    selectedStorage: Parameters<typeof publishWorkbenchArtifact>[1] = storage(),
  ) =>
    publishWorkbenchArtifact(
      {
        context,
        sessionId: f.session,
        callId: randomUUID(),
        kind: 'document',
        fileName: name,
        format: 'text',
        mediaType: 'text/plain',
        bytes: Buffer.from('frozen bytes ' + name),
      },
      selectedStorage,
      db(),
    );
  const proof = async (answer = 'checked answer') => {
    const snapshot = await runtime.readFinalDeliveryEvidence(input);
    return Object.freeze({
      nativeSessionId: native,
      publicMessageId: randomUUID(),
      durableSeq: 55,
      nativeBindingId: randomUUID(),
      nativeCandidateDigest: finalDeliveryTextDigest(answer),
      candidateDigest: finalDeliveryTextDigest(answer),
      factSetDigest: finalDeliveryFactsDigest(snapshot),
      attempt: 1,
      generation: f.worker.generation,
    }) satisfies AssistantFinalDeliveryProof;
  };
  const finalize = async (p: AssistantFinalDeliveryProof) =>
    runtime.finalizeRoot({ ...input, finalDelivery: p });
  const guard = (p: AssistantFinalDeliveryProof) =>
    runtime.createFinalDeliveryCommitGuard({ ...input, finalDelivery: p });
  const complete = (
    p: AssistantFinalDeliveryProof,
    result: unknown = { answer: 'checked answer' },
  ) =>
    completeJob({
      workerId: f.worker.workerId,
      jobId: f.worker.jobId,
      leaseToken: f.worker.leaseToken,
      result,
      checkedDelivery: guard(p),
    });
  const state = async () => {
    const [row] =
      await db()`select j.status,r.state,r.result,m.content->>'text' text,
   (select count(*)::int from allrice_run_events v where v.run_id=r.id and event_type='run.succeeded') successes
   from allrice_jobs j join allrice_runs r on r.id=j.run_id join allrice_employee_runs e on e.run_id=r.id
   join allrice_messages m on m.id=e.assistant_message_id where j.id=${f.worker.jobId}`;
    assert.ok(row);
    return row;
  };
  return {
    ...f,
    native,
    runtime,
    input,
    context,
    publish,
    proof,
    finalize,
    guard,
    complete,
    state,
  };
}
/** Same persisted turn/current-runtime plus leased event ACK used by the Worker.
 * This creates only synthetic control rows, never a model/native turn. */
async function startOriginTurn(
  f: Awaited<ReturnType<typeof fixture>>,
  turn = 1,
) {
  const turnId = `${f.native}:turn:${turn}`;
  await recordConversationTurn({
    organizationId: f.org,
    workspaceId: f.workspace,
    sessionId: f.session,
    runId: f.rootRunId,
    workerId: f.worker.workerId,
    threadId: f.native,
    turnId,
  });
  await appendJobEvent({
    workerId: f.worker.workerId,
    jobId: f.worker.jobId,
    leaseToken: f.worker.leaseToken,
    type: 'turn.started',
    payload: {
      source: 'dsh',
      threadId: f.native,
      turnId,
      generation: f.worker.generation,
    },
  });
  const [event] = await db()<{ id: string; sequence: number }[]>`
    select id,sequence from allrice_run_events where run_id=${f.rootRunId}
      and event_type='turn.started' and payload->>'turnId'=${turnId} order by sequence desc limit 1`;
  assert.ok(event);
  return { runEventId: event.id, runEventSequence: event.sequence, turnId };
}
function readOrigin(
  f: Awaited<ReturnType<typeof fixture>>,
  change: Record<string, unknown> = {},
) {
  return f.runtime.readFinalDeliveryReplyOrigin({
    ...f.input,
    nativeSessionId: f.native,
    attempt: 1,
    ...change,
  });
}
async function waitOriginLock(fragment: string) {
  const [schema] = await db()`select current_schema() name`;
  await waitFor(async () => {
    const [waiting] = await db()`select count(*)::int n from pg_stat_activity
      where application_name=${schema!.name} and wait_event_type='Lock' and query like ${'%' + fragment + '%'}`;
    return waiting!.n >= 1;
  }, 'origin reader: ' + fragment);
}

async function addAudit(
  tx: RuntimeLedgerTransaction,
  f: Awaited<ReturnType<typeof fixture>>,
  artifact: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['publish']>>,
) {
  await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
 values(${f.org},${f.workspace},${f.user},'artifact.office-quality','deliverable_version',${artifact.id},'recorded','actual_exporter_receipt',
 ${tx.json({ objectId: artifact.object.id, checksum: artifact.object.checksum, runId: f.rootRunId, receipt: null })})`;
}

describe
  .skipIf(process.env.ALLRICE_RUN_DB_INTEGRATION !== '1')
  .sequential(
    'checked final delivery: actual owned PostgreSQL transactions',
    () => {
      beforeAll(async () => {
        process.env.ALLRICE_ASSISTANTS_ENABLED = '1';
        process.env.ALLRICE_WORKBENCH_ENABLED = '1';
        database = await createAssistantFixtureDatabase();
        const [location] =
          await db()`select current_database() database,current_schema() schema`;
        assert.ok(location);
        assert.equal(
          location.database,
          new URL(process.env.ALLRICE_TEST_DATABASE_URL!).pathname.slice(1),
        );
        assert.match(location.schema, /^p25_[a-f0-9]{32}$/);
        const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
        url.searchParams.set(
          'options',
          '-csearch_path=' + location.schema + ',public',
        );
        process.env.DATABASE_URL = url.toString();
        await db()`create table met184_frozen_refs(root_run_id uuid not null,object_id uuid not null,version_id uuid not null,checksum text not null,primary key(root_run_id,version_id))`;
        save('fixture', {
          database: location.database,
          schema: location.schema,
          storageRoot: database.storageRoot,
          realAuthority: 'assertAssistantAuthority',
          nativeIdentities:
            'synthetic trusted-host fixture; no native SDK call',
          modelCalls: 0,
          cloudCalls: 0,
        });
      });
      afterAll(async () => {
        try {
          if (database) {
            const [usage] =
              await db()`select (select count(*)::int from allrice_model_usage_ledger) models,(select count(*)::int from allrice_cloud_execution_attempts) clouds`;
            expect(usage).toEqual({ models: 0, clouds: 0 });
            save('usage', usage);
          }
        } finally {
          try {
            await closeDatabase();
          } finally {
            try {
              if (database) save('cleanup', await database.close());
            } finally {
              for (const [key, value] of Object.entries(originalEnvironment)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
              }
            }
          }
        }
      });
      it('exact body/facts commit with a legitimate historical native pin and private guard', async () => {
        const f = await fixture();
        await f.publish();
        const p = await f.proof();
        expect(() => f.guard(p)).toThrow('final_delivery_evidence_unavailable');
        expect(await f.finalize(p)).toMatchObject({
          status: 'completed',
          usageComplete: true,
        });
        await f.complete(p);
        const actual = await f.state();
        expect(actual).toMatchObject({
          status: 'succeeded',
          state: 'succeeded',
          text: 'checked answer',
          successes: 1,
        });
        expect(JSON.stringify(actual.result)).not.toContain(p.nativeBindingId);
        expect(JSON.stringify(actual.result)).not.toContain(p.factSetDigest);
        record('exact commit and historical pin', {
          actual,
          nativePinFirstAttempt: 7,
          proofAttempt: 1,
        });
      });
      it('a child the user stopped does not block the checked commit once its stop receipt commits', async () => {
        const f = await fixture();
        const child = (await f.delegate({ tools: ['assistant.report'] }))
          .instance;
        await f.runtime.cancelChild(
          {
            actor: { type: 'user', id: f.user },
            organizationId: f.org,
            workspaceId: f.workspace,
            requestId: randomUUID(),
            sessionId: randomUUID(),
            authenticatedAt: new Date().toISOString(),
            memberships: [],
          },
          {
            runId: f.rootRunId,
            childRunId: child.runId,
            requestId: randomUUID(),
          },
        );
        await f.runtime.confirmStopped({ ...f.input, runId: child.runId });
        await f.publish();
        const p = await f.proof();
        expect(await f.finalize(p)).toMatchObject({ status: 'completed' });
        await f.complete(p);
        expect(await f.state()).toMatchObject({
          status: 'succeeded',
          state: 'succeeded',
          successes: 1,
        });
      });
      const owner = (f: Awaited<ReturnType<typeof fixture>>) => ({
        actor: { type: 'user' as const, id: f.user },
        organizationId: f.org,
        workspaceId: f.workspace,
        requestId: randomUUID(),
        sessionId: randomUUID(),
        authenticatedAt: new Date().toISOString(),
        memberships: [],
      });
      it.each(['before-finalize', 'after-finalize'] as const)(
        'stopping A then canceling its root refuses checked success: %s',
        async (order) => {
          const f = await fixture(),
            a = (await f.delegate({ tools: ['assistant.report'] })).instance;
          await f.runtime.cancelChild(owner(f), {
            runId: f.rootRunId,
            childRunId: a.runId,
            requestId: randomUUID(),
          });
          await f.runtime.confirmStopped({ ...f.input, runId: a.runId });
          const p = await f.proof();
          if (order === 'after-finalize') {
            expect(await f.finalize(p)).toMatchObject({ status: 'completed' });
            expect(() => f.guard(p)).not.toThrow();
          }
          await f.runtime.cancelRoot(owner(f), {
            runId: f.rootRunId,
            requestId: randomUUID(),
          });
          await expect(f.finalize(p)).rejects.toThrow('canceled');
          if (order === 'after-finalize')
            await expect(f.complete(p)).rejects.toThrow('canceled');
          else
            expect(() => f.guard(p)).toThrow(
              'final_delivery_evidence_unavailable',
            );
          expect(await f.state()).toMatchObject({
            status: 'running',
            state: 'running',
            successes: 0,
          });
        },
      );
      it('a durable but unconsumed message to stopped A permits the checked job commit', async () => {
        const f = await fixture(),
          a = (await f.delegate({ tools: ['assistant.report'] })).instance;
        const inputId = randomUUID();
        await f.runtime.requestMessage(owner(f), {
          runId: f.rootRunId,
          childRunId: a.runId,
          inputId,
          text: '请给小说换一个结尾。',
        });
        await f.runtime.claimMessage({ ...f.input, inputId });
        await f.runtime.checkpointMessage({
          ...f.input,
          inputId,
          nativeMessageId: randomUUID(),
          durableSeq: 7,
        });
        await f.runtime.cancelChild(owner(f), {
          runId: f.rootRunId,
          childRunId: a.runId,
          requestId: randomUUID(),
        });
        await f.runtime.confirmStopped({ ...f.input, runId: a.runId });
        const p = await f.proof();
        expect(await f.finalize(p)).toMatchObject({ status: 'completed' });
        await f.complete(p);
        expect(await f.state()).toMatchObject({
          status: 'succeeded',
          state: 'succeeded',
          successes: 1,
        });
        const [message] =
          await db()`select status,adopted_seq from allrice_assistant_messages where input_id=${inputId}`;
        expect(message).toEqual({ status: 'durable', adopted_seq: null });
      });
      it('checked mode rejects absent/null proof; legacy finalize remains unchanged', async () => {
        const f = await fixture();
        await expect(f.runtime.finalizeRoot(f.input)).rejects.toThrow(
          'final_delivery_evidence_unavailable',
        );
        await expect(
          f.runtime.finalizeRoot({
            ...f.input,
            finalDelivery: null as unknown as AssistantFinalDeliveryProof,
          }),
        ).rejects.toThrow('final_delivery_evidence_unavailable');
        expect(
          (await f.runtime.readFinalDeliveryEvidence(f.input)).authorization,
        ).toBe('current');
        expect(
          await f.runtime.finalizeRoot({
            ...f.input,
            finalDelivery: await f.proof(),
          }),
        ).toMatchObject({ status: 'completed' });
        const g = await fixture();
        expect(
          await g.runtime.readFinalDeliveryEvidence(g.input),
        ).toMatchObject({
          complete: true,
        });
        expect(
          await createAssistantRuntime({
            database: db(),
            authorize: assertAssistantAuthority,
          }).finalizeRoot(g.input),
        ).toBeDefined();
      });
      it('explicit undefined/null/fake guards are rejected, even with a JSON proof in result', async () => {
        const f = await fixture(),
          p = await f.proof();
        await f.finalize(p);
        for (const invalid of [
          undefined,
          null,
          { assertCurrent: async () => ({ assertCommitted: async () => {} }) },
          JSON.parse(JSON.stringify(p)),
        ])
          await expect(
            completeJob({
              workerId: f.worker.workerId,
              jobId: f.worker.jobId,
              leaseToken: f.worker.leaseToken,
              result: { answer: 'checked answer', finalDelivery: p },
              checkedDelivery: invalid as unknown as JobCompletionGuard,
            }),
          ).rejects.toThrow('final_delivery_evidence_unavailable');
        expect(await f.state()).toMatchObject({
          status: 'running',
          successes: 0,
        });
      });
      it('body changes after finalize roll back without changing the original message', async () => {
        const f = await fixture(),
          p = await f.proof();
        await f.finalize(p);
        const before = await f.state();
        await expect(
          f.complete(p, { answer: 'checked answer\n' }),
        ).rejects.toThrow('final_delivery_evidence_unavailable');
        expect(await f.state()).toEqual(before);
        record('final body mismatch rollback', {
          before,
          after: await f.state(),
        });
      });
      it('a completed root cannot bypass a different or missing native proof', async () => {
        const f = await fixture(),
          p = await f.proof();
        await f.finalize(p);
        await expect(
          f.runtime.finalizeRoot({
            ...f.input,
            finalDelivery: { ...p, factSetDigest: 'sha256:' + '0'.repeat(64) },
          }),
        ).rejects.toThrow();
        await expect(f.runtime.finalizeRoot(f.input)).rejects.toThrow();
        expect(await f.state()).toMatchObject({
          status: 'running',
          successes: 0,
        });
      });
      for (const field of ['attempt', 'generation', 'native', 'pin'] as const)
        it(
          'rejects stale ' + field + ' between finalize and final success',
          async () => {
            const f = await fixture(),
              p = await f.proof();
            await f.finalize(p);
            if (field === 'attempt')
              await db()`update allrice_jobs set attempt=attempt+1 where id=${f.worker.jobId}`;
            if (field === 'generation')
              await db()`update allrice_conversation_runtimes set thread_generation=thread_generation+1 where session_id=${f.session}`;
            if (field === 'native')
              await db()`update allrice_conversation_runtimes set thread_id=${'dsh-' + randomUUID()} where session_id=${f.session}`;
            if (field === 'pin')
              await db()`delete from allrice_native_session_bindings where native_session_id=${f.native}`;
            const before = await f.state();
            await expect(f.complete(p)).rejects.toThrow();
            expect(await f.state()).toEqual(before);
          },
        );
      for (const change of [
        'membership',
        'assignment',
        'expired-lease',
        'expired-policy',
        'object-deleted',
        'object-expired',
      ] as const)
        it(
          'checks ' + change + ' after finalized native/root completion',
          async () => {
            const f = await fixture(),
              artifact = await f.publish(),
              p = await f.proof();
            await f.finalize(p);
            if (change === 'membership')
              await db()`update allrice_memberships set active=false where id=${f.membership}`;
            if (change === 'assignment')
              await db()`update allrice_employee_assignments set active=false where id=${f.assignment}`;
            if (change === 'expired-lease')
              await db()`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
            if (change === 'expired-policy') {
              await db()`update allrice_policy_snapshots set expires_at=clock_timestamp()+interval '100 milliseconds' where id=${f.policy}`;
              await new Promise((r) => setTimeout(r, 150));
            }
            if (change === 'object-deleted') {
              await expect(
                db()`update allrice_storage_objects set state='deleted',deleted_at=clock_timestamp() where id=${artifact.object.id}`,
              ).rejects.toThrow('immutable');
              await f.complete(p);
              expect(await f.state()).toMatchObject({ status: 'succeeded' });
              record('immutable object deletion cannot commit', {
                databaseRejected: true,
                checkedOriginalObjectSucceeded: true,
              });
              return;
            }
            if (change === 'object-expired') {
              await db()`update allrice_storage_objects set retention_until=clock_timestamp()+interval '100 milliseconds' where id=${artifact.object.id}`;
              await new Promise((r) => setTimeout(r, 150));
            }
            const before = await f.state();
            await expect(f.complete(p)).rejects.toThrow();
            expect(await f.state()).toEqual(before);
          },
        );
      it('a newly pending receipt after finalize cannot become succeeded just because files match', async () => {
        const f = await fixture(),
          p = await f.proof();
        await f.finalize(p);
        await db()`insert into allrice_assistant_usage(call_id,run_id,root_run_id,metric,amount)values(${randomUUID()},${f.rootRunId},${f.rootRunId},'model_calls',1)`;
        const before = await f.state();
        await expect(f.complete(p)).rejects.toThrow(
          'final_delivery_evidence_unavailable',
        );
        expect(await f.state()).toEqual(before);
      });
      it('new exact quality audit rows change facts and reject the stale proof', async () => {
        const f = await fixture(),
          artifact = await f.publish(),
          p = await f.proof();
        await f.finalize(p);
        await db().begin(async (tx) => {
          await tx`select root_run_id from allrice_runtime_roots where root_run_id=${f.rootRunId} for update`;
          await addAudit(tx, f, artifact);
        });
        const before = await f.state();
        await expect(f.complete(p)).rejects.toThrow(
          'final_delivery_evidence_unavailable',
        );
        expect(await f.state()).toEqual(before);
      });
      it('frozen exact historical reference in the same Session is legal without matching first_run_id', async () => {
        const f = await fixture(),
          oldRun = randomUUID(),
          oldJob = randomUUID(),
          um = randomUUID(),
          am = randomUUID();
        await db()`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input)
   select ${oldRun},organization_id,workspace_id,owner_id,'running',policy_snapshot_id,execution_spec,input from allrice_runs where id=${f.rootRunId}`;
        await db()`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at,attempt)
   values(${oldJob},${f.org},${f.workspace},${f.user},${oldRun},'running',${randomUUID()},clock_timestamp()+interval '10 minutes','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}',${f.worker.workerId},${randomUUID()},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '10 minutes',1)`;
        await db()`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
   values(${um},${f.org},${f.workspace},${f.session},${f.user},'user','{"text":"old frozen input","citations":[]}'),
   (${am},${f.org},${f.workspace},${f.session},${f.user},'assistant','{"text":"old frozen output","citations":[]}')`;
        await db()`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,native_skills,execution_snapshot)
   select ${oldRun},organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,${um},${am},provider_snapshot,prompt_snapshot,native_skills,execution_snapshot from allrice_employee_runs where run_id=${f.rootRunId}`;
        const old = await publishWorkbenchArtifact(
          {
            context: { ...f.context, runId: oldRun, jobId: oldJob },
            sessionId: f.session,
            callId: randomUUID(),
            kind: 'document',
            fileName: 'old-input.txt',
            format: 'text',
            mediaType: 'text/plain',
            bytes: Buffer.from('immutable old input'),
          },
          storage(),
          db(),
        );
        await db()`update allrice_runs set state='succeeded' where id=${oldRun}`;
        await db()`insert into met184_frozen_refs(root_run_id,object_id,version_id,checksum)values(${f.rootRunId},${old.object.id},${old.id},${old.object.checksum})`;
        const snapshot = await f.runtime.readFinalDeliveryEvidence(f.input);
        expect(snapshot.explicitReferenceVersionIds).toEqual([old.id]);
        expect(
          snapshot.artifacts.find((a) => a.versionId === old.id)?.originRunId,
        ).toBe(oldRun);
        const p = await f.proof();
        await f.finalize(p);
        await f.complete(p);
        expect(await f.state()).toMatchObject({ status: 'succeeded' });
        record('legitimate frozen historical reference', {
          oldRun,
          reference: old.id,
          currentRun: f.rootRunId,
          referenceAuthorizedBy:
            'same-tx frozen fixture source table + real owner/session/object authority',
        });
      });
      it('cancellation committed first cannot be overwritten by checked success', async () => {
        const f = await fixture(),
          p = await f.proof();
        await f.finalize(p);
        await db().begin((tx) =>
          cancelAssistantRootTransaction(tx, f.rootRunId, randomUUID()),
        );
        await expect(f.complete(p)).rejects.toThrow();
        expect(await f.state()).toMatchObject({
          status: 'running',
          successes: 0,
        });
      });
      it('retains the real RR stale-after-root-wait INSERT counterexample', async () => {
        const f = await fixture(),
          artifact = await f.publish(),
          held = deferred(),
          release = deferred(),
          selected = deferred();
        const writer = db().begin(async (tx) => {
          await tx`select root_run_id from allrice_runtime_roots where root_run_id=${f.rootRunId} for update`;
          held.resolve();
          await release.promise;
          await addAudit(tx, f, artifact);
        });
        await held.promise;
        const reader = db().begin(
          'isolation level repeatable read',
          async (tx) => {
            const [before] =
              await tx`select count(*)::int n from allrice_audit_events where resource_id=${artifact.id} and action='artifact.office-quality'`;
            selected.resolve();
            await tx`select root_run_id from allrice_runtime_roots where root_run_id=${f.rootRunId} for update`;
            const [after] =
              await tx`select count(*)::int n from allrice_audit_events where resource_id=${artifact.id} and action='artifact.office-quality'`;
            return { before: before!.n, after: after!.n };
          },
        );
        await selected.promise;
        release.resolve();
        await writer;
        const observed = await reader;
        const [fresh] =
          await db()`select count(*)::int n from allrice_audit_events where resource_id=${artifact.id} and action='artifact.office-quality'`;
        expect(observed.after).toBe(observed.before);
        expect(fresh!.n).toBe(observed.after + 1);
        record('RR stale INSERT counterexample', {
          ...observed,
          fresh: fresh!.n,
        });
      });
      it('root-locked RC sees a real publisher committing while the reader waited', async () => {
        const f = await fixture(),
          p = await f.proof(),
          held = deferred(),
          release = deferred(),
          baseStorage = storage();
        const delayed = {
          ...baseStorage,
          put: async (...args: Parameters<typeof baseStorage.put>) => {
            await baseStorage.put(...args);
            held.resolve();
            await release.promise;
          },
          get: baseStorage.get.bind(baseStorage),
          exists: baseStorage.exists.bind(baseStorage),
          delete: baseStorage.delete.bind(baseStorage),
        };
        const writer = f.publish('late.txt', delayed);
        await held.promise;
        const completing = f.finalize(p);
        await new Promise((r) => setTimeout(r, 30));
        release.resolve();
        const actual = await writer;
        await expect(completing).rejects.toThrow(
          'final_delivery_evidence_unavailable',
        );
        const current = await f.runtime.readFinalDeliveryEvidence(f.input);
        expect(current.artifacts.some((a) => a.versionId === actual.id)).toBe(
          true,
        );
        expect(await f.state()).toMatchObject({
          status: 'running',
          successes: 0,
        });
        record('RC waited real publisher', {
          seenVersion: actual.id,
          staleProofRejected: true,
        });
      });
      it('a later real publisher waits behind checked completion and cannot publish after success', async () => {
        const f = await fixture(),
          p = await f.proof();
        await f.finalize(p);
        const [message] =
          await db()`select assistant_message_id from allrice_employee_runs where run_id=${f.rootRunId}`;
        const held = deferred(),
          release = deferred();
        let blockerPid = 0,
          completionPid = 0;
        let publicationWait: unknown;
        const blocker = db().begin(async (tx) => {
          blockerPid = Number((await tx`select pg_backend_pid() pid`)[0]!.pid);
          await tx`select id from allrice_messages where id=${message!.assistant_message_id} for update`;
          held.resolve();
          await release.promise;
        });
        void blocker.catch(() => {});
        let committing: ReturnType<typeof f.complete> | undefined;
        let publisher:
          | Promise<
              | { value: Awaited<ReturnType<typeof f.publish>> }
              | { error: string }
            >
          | undefined;
        try {
          await Promise.race([held.promise, blocker]);
          committing = f.complete(p);
          void committing.catch(() => {});
          await waitFor(async () => {
            const [waiting] = await db()`select pid from pg_stat_activity
                where ${blockerPid}=any(pg_blocking_pids(pid))
                  and wait_event_type='Lock' and query like '%allrice_messages%'`;
            completionPid = Number(waiting?.pid ?? 0);
            return completionPid > 0;
          }, 'checked completion waits for its message');
          publisher = f.publish('too-late.txt').then(
            (value) => ({ value }),
            (error) => ({ error: String(error) }),
          );
          await waitFor(async () => {
            // The publisher now waits at the shared pre-root mutex. Observe
            // this Run's exact 703 lock and its real completion transaction.
            const [waiting] = await db()`select a.pid,a.query,a.wait_event,
                pg_blocking_pids(a.pid) blockers
              from pg_stat_activity a join pg_locks l on l.pid=a.pid
              where ${completionPid}=any(pg_blocking_pids(a.pid))
                and a.wait_event_type='Lock' and l.locktype='advisory' and not l.granted
                and l.classid=((hashtextextended(${f.rootRunId},703)>>32)&4294967295)::oid
                and l.objid=(hashtextextended(${f.rootRunId},703)&4294967295)::oid
                and l.objsubid=1`;
            publicationWait = waiting;
            return Boolean(waiting);
          }, 'publisher waits for checked completion on the Run 703 lock');
        } finally {
          release.resolve();
          await Promise.allSettled([blocker, committing, publisher]);
        }
        await blocker;
        await committing;
        assert.ok(publisher);
        const late = await publisher;
        expect(late).toHaveProperty('error');
        expect(await f.state()).toMatchObject({
          status: 'succeeded',
          successes: 1,
        });
        const [count] =
          await db()`select count(*)::int n from allrice_deliverable_versions where session_id=${f.session}`;
        expect(count!.n).toBe(0);
        record('reverse publisher blocked', {
          blockerPid,
          completionPid,
          publicationWait,
          late,
          result: await f.state(),
          lateVersions: count!.n,
        });
        console.info('checked completion/publication wait graph', {
          blockerPid,
          completionPid,
          publicationWait,
        });
      });
      it('unknown unsettled outcome retains unknown and cannot issue a completed guard', async () => {
        const f = await fixture(),
          p = await f.proof();
        await db()`insert into allrice_assistant_usage(call_id,run_id,root_run_id,metric,amount)values(${randomUUID()},${f.rootRunId},${f.rootRunId},'model_calls',1)`;
        expect(await f.finalize(p)).toMatchObject({
          status: 'unknown',
          usageComplete: false,
        });
        expect(() => f.guard(p)).toThrow('final_delivery_evidence_unavailable');
        expect(await f.state()).toMatchObject({
          status: 'running',
          successes: 0,
        });
      });
      it('last-SQL lease deadline failure rolls back Job/Run/message/event writes', async () => {
        const f = await fixture(),
          p = await f.proof();
        await f.finalize(p);
        const before = await f.state();
        const [message] =
          await db()`select assistant_message_id from allrice_employee_runs where run_id=${f.rootRunId}`;
        const held = deferred(),
          release = deferred();
        const blocker = db().begin(async (tx) => {
          await tx`select id from allrice_messages where id=${message!.assistant_message_id} for update`;
          held.resolve();
          await release.promise;
        });
        await held.promise;
        await db()`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '350 milliseconds' where id=${f.worker.jobId}`;
        const committing = f.complete(p);
        await new Promise((r) => setTimeout(r, 550));
        release.resolve();
        await blocker;
        await expect(committing).rejects.toThrow();
        expect(await f.state()).toEqual(before);
        record('tail lease expiry rollback', {
          before,
          after: await f.state(),
          actualMessageUpdateWait: true,
        });
      });
      describe('cold reply origin: actual current authority and durable turn ACK', () => {
        it('returns exact current-Run anchors after real leased turn ACKs without writing new events', async () => {
          const f = await fixture();
          const first = await startOriginTurn(f, 1);
          const second = await startOriginTurn(f, 2);
          const [before] =
            await db()`select count(*)::int n from allrice_run_events where run_id=${f.rootRunId}`;
          const origin = await readOrigin(f);
          expect(origin).toEqual({
            schemaVersion: 1,
            rootRunId: f.rootRunId,
            nativeSessionId: f.native,
            starts: [first, second],
          });
          expect(Object.isFrozen(origin)).toBe(true);
          expect(Object.isFrozen(origin!.starts)).toBe(true);
          expect(origin!.starts.every(Object.isFrozen)).toBe(true);
          const [after] =
            await db()`select count(*)::int n from allrice_run_events where run_id=${f.rootRunId}`;
          expect(after).toEqual(before);
          record('origin exact durable current anchors', {
            origin,
            eventCountBefore: before!.n,
            eventCountAfter: after!.n,
          });
        });
        it('never substitutes a historical pin first Run or its earlier turn for this Run', async () => {
          const f = await fixture();
          const [pin] =
            await db()`select first_run_id,first_job_id,first_attempt from allrice_native_session_bindings where native_session_id=${f.native}`;
          assert.ok(pin);
          expect(pin.first_run_id).not.toBe(f.rootRunId);
          expect(pin.first_attempt).toBe(7);
          await db()`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input)
            select ${pin.first_run_id},organization_id,workspace_id,owner_id,'succeeded',policy_snapshot_id,execution_spec,input from allrice_runs where id=${f.rootRunId}`;
          await db()`insert into allrice_run_events(id,organization_id,workspace_id,run_id,sequence,event_type,payload)
            values(${randomUUID()},${f.org},${f.workspace},${pin.first_run_id},1,'turn.started',${db().json({ source: 'dsh', threadId: f.native, turnId: `${f.native}:turn:1`, generation: f.worker.generation })})`;
          expect(await readOrigin(f)).toBeNull();
          const current = await startOriginTurn(f, 2);
          expect((await readOrigin(f))!.starts).toEqual([current]);
          record('historical pin is not current reply authority', {
            firstRun: pin.first_run_id,
            currentRun: f.rootRunId,
            current,
          });
        });
        it('missing native pin rejects even with a valid current turn ACK', async () => {
          const f = await fixture();
          await startOriginTurn(f);
          await db()`delete from allrice_native_session_bindings where native_session_id=${f.native}`;
          await expect(readOrigin(f)).rejects.toThrow(
            'final_delivery_evidence_unavailable',
          );
        });
        it.each([
          'native-session',
          'attempt',
          'generation',
          'fence',
          'worker',
          'lease',
          'job',
          'root',
          'scope',
        ])('rejects a foreign current identity: %s', async (kind) => {
          const f = await fixture();
          await startOriginTurn(f);
          const change: Record<string, unknown> = {};
          if (kind === 'native-session') change.nativeSessionId = 'dsh-foreign';
          if (kind === 'attempt') change.attempt = 2;
          if (kind === 'generation')
            change.worker = {
              ...f.worker,
              generation: f.worker.generation + 1,
            };
          if (kind === 'fence') change.worker = { ...f.worker, fence: 2 };
          if (kind === 'worker')
            change.worker = { ...f.worker, workerId: randomUUID() };
          if (kind === 'lease')
            change.worker = { ...f.worker, leaseToken: randomUUID() };
          if (kind === 'job')
            change.worker = { ...f.worker, jobId: randomUUID() };
          if (kind === 'root') change.rootRunId = randomUUID();
          if (kind === 'scope')
            change.scope = { ...f.task.scope, workspaceId: randomUUID() };
          await expect(readOrigin(f, change)).rejects.toThrow();
        });
        it.each([
          'owner',
          'context',
          'workspace',
          'profile',
          'runtime-generation',
          'active-root',
          'active-turn',
          'thread',
        ])(
          'rejects a foreign or stale native/runtime binding: %s',
          async (kind) => {
            const foreign = ['owner', 'workspace'].includes(kind)
              ? await fixture()
              : undefined;
            const f = await fixture({
              ...(kind === 'owner' ? { ownerId: foreign!.user } : {}),
              ...(kind === 'workspace'
                ? {
                    organizationId: foreign!.org,
                    workspaceId: foreign!.workspace,
                  }
                : {}),
              ...(kind === 'context' ? { contextId: randomUUID() } : {}),
              ...(kind === 'profile'
                ? { profileId: 'technical' as const }
                : {}),
            });
            await startOriginTurn(f);
            if (kind === 'runtime-generation')
              await db()`update allrice_conversation_runtimes set thread_generation=thread_generation+1 where session_id=${f.session}`;
            if (kind === 'active-root') {
              const otherRun = randomUUID();
              await db()`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input)
                select ${otherRun},organization_id,workspace_id,owner_id,'running',policy_snapshot_id,execution_spec,input from allrice_runs where id=${f.rootRunId}`;
              await db()`update allrice_conversation_runtimes set active_run_id=${otherRun} where session_id=${f.session}`;
            }
            if (kind === 'active-turn')
              await db()`update allrice_conversation_runtimes set active_turn_id=${`${f.native}:turn:2`} where session_id=${f.session}`;
            if (kind === 'thread')
              await db()`update allrice_conversation_runtimes set thread_id='dsh-foreign' where session_id=${f.session}`;
            await expect(readOrigin(f)).rejects.toThrow();
          },
        );
        it.each([
          'foreign-thread',
          'foreign-generation',
          'wrong-source',
          'missing-turn',
          'leading-zero',
          'unsafe-turn',
          'duplicate-turn',
          'non-object',
        ])(
          'does not filter malformed current-Run turn records into apparent authority: %s',
          async (kind) => {
            const f = await fixture();
            const anchor = await startOriginTurn(f);
            const payload: Record<string, string | number> = {
              source: 'dsh',
              threadId: f.native,
              turnId: anchor.turnId,
              generation: f.worker.generation,
            };
            if (kind === 'foreign-thread') payload.threadId = 'dsh-foreign';
            if (kind === 'foreign-generation')
              payload.generation = f.worker.generation + 1;
            if (kind === 'wrong-source') payload.source = 'model-text';
            if (kind === 'missing-turn') delete payload.turnId;
            if (kind === 'leading-zero') payload.turnId = `${f.native}:turn:01`;
            if (kind === 'unsafe-turn')
              payload.turnId = `${f.native}:turn:9007199254740992`;
            if (kind === 'duplicate-turn') {
              await db()`insert into allrice_run_events(id,organization_id,workspace_id,run_id,sequence,event_type,payload)
                values(${randomUUID()},${f.org},${f.workspace},${f.rootRunId},${anchor.runEventSequence + 1},'turn.started',${db().json(payload)})`;
            } else {
              await db()`update allrice_run_events set payload=${db().json(kind === 'non-object' ? [] : payload)} where id=${anchor.runEventId}`;
            }
            await expect(readOrigin(f)).rejects.toThrow(
              'final_delivery_evidence_unavailable',
            );
          },
        );
        it('refuses more than the finite 200 anchors instead of truncating current evidence', async () => {
          const f = await fixture();
          await db()`insert into allrice_run_events(id,organization_id,workspace_id,run_id,sequence,event_type,payload)
            select gen_random_uuid(),${f.org}::uuid,${f.workspace}::uuid,${f.rootRunId}::uuid,n,'turn.started',
              jsonb_build_object('source','dsh','threadId',${f.native}::text,'turnId',${f.native + ':turn:'}::text || n::text,'generation',${f.worker.generation}::int)
            from generate_series(1,201) n`;
          await db()`update allrice_conversation_runtimes set active_turn_id=${`${f.native}:turn:201`} where session_id=${f.session}`;
          await expect(readOrigin(f)).rejects.toThrow(
            'final_delivery_evidence_unavailable',
          );
        });
        it.each(['cancel', 'expired', 'drain-expired', 'revoked'])(
          'refuses a stopped or expired current lease: %s',
          async (kind) => {
            const f = await fixture();
            await startOriginTurn(f);
            if (kind === 'cancel')
              await db().begin((tx) =>
                cancelAssistantRootTransaction(tx, f.rootRunId, randomUUID()),
              );
            if (kind === 'expired')
              await db()`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
            if (kind === 'drain-expired')
              await db()`update allrice_jobs set drain_reason='timeout',drain_deadline_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
            if (kind === 'revoked')
              await db()`update allrice_assistant_roots set revoked_at=clock_timestamp() where root_run_id=${f.rootRunId}`;
            await expect(readOrigin(f)).rejects.toThrow();
          },
        );
        it('READ COMMITTED sees a late current anchor committed while it waited on the common root lock', async () => {
          const f = await fixture(),
            held = deferred(),
            release = deferred();
          const eventId = randomUUID(),
            turnId = `${f.native}:turn:1`;
          const writer = db().begin(async (tx) => {
            await tx`select root_run_id from allrice_runtime_roots where root_run_id=${f.rootRunId} for update`;
            held.resolve();
            await release.promise;
            await tx`update allrice_conversation_runtimes set active_turn_id=${turnId} where session_id=${f.session}`;
            await tx`insert into allrice_run_events(id,organization_id,workspace_id,run_id,sequence,event_type,payload)
              values(${eventId},${f.org},${f.workspace},${f.rootRunId},1,'turn.started',${tx.json({ source: 'dsh', threadId: f.native, turnId, generation: f.worker.generation })})`;
          });
          await held.promise;
          const reading = readOrigin(f);
          try {
            await waitOriginLock('allrice_runtime_roots');
          } finally {
            release.resolve();
          }
          await writer;
          const origin = await reading;
          expect(origin!.starts).toEqual([
            { runEventId: eventId, runEventSequence: 1, turnId },
          ]);
          record('origin late anchor after actual root lock wait', {
            origin,
            waitedOnRealPgLock: true,
          });
        });
        it('rechecks current attempt after waiting for a Job row change', async () => {
          const f = await fixture(),
            held = deferred(),
            release = deferred();
          await startOriginTurn(f);
          const writer = db().begin(async (tx) => {
            await tx`select id from allrice_jobs where id=${f.worker.jobId} for update`;
            held.resolve();
            await release.promise;
            await tx`update allrice_jobs set attempt=2 where id=${f.worker.jobId}`;
          });
          await held.promise;
          const reading = readOrigin(f).then(
            (origin) => ({ origin }),
            (error: unknown) => ({ error }),
          );
          try {
            await waitOriginLock('allrice_jobs');
          } finally {
            release.resolve();
          }
          await writer;
          const result = await reading;
          expect(result).toHaveProperty('error');
          record('origin waited attempt changed', {
            rejected: 'error' in result,
            waitedOnRealPgLock: true,
          });
        });
        it.each(['cancel', 'revoke'])(
          'rechecks stopped root authority after an actual root-lock wait: %s',
          async (kind) => {
            const f = await fixture(),
              held = deferred(),
              release = deferred();
            await startOriginTurn(f);
            const writer = db().begin(async (tx) => {
              await tx`select root_run_id from allrice_runtime_roots where root_run_id=${f.rootRunId} for update`;
              held.resolve();
              await release.promise;
              if (kind === 'cancel')
                await cancelAssistantRootTransaction(
                  tx,
                  f.rootRunId,
                  randomUUID(),
                );
              else
                await tx`update allrice_assistant_roots set revoked_at=clock_timestamp() where root_run_id=${f.rootRunId}`;
            });
            await held.promise;
            const reading = readOrigin(f).then(
              (origin) => ({ origin }),
              (error: unknown) => ({ error }),
            );
            try {
              await waitOriginLock('allrice_runtime_roots');
            } finally {
              release.resolve();
            }
            await writer;
            expect(await reading).toHaveProperty('error');
            record('origin waited stopped authority ' + kind, {
              rejected: true,
              waitedOnRealPgLock: true,
            });
          },
        );
        it('rechecks a native binding removed while its identity query waited', async () => {
          const f = await fixture(),
            held = deferred(),
            release = deferred();
          await startOriginTurn(f);
          const writer = db().begin(async (tx) => {
            await tx`select native_session_id from allrice_native_session_bindings where native_session_id=${f.native} for update`;
            held.resolve();
            await release.promise;
            await tx`delete from allrice_native_session_bindings where native_session_id=${f.native}`;
          });
          await held.promise;
          const reading = readOrigin(f).then(
            (origin) => ({ origin }),
            (error: unknown) => ({ error }),
          );
          try {
            await waitOriginLock('allrice_native_session_bindings');
          } finally {
            release.resolve();
          }
          await writer;
          expect(await reading).toHaveProperty('error');
          record('origin waited pin revoked', {
            rejected: true,
            waitedOnRealPgLock: true,
          });
        });
        it('tail lease check rejects expiry during a real authority row wait', async () => {
          const f = await fixture(),
            held = deferred(),
            release = deferred();
          await startOriginTurn(f);
          const writer = db().begin(async (tx) => {
            await tx`select id from allrice_memberships where organization_id=${f.org} and workspace_id=${f.workspace} and user_id=${f.user} for update`;
            held.resolve();
            await release.promise;
          });
          await held.promise;
          await db()`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '350 milliseconds' where id=${f.worker.jobId}`;
          const reading = readOrigin(f).then(
            (origin) => ({ origin }),
            (error: unknown) => ({ error }),
          );
          try {
            await waitOriginLock('allrice_memberships');
            await waitFor(async () => {
              const [expired] =
                await db()`select lease_expires_at<=clock_timestamp() expired from allrice_jobs where id=${f.worker.jobId}`;
              return expired!.expired;
            }, 'clock crossed own lease deadline');
          } finally {
            release.resolve();
          }
          await writer;
          expect(await reading).toHaveProperty('error');
          record('origin tail expiry after actual authority wait', {
            rejected: true,
            waitedOnRealPgLock: true,
          });
        });
      });
    },
  );
