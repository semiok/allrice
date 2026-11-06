/** Isolated synthetic sources only. No model or shared Dev access. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemorySourceEvidenceSchema } from '@allrice/contracts';
import { parsePersonalSkill } from '@allrice/skill-import';
import { runtimePolicyDigest } from './runtime-policy.ts';
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
import { getExperienceOverview } from './experience-overview.ts';
import {
  readExperiencePolicy,
  updateExperiencePolicy,
} from './experience-consolidation.ts';
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
      withSkill = false,
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
      if (withSkill) {
        const { definition, originalText } = await parsePersonalSkill(
          Buffer.from(
            '---\nname: synthetic-source\ndescription: Synthetic provenance fixture.\n---\nKeep original identifiers.\n',
          ),
        );
        const installation = randomUUID(),
          version = randomUUID();
        await db.begin(async (tx) => {
          await tx`insert into allrice_personal_skill_installations(id,organization_id,owner_id,name,state,current_version_id)
            values(${installation},${f.org},${f.user},${definition.name},'installed',${version})`;
          await tx`insert into allrice_personal_skill_versions(id,organization_id,owner_id,installation_id,version,source,original_text,definition,definition_checksum)
            values(${version},${f.org},${f.user},${installation},1,'{}',${originalText},${tx.json(definition)},${runtimePolicyDigest(definition)})`;
          await tx`insert into allrice_personal_skill_bindings(organization_id,workspace_id,owner_id,instance_id,installation_id,enabled)
            values(${f.org},${f.workspace},${f.user},${instance?.id ?? assignment!.id},${installation},true)`;
        });
      }
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
        skill: run!.execution_snapshot.personalSkills?.skills[0],
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
          (await getExperienceOverview(f.owner, f.instanceId)).summary.counts,
        ).toMatchObject({ pendingSources: 0, awaitingValidation: 0 });
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
    it.each(['ready', 'deleted', 'other_owner', 'expired'] as const)(
      'keeps file identities and rejects revoked file dependencies: %s',
      async (mode) => {
        const f = await setup(),
          objectId = randomUUID();
        await db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state,deleted_at)
        values(${objectId},${f.org},${f.workspace},${mode === 'other_owner' ? f.neighbor.actor.id : f.user},${'synthetic/' + objectId},'uploads','text/plain',4,${'sha256:' + 'a'.repeat(64)},${mode === 'deleted' ? 'deleted' : 'ready'},${mode === 'deleted' ? new Date() : null})`;
        if (mode === 'expired')
          await db`update allrice_storage_objects set created_at=now()-interval '2 days',retention_until=now()-interval '1 day' where id=${objectId}`;
        await db`insert into allrice_message_attachments(organization_id,workspace_id,message_id,object_id,attached_by,file_name)
        values(${f.org},${f.workspace},${f.messageId},${objectId},${f.user},'synthetic.txt')`;
        await f.finish();
        await collect();
        const captured = await rows(f.runId);
        expect(captured).toHaveLength(mode === 'ready' ? 1 : 0);
        if (mode === 'ready')
          expect(captured[0]!.evidence.inputs).toEqual([
            {
              messageId: f.messageId,
              objectId,
              checksum: 'sha256:' + 'a'.repeat(64),
            },
          ]);
      },
    );
    it.each(['loaded', 'revoked_loaded', 'revoked_unloaded'] as const)(
      'uses actual successful frozen Skill evidence: %s',
      async (mode) => {
        const f = await setup(undefined, false, true);
        expect(f.skill).toBeDefined();
        if (mode !== 'revoked_unloaded')
          await db`insert into allrice_run_events(id,organization_id,workspace_id,run_id,sequence,event_type,payload)
        values(${randomUUID()},${f.org},${f.workspace},${f.runId},100,'tool.completed',${db.json({ name: 'skill', nativePayload: { skillStatus: 'loaded', personalSkill: f.skill } })})`;
        await f.finish();
        if (mode !== 'loaded')
          await db`update allrice_personal_skill_bindings set enabled=false,epoch=epoch+1 where id=${f.skill.bindingId}`;
        await collect();
        const captured = await rows(f.runId);
        expect(captured).toHaveLength(mode === 'revoked_loaded' ? 0 : 1);
        if (mode === 'loaded')
          expect(captured[0]!.evidence.skills[0].pin).toEqual(f.skill);
        if (mode === 'revoked_unloaded')
          expect(captured[0]!.evidence.skills).toEqual([]);
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
      'message_owner',
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
      if (mode === 'message_owner')
        await db`update allrice_messages set owner_id=${f.neighbor.actor.id} where id=${f.messageId}`;
      if (mode === 'method')
        await db`update allrice_employee_runs set method_authoring=true where run_id=${f.runId}`;
      if (mode === 'quality')
        await db`insert into allrice_platform_quality_checks(id,request_id,organization_id,workspace_id,owner_id,run_id,job_id,session_id,input_digest,frozen)
        values(${randomUUID()},${randomUUID()},${f.org},${f.workspace},${f.user},${f.runId},${f.jobId},${f.session.id},${'sha256:' + 'a'.repeat(64)},'{}')`;
      if (mode === 'child') {
        // Ordinary no-tool roots have no operation ledger. A recorded child
        // relationship must still reject the source, within the same tenant.
        await db`insert into allrice_runtime_roots(root_run_id,organization_id,workspace_id,task,deadline_at)
          values(${f.run},${f.org},${f.workspace},'{}',now()+interval '1 hour')`;
        await db`insert into allrice_runtime_run_links(run_id,root_run_id,parent_run_id,organization_id,workspace_id,task)
          values(${f.run},${f.run},null,${f.org},${f.workspace},'{}'),
            (${f.runId},${f.run},${f.run},${f.org},${f.workspace},'{}')`;
      }
      await collect();
      expect(await rows(f.runId)).toEqual([]);
      const [run] =
        await db`select experience_capture_state s from allrice_employee_runs where run_id=${f.runId}`;
      expect(run!.s).toBe('ignored');
    });
    it('rejects a historical source with an unknown execution snapshot', async () => {
      const f = await setup();
      await f.finish();
      const runId = randomUUID(),
        messageId = randomUUID(),
        assistantId = randomUUID();
      const [history] =
        await db`select session_id from allrice_employee_runs where run_id=${f.run}`;
      // Old records can have an unrecognized snapshot. Insert that historical
      // shape directly; never disable the immutable-snapshot trigger or mutate
      // a Run admitted through the current API.
      await db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content,status)
        values(${messageId},${f.org},${f.workspace},${history!.session_id},${f.user},'user','{"text":"Synthetic legacy source"}','completed'),
          (${assistantId},${f.org},${f.workspace},${history!.session_id},${f.user},'assistant','{"text":"Synthetic legacy result"}','completed')`;
      await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
        values(${runId},${f.org},${f.workspace},${f.user},'succeeded','{}','{}')`;
      await db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,
          employee_version_id,session_id,user_message_id,assistant_message_id,status,completed_at,provider_snapshot,
          prompt_snapshot,execution_snapshot,experience_capture_state,experience_capture_reason)
        select ${runId},organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,${history!.session_id},
          ${messageId},${assistantId},'succeeded',clock_timestamp(),'{}','{}',
          jsonb_set(execution_snapshot,'{schemaVersion}','0'),'pending',${memorySourceProducer}
        from allrice_employee_runs where run_id=${f.runId}`;
      await collect();
      expect(await rows(runId)).toEqual([]);
      const [run] =
        await db`select experience_capture_state s,experience_capture_reason r from allrice_employee_runs where run_id=${runId}`;
      expect(run).toEqual({ s: 'ignored', r: 'source_unproven' });
    });
    it('leaves pending provenance untouched while the existing capture feature is disabled', async () => {
      const f = await setup();
      await f.finish();
      vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '0');
      try {
        expect(await collect()).toEqual({ captured: 0, ignored: 0, busy: 0 });
        expect(await rows(f.runId)).toEqual([]);
        const [run] =
          await db`select experience_capture_state s,experience_capture_reason r from allrice_employee_runs where run_id=${f.runId}`;
        expect(run).toEqual({ s: 'pending', r: memorySourceProducer });
      } finally {
        vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '1');
      }
      await collect();
      expect(await rows(f.runId)).toHaveLength(1);
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
    it.each([
      'adopted',
      'adopted_new_turn',
      'wrong_run',
      'wrong_input',
      'method',
    ] as const)('uses exact native steering adoption: %s', async (mode) => {
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
          turnId: mode === 'adopted_new_turn' ? 'adopted-' + turnId : turnId,
          ...(mode === 'adopted_new_turn' ? { runId: f.runId } : {}),
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
      expect(captured).toHaveLength(
        mode === 'adopted' || mode === 'adopted_new_turn' ? 1 : 0,
      );
      if (mode === 'adopted' || mode === 'adopted_new_turn')
        expect(captured[0]!.evidence).toMatchObject({
          kind: 'adopted_steering',
          runId: f.runId,
        });
    });
    it('never turns a concurrently deleted attachment into missing provenance', async () => {
      const f = await setup(),
        objectId = randomUUID();
      await db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state)
        values(${objectId},${f.org},${f.workspace},${f.user},${'synthetic/' + objectId},'uploads','text/plain',4,${'sha256:' + 'b'.repeat(64)},'ready')`;
      await db`insert into allrice_message_attachments(organization_id,workspace_id,message_id,object_id,attached_by,file_name)
        values(${f.org},${f.workspace},${f.messageId},${objectId},${f.user},'synthetic.txt')`;
      await f.finish();
      let release!: () => void, held!: (pid: number) => void;
      const hold = new Promise<void>((r) => {
        release = r;
      });
      const ready = new Promise<number>((r) => {
        held = r;
      });
      const deleting = db.begin(async (tx) => {
        await tx`update allrice_storage_objects set state='deleted',deleted_at=now() where id=${objectId}`;
        const [backend] = await tx<
          { pid: number }[]
        >`select pg_backend_pid() pid`;
        held(backend!.pid);
        await hold;
      });
      const pid = await ready;
      let finished = false;
      const capture = collect().finally(() => {
        finished = true;
      });
      void capture.catch(() => {});
      try {
        // A legitimate 100ms lock timeout is also safe: it must preserve the
        // marker for the next existing tick, never commit an empty dependency.
        await expect
          .poll(
            async () =>
              finished ||
              (
                await db`select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))`
              ).length > 0,
            { timeout: 2000, interval: 5 },
          )
          .toBe(true);
      } finally {
        release();
        await deleting;
      }
      const result = await capture;
      expect(result.captured).toBe(0);
      if (result.busy) await collect();
      expect(await rows(f.runId)).toEqual([]);
      const [run] =
        await db`select experience_capture_state s,experience_capture_reason r from allrice_employee_runs where run_id=${f.runId}`;
      expect(run).toEqual({ s: 'ignored', r: 'dependency_unavailable' });
    });
    it('serializes capture against the first organization policy override using the existing writer lock', async () => {
      const f = await setup();
      await f.finish();
      const policy = await readExperiencePolicy(f.org, db, false);
      let release!: () => void, held!: (pid: number) => void;
      const hold = new Promise<void>((r) => {
        release = r;
      });
      const ready = new Promise<number>((r) => {
        held = r;
      });
      const blocker = db.begin(async (tx) => {
        await tx`select id from allrice_organizations where id=${f.org} for update`;
        const [backend] = await tx<
          { pid: number }[]
        >`select pg_backend_pid() pid`;
        held(backend!.pid);
        await hold;
      });
      const pid = await ready;
      const closing = updateExperiencePolicy(f.reviewer, f.org, {
        expectedRevision: policy.revision,
        frequency: 'off',
        timezone: 'Asia/Shanghai',
        time: '03:00',
        weekday: 1,
        monthDay: 1,
      });
      // Preserve rejection while the real writer is blocked; do not fake a
      // policy read or write the override through a test-only production seam.
      void closing.catch(() => {});
      try {
        await expect
          .poll(
            async () =>
              (
                await db`select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))`
              ).length,
            { timeout: 2000, interval: 10 },
          )
          .toBeGreaterThan(0);
        expect(await collect()).toMatchObject({ captured: 0, busy: 1 });
        expect(await rows(f.runId)).toEqual([]);
      } finally {
        release();
        await blocker;
      }
      await closing;
      await collect();
      expect(await rows(f.runId)).toEqual([]);
      const [run] =
        await db`select experience_capture_state s,experience_capture_reason r from allrice_employee_runs where run_id=${f.runId}`;
      expect(run).toEqual({ s: 'ignored', r: 'policy_disabled' });
    });
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
            '../migrations/0234_memory_source_cutover.sql',
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
