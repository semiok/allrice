/** Isolated synthetic sources only. No model or shared Dev access. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemorySourceEvidenceSchema } from '@allrice/contracts';
import * as client from './core/client.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import { approveSyntheticCurrentEmployeeExecution } from './current-execution.fixture.ts';
import { collectPendingMemorySources } from './memory-source-evidence.ts';
import { collectPendingExperienceEvidence } from './experience-evidence.ts';
import {
  markMemorySourcePending,
  memorySourceProducer,
} from './memory-source-capture.ts';
import { createExperienceStore } from './experience.ts';
import {
  createChatSession,
  sendChatMessage,
  listWorkspaceMemories,
} from './workspace/service.ts';
import { createEmployeeInstance } from './employees/employee-instances.ts';
import { startClaimedJob, completeJob } from './execution/queue.ts';
import {
  acquireConversationRuntime,
  bindConversationThread,
  recordConversationTurn,
} from './conversation/conversation-runtime.ts';
import {
  claimConversationSteer,
  consumeConversationSteer,
} from './conversation/conversation-input.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'M5-B structural human provenance, isolated DB and zero model calls',
  () => {
    let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let db: typeof fixture.db;
    beforeAll(async () => {
      fixture = await createRuntimeFixtureDatabase();
      db = fixture.db;
      vi.spyOn(client, 'getDatabase').mockImplementation(() => db);
      approveSyntheticCurrentEmployeeExecution();
      vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '1');
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    });
    const collect = () =>
      collectPendingMemorySources({ database: db, limit: 16 });
    async function setup(
      text = '合成品牌月报入口在资料夹。',
      personal = false,
    ) {
      const f = await createExperienceFixture(db, { authenticated: true });
      const [assignment] =
        await db`select employee_assignment_id id from allrice_employee_runs where run_id=${f.run}`;
      const instance = personal
        ? await createEmployeeInstance(f.owner, {
            workspaceId: f.workspace,
            assignmentId: assignment!.id,
            requestId: randomUUID(),
            profile: { name: 'Synthetic personal' },
          })
        : null;
      const session = await createChatSession(f.owner, {
        workspaceId: f.workspace,
        title: 'Synthetic provenance',
        ...(instance ? { employeeInstanceId: instance.id } : {}),
      });
      const sent = await sendChatMessage(f.owner, f.workspace, session.id, {
        clientMessageId: randomUUID(),
        text,
      });
      const workerId = randomUUID(),
        leaseToken = randomUUID();
      const [job] =
        await db`update allrice_jobs set status='claimed',worker_id=${workerId},lease_token=${leaseToken},
      claimed_at=clock_timestamp(),heartbeat_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '5 minutes'
      where run_id=${sent.run.id} returning id`;
      expect(await startClaimedJob(workerId, job!.id, leaseToken)).toBeTruthy();
      const [run] =
        await db`select user_message_id,execution_snapshot from allrice_employee_runs where run_id=${sent.run.id}`;
      return {
        ...f,
        session,
        runId: sent.run.id,
        messageId: run!.user_message_id as string,
        instanceId: run!.execution_snapshot.instance.id as string,
        workerId,
        leaseToken,
        jobId: job!.id as string,
        finish: () =>
          completeJob({
            workerId,
            jobId: job!.id,
            leaseToken,
            result: {
              text: 'Synthetic assistant summary must not be a source.',
            },
          }),
      };
    }
    async function rows(runId: string) {
      return db`select e.*,m.content,m.lifecycle_state,m.trust_level,m.archived_at from allrice_experience_reviews e
      join allrice_memories m on m.id=e.memory_id where e.evidence->>'captureRunId'=${runId}`;
    }
    it.each([false, true])(
      'captures raw human text without a wordlist; Rice/personal=%s, hidden and not effective',
      async (personal) => {
        const text = '“仅本次”与 remember 是合成测试文字，不是代码的分类信号。';
        const f = await setup(text, personal);
        await f.finish();
        await collect();
        const captured = await rows(f.runId);
        expect(captured).toHaveLength(1);
        const source = captured[0]!;
        expect(source).toMatchObject({
          owner_id: f.user,
          instance_id: f.instanceId,
          content: text,
          source_excerpt: text,
          lifecycle_state: 'candidate',
          trust_level: 'derived',
        });
        expect(source.source_digest).toBe(
          'sha256:' + createHash('sha256').update(text).digest('hex'),
        );
        expect(MemorySourceEvidenceSchema.parse(source.evidence)).toMatchObject(
          {
            schemaVersion: 2,
            kind: 'human_message',
            captureRunId: f.runId,
            runId: f.runId,
            messageId: f.messageId,
            relatedRunId: null,
          },
        );
        expect(await createExperienceStore().list(f.owner)).toEqual([]);
        expect(
          (
            await listWorkspaceMemories(f.owner, f.workspace, undefined, {
              instanceId: f.instanceId,
            })
          ).some((m) => m.id === source.memory_id),
        ).toBe(false);
        expect(await createExperienceStore().list(f.neighbor)).toEqual([]);
        await collectPendingExperienceEvidence({ database: db });
        expect((await rows(f.runId))[0]!.lifecycle_state).toBe('candidate');
      },
    );
    it.each(['failed', 'canceled'] as const)(
      'captures terminal %s without depending on a running Job',
      async (state) => {
        const f = await setup();
        await db`update allrice_jobs set status=${state},completed_at=now() where id=${f.jobId}`;
        await db`update allrice_employee_runs set status=${state},completed_at=now() where run_id=${f.runId}`;
        await db.begin((tx) => markMemorySourcePending(tx, f.runId));
        await collect();
        expect(await rows(f.runId)).toHaveLength(1);
      },
    );
    it.each(['pending', 'ignored', 'captured'] as const)(
      'never reclassifies old %s markers',
      async (state) => {
        const f = await setup();
        await db`update allrice_employee_runs set experience_capture_state=${state},experience_capture_reason='old_reason' where run_id=${f.runId}`;
        await f.finish();
        await collect();
        expect(await rows(f.runId)).toEqual([]);
        const [run] =
          await db`select experience_capture_state s,experience_capture_reason r from allrice_employee_runs where run_id=${f.runId}`;
        expect(run).toEqual({ s: state, r: 'old_reason' });
      },
    );
    it.each([
      'watermark',
      'off',
      'membership',
      'assignment',
      'instance',
      'session',
      'message',
      'method',
      'quality',
      'child',
      'oversize',
    ])('does not capture an ineligible source: %s', async (mode) => {
      const f = await setup(mode === 'oversize' ? 'x'.repeat(4001) : undefined);
      await f.finish();
      if (mode === 'watermark' || mode === 'off')
        await db`insert into allrice_settings(scope_type,scope_id,key,value)
          select 'organization',${f.org},key,jsonb_set(value,${mode === 'off' ? '{frequency}' : '{collectionStartedAt}'}::text[],
            ${db.json(mode === 'off' ? 'off' : new Date(Date.now() + 60000).toISOString())})
          from allrice_settings where scope_type='system' and key='employee_experience_policy'`;
      if (mode === 'membership')
        await db`update allrice_memberships set active=false where user_id=${f.user}`;
      if (mode === 'assignment')
        await db`update allrice_employee_assignments set active=false where id=${f.instanceId}`;
      if (mode === 'instance')
        await db`update allrice_employee_instances set archived_at=now() where id=${f.instanceId}`;
      if (mode === 'session')
        await db`update allrice_chat_sessions set archived_at=now() where id=${f.session.id}`;
      if (mode === 'message')
        await db`update allrice_messages set role='assistant' where id=${f.messageId}`;
      if (mode === 'method')
        await db`update allrice_employee_runs set method_authoring=true where run_id=${f.runId}`;
      if (mode === 'quality')
        await db`insert into allrice_platform_quality_checks(id,request_id,organization_id,workspace_id,owner_id,run_id,job_id,session_id,input_digest,frozen)
        values(${randomUUID()},${randomUUID()},${f.org},${f.workspace},${f.user},${f.runId},${f.jobId},${f.session.id},${'sha256:' + 'a'.repeat(64)},'{}')`;
      if (mode === 'child') {
        const root = await setup();
        await db`update allrice_runtime_run_links set root_run_id=${root.runId},parent_run_id=${root.runId} where run_id=${f.runId}`;
      }
      await collect();
      expect(await rows(f.runId)).toEqual([]);
      const [run] =
        await db`select experience_capture_state s from allrice_employee_runs where run_id=${f.runId}`;
      expect(run!.s).toBe('ignored');
    });
    it('is idempotent under concurrent collection and keeps an archived source tombstone', async () => {
      const f = await setup();
      await f.finish();
      await Promise.all([collect(), collect()]);
      const [source] = await rows(f.runId);
      expect(source).toBeDefined();
      expect(await rows(f.runId)).toHaveLength(1);
      await db`update allrice_memories set archived_at=now() where id=${source!.memory_id}`;
      // Fault injection simulates an old terminal delivery, never a production reset.
      await db`update allrice_employee_runs set experience_capture_state='pending',experience_capture_reason=${memorySourceProducer} where run_id=${f.runId}`;
      await collect();
      const captured = await rows(f.runId);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.archived_at).not.toBeNull();
    });
    it.each(['adopted', 'wrong_run', 'wrong_input', 'method'] as const)(
      'uses exact native steering adoption: %s',
      async (mode) => {
        const f = await setup();
        const runtime = {
          organizationId: f.org,
          workspaceId: f.workspace,
          sessionId: f.session.id,
          ownerId: f.user,
          runId: f.runId,
          workerId: f.workerId,
        };
        await acquireConversationRuntime({
          ...runtime,
          configChecksum: 'sha256:' + 'a'.repeat(64),
          compactThresholdTokens: 10000,
        });
        const threadId = 'native-' + randomUUID(),
          turnId = 'turn-' + randomUUID();
        await bindConversationThread({ ...runtime, threadId });
        const binding = await recordConversationTurn({
          ...runtime,
          threadId,
          turnId,
        });
        await sendChatMessage(f.owner, f.workspace, f.session.id, {
          clientMessageId: randomUUID(),
          text: '合成的补充资料。',
          deliveryMode: 'steer',
          expectedTurnId: turnId,
          expectedGeneration: binding.generation,
        });
        const command = await claimConversationSteer({
          ...runtime,
          generation: binding.generation,
          turnId,
        });
        expect(command).not.toBeNull();
        await consumeConversationSteer({
          commandId: command!.id,
          workerId: f.workerId,
          proof: {
            status: 'adopted',
            inputId: command!.clientUserMessageId,
            messageId: randomUUID(),
            turnId,
            sequence: 5,
            checkpoint: 'step_user_message',
          },
        });
        await collect();
        expect(await rows(command!.followupRunId)).toEqual([]);
        if (mode === 'wrong_run' || mode === 'wrong_input')
          await db`update allrice_conversation_commands set native_proof=jsonb_set(native_proof,
        ${mode === 'wrong_run' ? '{runId}' : '{inputId}'}::text[],${db.json(randomUUID())}) where id=${command!.id}`;
        if (mode === 'method')
          await db`update allrice_employee_runs set method_authoring=true where run_id=${f.runId}`;
        await f.finish();
        await collect();
        const captured = await rows(command!.followupRunId);
        expect(captured).toHaveLength(mode === 'adopted' ? 1 : 0);
        if (mode === 'adopted')
          expect(captured[0]!.evidence).toMatchObject({
            kind: 'adopted_steering',
            runId: f.runId,
          });
      },
    );
    it('cutover advances only the existing watermark/revision and preserves policy choices and old markers', async () => {
      const f = await setup();
      await db`update allrice_employee_runs set experience_capture_state='ignored',experience_capture_reason='policy_disabled' where run_id=${f.runId}`;
      await db`insert into allrice_settings(scope_type,scope_id,key,value)
      select 'organization',${f.org},key,jsonb_set(value,'{frequency}','"off"') from allrice_settings
      where scope_type='system' and key='employee_experience_policy'`;
      const [before] =
        await db`select value from allrice_settings where scope_type='organization' and scope_id=${f.org} and key='employee_experience_policy'`;
      await db.unsafe(
        await readFile(
          new URL(
            '../migrations/0233_memory_source_cutover.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      const [after] =
        await db`select value from allrice_settings where scope_type='organization' and scope_id=${f.org} and key='employee_experience_policy'`;
      expect(after!.value).toEqual({
        ...before!.value,
        revision: before!.value.revision + 1,
        collectionStartedAt: after!.value.collectionStartedAt,
      });
      expect(
        Date.parse(after!.value.collectionStartedAt),
      ).toBeGreaterThanOrEqual(Date.parse(before!.value.collectionStartedAt));
      await f.finish();
      await collect();
      expect(await rows(f.runId)).toEqual([]);
    });
  },
);
