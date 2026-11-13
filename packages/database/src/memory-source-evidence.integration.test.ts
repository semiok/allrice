/** Isolated synthetic sources only. No model or shared Dev access. */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemorySourceEvidenceSchema } from '@allrice/contracts';
import { parsePersonalSkill } from '@allrice/skill-import';
import { runtimePolicyDigest } from './runtime-policy.ts';
import * as client from './core/client.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import { enableSyntheticMemorySourceCollection } from './memory-source.fixture.ts';
import { approveSyntheticCurrentEmployeeExecution } from './current-execution.fixture.ts';
import { collectPendingMemorySources } from './memory-source-evidence.ts';
import * as sourceScenes from './memory-source-scenes.ts';
import { memorySourceCaptureEnabled } from './memory-source-capture.ts';
import { collectPendingExperienceEvidence } from './experience-evidence.ts';
import {
  markMemorySourcePending,
  memorySourceProducer,
} from './memory-source-capture.ts';
import { createExperienceStore } from './experience.ts';
import { getExperienceOverview } from './experience-overview.ts';
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
      vi.stubEnv('ALLRICE_MEMORY_SOURCE_CAPTURE_ENABLED', '1');
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
      await enableSyntheticMemorySourceCollection(db, f.org);
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
      return db`select * from allrice_memory_sources where capture_run_id=${runId}`;
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
          source_excerpt: text,
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
          ).some((m) => m.id === source.id),
        ).toBe(false);
        expect(await createExperienceStore().list(f.neighbor)).toEqual([]);
        await collectPendingExperienceEvidence({ database: db });
        expect(
          await db`select id from allrice_memories where source_id=${f.messageId}`,
        ).toEqual([]);
        expect(
          await db`select id from allrice_memory_revisions where memory_id=${source.id}`,
        ).toEqual([]);
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
        expect(await rows(f.runId)).toHaveLength(1);
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
        await db`update allrice_settings set value=jsonb_set(value,${mode === 'off' ? '{enabled}' : '{collectionStartedAt}'}::text[],
          ${db.json(mode === 'off' ? false : new Date(Date.now() + 60000).toISOString())})
          where scope_type='organization' and scope_id=${f.org} and key='employee_memory_source_policy'`;
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
        await db`select memory_source_capture_state s from allrice_employee_runs where run_id=${f.runId}`;
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
          prompt_snapshot,execution_snapshot,memory_source_capture_state,memory_source_capture_reason)
        select ${runId},organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,${history!.session_id},
          ${messageId},${assistantId},'succeeded',clock_timestamp(),'{}','{}',
          jsonb_set(execution_snapshot,'{schemaVersion}','0'),'pending',${memorySourceProducer}
        from allrice_employee_runs where run_id=${f.runId}`;
      await collect();
      expect(await rows(runId)).toEqual([]);
      const [run] =
        await db`select memory_source_capture_state s,memory_source_capture_reason r from allrice_employee_runs where run_id=${runId}`;
      expect(run).toEqual({ s: 'ignored', r: 'source_unproven' });
    });
    it('leaves pending provenance untouched while the existing capture feature is disabled', async () => {
      const f = await setup();
      await f.finish();
      vi.stubEnv('ALLRICE_MEMORY_SOURCE_CAPTURE_ENABLED', '0');
      try {
        expect(await collect()).toEqual({ captured: 0, ignored: 0, busy: 0 });
        expect(await rows(f.runId)).toEqual([]);
        const [run] =
          await db`select memory_source_capture_state s,memory_source_capture_reason r from allrice_employee_runs where run_id=${f.runId}`;
        expect(run).toEqual({ s: 'pending', r: memorySourceProducer });
      } finally {
        vi.stubEnv('ALLRICE_MEMORY_SOURCE_CAPTURE_ENABLED', '1');
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
      await db`update allrice_memory_sources set archived_at=now() where id=${source!.id}`;
      // Fault injection simulates an old terminal delivery, never a production reset.
      await db`update allrice_employee_runs set memory_source_capture_state='pending',memory_source_capture_reason=${memorySourceProducer} where run_id=${f.runId}`;
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
    it.each(['attachment', 'policy', 'instance', 'skill'] as const)(
      'allows current %s revocation during capture and rolls back the staged source',
      async (mode) => {
        const f = await setup(undefined, false, mode === 'skill');
        const objectId = randomUUID();
        if (mode === 'attachment') {
          await db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state)
            values(${objectId},${f.org},${f.workspace},${f.user},${'synthetic/' + objectId},'uploads','text/plain',4,${'sha256:' + 'b'.repeat(64)},'ready')`;
          await db`insert into allrice_message_attachments(organization_id,workspace_id,message_id,object_id,attached_by,file_name)
            values(${f.org},${f.workspace},${f.messageId},${objectId},${f.user},'synthetic.txt')`;
        }
        if (mode === 'skill')
          await db`insert into allrice_run_events(id,organization_id,workspace_id,run_id,sequence,event_type,payload)
            values(${randomUUID()},${f.org},${f.workspace},${f.runId},100,'tool.completed',${db.json({ name: 'skill', nativePayload: { skillStatus: 'loaded', personalSkill: f.skill } })})`;
        await f.finish();
        let stagedId: string | undefined;
        const original = sourceScenes.assertMemorySourceScenesAvailable;
        const hook = vi
          .spyOn(sourceScenes, 'assertMemorySourceScenesAvailable')
          .mockImplementation(async (...args) => {
            await original(...args);
            if (args[2] !== f.instanceId) return;
            const [staged] =
              await args[0]`select id from allrice_memory_sources where capture_run_id=${f.runId}`;
            if (!staged) return;
            stagedId = staged.id;
            // A separate transaction must commit before capture ends: no held
            // interactive SHARE lock, no timing sleep, no replacement validator.
            await db.begin(async (tx) => {
              await tx`set local lock_timeout='500ms'`;
              if (mode === 'attachment')
                await tx`update allrice_storage_objects set state='deleted',deleted_at=clock_timestamp() where id=${objectId}`;
              if (mode === 'policy')
                await tx`update allrice_settings set value=jsonb_set(value,'{enabled}','false') where scope_type='organization' and scope_id=${f.org} and key='employee_memory_source_policy'`;
              if (mode === 'instance')
                await tx`update allrice_employee_instances set archived_at=clock_timestamp() where id=${f.instanceId}`;
              if (mode === 'skill')
                await tx`update allrice_personal_skill_bindings set enabled=false,epoch=epoch+1 where id=${f.skill.bindingId}`;
            });
          });
        try {
          await collect();
        } finally {
          hook.mockRestore();
        }
        expect(stagedId).toBeDefined();
        expect(await rows(f.runId)).toEqual([]);
        expect(
          await db`select id from allrice_audit_events where action='memory.source.capture' and resource_id=${stagedId!}`,
        ).toEqual([]);
        const [run] =
          await db`select memory_source_capture_state state,memory_source_capture_reason reason from allrice_employee_runs where run_id=${f.runId}`;
        expect(run).toEqual({
          state: 'ignored',
          reason: 'dependency_unavailable',
        });
      },
    );
    it('uses only the new explicit feature flag, even when legacy collection is enabled', async () => {
      expect(
        memorySourceCaptureEnabled({
          ALLRICE_EXPERIENCE_REVIEW_ENABLED: '1',
          NODE_ENV: 'development',
        }),
      ).toBe(false);
      const f = await setup();
      vi.stubEnv('ALLRICE_MEMORY_SOURCE_CAPTURE_ENABLED', '');
      vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '1');
      try {
        await f.finish();
        expect(await collect()).toEqual({ captured: 0, ignored: 0, busy: 0 });
        const [run] =
          await db`select memory_source_capture_state,experience_capture_state from allrice_employee_runs where run_id=${f.runId}`;
        expect(run).toEqual({
          memory_source_capture_state: null,
          experience_capture_state: null,
        });
        expect(await rows(f.runId)).toEqual([]);
      } finally {
        vi.stubEnv('ALLRICE_MEMORY_SOURCE_CAPTURE_ENABLED', '1');
      }
    });
    it.each(['missing', 'invalid', 'disabled'] as const)(
      'does not inherit the legacy policy when new config is %s',
      async (mode) => {
        const f = await setup();
        if (mode === 'missing')
          await db`delete from allrice_settings where scope_type='organization' and scope_id=${f.org} and key='employee_memory_source_policy'`;
        else
          await db`update allrice_settings set value=${db.json(mode === 'invalid' ? { schemaVersion: 999 } : { schemaVersion: 1, enabled: false, revision: 1, collectionStartedAt: new Date(0).toISOString() })}
        where scope_type='organization' and scope_id=${f.org} and key='employee_memory_source_policy'`;
        await f.finish();
        await collect();
        expect(await rows(f.runId)).toEqual([]);
        const [run] =
          await db`select memory_source_capture_state state,memory_source_capture_reason reason from allrice_employee_runs where run_id=${f.runId}`;
        expect(run).toEqual({ state: 'ignored', reason: 'policy_disabled' });
      },
    );
    it('keeps old source rows and policies out of the empty memory-owned storage', async () => {
      const f = await setup();
      const [count] =
        await db`select count(*)::int count from allrice_memory_sources where organization_id=${f.org}`;
      expect(count!.count).toBe(0);
      expect(
        await db`select id from allrice_memories where source_id=${f.messageId}`,
      ).toEqual([]);
      expect(
        await db`select memory_id from allrice_experience_reviews where evidence->>'captureRunId'=${f.runId}`,
      ).toEqual([]);
    });
  },
);
