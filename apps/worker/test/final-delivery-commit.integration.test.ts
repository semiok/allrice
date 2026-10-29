/** Real PostgreSQL/current-authority/commit gates. Host proof IDs are explicitly
 * synthetic here; real native proof is covered by p25/run-delivery.integration. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ExecutionContextSchema } from '@allrice/contracts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../packages/database/src/run-authority.fixture.ts';
import * as client from '../../../packages/database/src/core/client.ts';
import { completeJob } from '../../../packages/database/src/execution/queue.ts';
import { publishWorkbenchArtifact } from '../../../packages/database/src/artifact-review.ts';
import {
  finalDeliveryFactsDigest,
  finalDeliveryTextDigest,
  type JobCompletionGuard,
} from '../../../packages/database/src/final-delivery-commit.ts';
import { prepareDeliveryAuthorityFixture } from './final-delivery-reference-authority.fixture.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
};
suite(
  'ordinary Run checked completion and current evidence — isolated PostgreSQL',
  () => {
    let database: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    beforeAll(async () => {
      database = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(database.db);
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await database?.close();
    });
    async function fixture() {
      const db = database.db;
      const f = await createRunAuthorityFixture(db, {
        memberRole: 'member',
        allowedTools: ['workspace.export.create', 'workspace.document.read'],
      });
      const native = await prepareDeliveryAuthorityFixture(f);
      const [policy] =
        await db`select * from allrice_policy_snapshots where id=${f.policy}`;
      const context = ExecutionContextSchema.parse({
        executionId: randomUUID(),
        runId: f.rootRunId,
        jobId: f.worker.jobId,
        worker: { type: 'worker', id: f.worker.workerId },
        delegatedBy: f.context.actor,
        organizationId: f.org,
        workspaceId: f.workspace,
        startedAt: new Date().toISOString(),
        policySnapshot: {
          id: f.policy,
          organizationId: f.org,
          subjectId: f.user,
          version: 1,
          issuedAt: policy!.issued_at.toISOString(),
          expiresAt: policy!.expires_at.toISOString(),
          ...policy!.payload,
        },
      });
      const publish = (name = 'result.txt') =>
        publishWorkbenchArtifact(
          {
            context,
            sessionId: f.session,
            callId: randomUUID(),
            kind: 'document',
            fileName: name,
            format: 'text',
            mediaType: 'text/plain',
            bytes: Buffer.from('actual retained bytes'),
          },
          runtimeFixtureStorage(db),
          db,
        );
      const state = async () =>
        (
          await db`select j.status,r.state,r.result,m.content,(select count(*)::int from allrice_run_events e where e.run_id=r.id and e.event_type='run.succeeded') successes from allrice_jobs j join allrice_runs r on r.id=j.run_id join allrice_employee_runs er on er.run_id=r.id join allrice_messages m on m.id=er.assistant_message_id where j.id=${f.worker.jobId}`
        )[0]!;
      async function issue(answer = 'checked answer') {
        const origin = await native.port.readOrigin();
        if (!origin) throw Error('Synthetic origin must be acknowledged first');
        const snapshot = await native.port.readSnapshot();
        const proof = {
          nativeSessionId: native.native,
          publicMessageId: randomUUID(),
          durableSeq: 55,
          nativeBindingId: randomUUID(),
          nativeCandidateDigest: finalDeliveryTextDigest(answer),
          candidateDigest: finalDeliveryTextDigest(answer),
          factSetDigest: finalDeliveryFactsDigest(snapshot),
          attempt: 1,
          generation: f.worker.generation,
        };
        return { proof, guard: native.port.createCommitGuard(proof, origin) };
      }
      const complete = (guard: JobCompletionGuard, answer = 'checked answer') =>
        completeJob({
          workerId: f.worker.workerId,
          jobId: f.worker.jobId,
          leaseToken: f.worker.leaseToken,
          result: { answer },
          checkedDelivery: guard,
        });
      return { ...f, ...native, publish, state, issue, complete };
    }
    it('用户要文件：当前普通 Run 的确切正文和文件证据原子提交，历史 pin 不冒充本轮来源', async () => {
      const f = await fixture();
      await f.publish();
      await f.startTurn();
      const p = await f.issue();
      await f.complete(p.guard);
      const state = await f.state();
      expect(state).toMatchObject({
        status: 'succeeded',
        state: 'succeeded',
        successes: 1,
        content: { text: 'checked answer' },
      });
      expect(JSON.stringify(state.result)).not.toContain(
        p.proof.nativeBindingId,
      );
      expect(JSON.stringify(state.result)).not.toContain(p.proof.factSetDigest);
    });
    it('rejects absent/null/copied/fake guards before writing success', async () => {
      const f = await fixture();
      await f.startTurn();
      const p = await f.issue();
      const before = await f.state();
      for (const guard of [
        undefined,
        null,
        JSON.parse(JSON.stringify(p.proof)),
        { assertCurrent: async () => ({ assertCommitted: async () => {} }) },
      ])
        await expect(f.complete(guard as JobCompletionGuard)).rejects.toThrow(
          'final_delivery_evidence_unavailable',
        );
      expect(await f.state()).toEqual(before);
    });
    it('rejects a changed final body without mutating the original message', async () => {
      const f = await fixture();
      await f.startTurn();
      const p = await f.issue();
      const before = await f.state();
      await expect(f.complete(p.guard, 'checked answer\n')).rejects.toThrow(
        'final_delivery_evidence_unavailable',
      );
      expect(await f.state()).toEqual(before);
    });
    it.each([
      'attempt',
      'generation',
      'native',
      'pin',
      'assignment',
      'member',
      'employee',
      'policy',
      'cancel',
      'lease',
    ] as const)('rechecks actual %s after proof issuance', async (kind) => {
      const f = await fixture();
      await f.startTurn();
      const p = await f.issue();
      const db = database.db;
      if (kind === 'attempt')
        await db`update allrice_jobs set attempt=attempt+1 where id=${f.worker.jobId}`;
      if (kind === 'generation')
        await db`update allrice_conversation_runtimes set thread_generation=thread_generation+1 where session_id=${f.session}`;
      if (kind === 'native')
        await db`update allrice_conversation_runtimes set thread_id='dsh-foreign' where session_id=${f.session}`;
      if (kind === 'pin')
        await db`delete from allrice_native_session_bindings where native_session_id=${f.native}`;
      if (kind === 'assignment')
        await db`update allrice_employee_assignments set active=false where id=${f.assignment}`;
      if (kind === 'member')
        await db`update allrice_memberships set active=false where id=${f.membership}`;
      if (kind === 'employee')
        await db`update allrice_employees set status='archived' where id=${f.employee}`;
      if (kind === 'policy')
        await db`update allrice_runtime_policy_controls set controls=jsonb_set(controls,'{enabled}','false') where organization_id=${f.org}`;
      if (kind === 'cancel')
        await db`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${f.worker.jobId}`;
      if (kind === 'lease')
        await db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
      if (kind === 'cancel') {
        await f.complete(p.guard);
        expect(await f.state()).toMatchObject({
          status: 'canceled',
          state: 'canceled',
        });
      } else await expect(f.complete(p.guard)).rejects.toThrow();
      expect((await f.state()).successes).toBe(0);
    });
    it('a new actual artifact invalidates earlier facts; no successful body survives the rollback', async () => {
      const f = await fixture();
      await f.startTurn();
      const p = await f.issue();
      await f.publish('late.txt');
      await expect(f.complete(p.guard)).rejects.toThrow(
        'final_delivery_evidence_unavailable',
      );
      expect((await f.state()).successes).toBe(0);
    });
    it('new root turn ACK invalidates a previously captured origin', async () => {
      const f = await fixture();
      await f.startTurn();
      const p = await f.issue();
      await f.startTurn(2);
      await expect(f.complete(p.guard)).rejects.toThrow(
        'final_delivery_evidence_unavailable',
      );
      expect((await f.state()).successes).toBe(0);
    });
    it('origin remains read-only, absent before a current ACK, and exact after it', async () => {
      const f = await fixture();
      expect(await f.port.readOrigin()).toBeNull();
      const anchor = await f.startTurn();
      const before =
        await database.db`select id,sequence,payload from allrice_run_events where run_id=${f.rootRunId} order by sequence`;
      expect((await f.port.readOrigin())!.starts).toEqual([anchor]);
      expect(
        await database.db`select id,sequence,payload from allrice_run_events where run_id=${f.rootRunId} order by sequence`,
      ).toEqual(before);
    });
    it.each([
      'wrong-source',
      'foreign-thread',
      'foreign-generation',
      'malformed-turn',
      'duplicate-turn',
    ] as const)('refuses malformed current turn evidence: %s', async (kind) => {
      const f = await fixture();
      const anchor = await f.startTurn();
      const db = database.db;
      const payload = {
        source: kind === 'wrong-source' ? 'model' : 'dsh',
        threadId: kind === 'foreign-thread' ? 'other' : f.native,
        generation: kind === 'foreign-generation' ? 2 : 1,
        turnId:
          kind === 'malformed-turn' ? `${f.native}:turn:01` : anchor.turnId,
      };
      if (kind === 'duplicate-turn')
        await db`insert into allrice_run_events(id,run_id,organization_id,workspace_id,sequence,event_type,payload) values(${randomUUID()},${f.rootRunId},${f.org},${f.workspace},2,'turn.started',${db.json(payload)})`;
      else
        await db`update allrice_run_events set payload=${db.json(payload)} where id=${anchor.runEventId}`;
      await expect(f.port.readOrigin()).rejects.toThrow(
        'final_delivery_evidence_unavailable',
      );
    });
    it('reads the committed replacement attempt after a real Job row wait', async () => {
      const f = await fixture();
      await f.startTurn();
      const held = gate(),
        release = gate();
      const writing = database.db.begin(async (tx) => {
        await tx`select id from allrice_jobs where id=${f.worker.jobId} for update`;
        held.resolve();
        await release.promise;
        await tx`update allrice_jobs set attempt=2 where id=${f.worker.jobId}`;
      });
      await held.promise;
      let settled = false;
      const reading = f.port
        .readOrigin()
        .finally(() => {
          settled = true;
        })
        .catch((e) => e);
      await new Promise((r) => setTimeout(r, 30));
      expect(settled).toBe(false);
      release.resolve();
      await writing;
      expect(await reading).toBeInstanceOf(Error);
    });
    it('last-SQL lease expiry rolls back Job, Run, message and succeeded event together', async () => {
      const f = await fixture();
      await f.startTurn();
      const p = await f.issue();
      const before = await f.state();
      const held = gate(),
        release = gate(),
        db = database.db;
      const writing = db.begin(async (tx) => {
        await tx`select m.id from allrice_messages m join allrice_employee_runs er on er.assistant_message_id=m.id where er.run_id=${f.rootRunId} for update of m`;
        held.resolve();
        await release.promise;
      });
      await held.promise;
      await db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '150 milliseconds' where id=${f.worker.jobId}`;
      const completing = f.complete(p.guard).catch((e) => e);
      await new Promise((r) => setTimeout(r, 250));
      release.resolve();
      await writing;
      expect(await completing).toBeInstanceOf(Error);
      expect(await f.state()).toEqual(before);
    });
  },
);
