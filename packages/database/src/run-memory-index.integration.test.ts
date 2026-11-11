// @ts-expect-error The shared real DSH Host fixture is JavaScript.
import * as NativeHost from '../../../apps/worker/test/native-subagent/fixture.mjs';
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  readDshToolResult,
  renderMemoryDetailV2,
  type ExecutionContext,
  type RunMemoryContextV2State,
} from '@allrice/contracts';
import * as client from './core/client.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createRunAuthorityFixture } from './run-authority.fixture.ts';
import { ensureGeneralEmployeeInstance } from './employees/employee-instances.ts';
import { freezeEmployeeMemoryIndexV2 } from './employees/employee-documents.ts';
import {
  employeeMemoryCounts,
  listPersonalEmployeeMemories,
} from './employee-memory-management.ts';
import {
  assertRunMemoryContextCurrent,
  prepareRunMemoryContext,
  readRunMemoryContext,
  readRunMemoryOrdinal,
} from './run-memory-context.ts';
import { readRunExperienceSource } from './run-experience-source.ts';
import { executeRiceTool } from '../../../apps/worker/src/tool-broker.ts';
import { createEmployeeAdministrationFixture } from './employee-administration.fixture.ts';
import { savePlatformEmployeeDraft } from './employees/platform-employees.ts';
import { contextCheckpointChecksum } from './conversation/conversation-checkpoint.ts';
import { authenticateSession, createSession } from './identity.ts';
import {
  createChatSession,
  getEmployeeWorkspace,
  sendChatMessage,
  createPersonalEmployeeMemory,
} from './workspace/service.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'v2 memory: actual frozen Run, complete ordinal disclosure and native text',
  () => {
    let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    beforeAll(async () => {
      fixture = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      await fixture?.close();
    });
    type Pair = { summary: string; details: string | null };
    const defaultPair: Pair = {
      summary: '财务日报用公司模板',
      details: '月结前不得外发。',
    };
    async function setup(pairs: Pair[] = [defaultPair], allowed = true) {
      let projection: Awaited<ReturnType<typeof freezeEmployeeMemoryIndexV2>>;
      const f = await createRunAuthorityFixture(fixture.db, {
        toolNames: allowed
          ? ['workspace.memory.read']
          : ['workspace.file.read'],
        allowedTools: allowed ? ['workspace.memory.read'] : [],
        memoryContextStateV2: () => projection.memoryContextStateV2,
        preparePrompt: async (transaction, who) => {
          const tx = transaction as unknown as TransactionSql;
          await ensureGeneralEmployeeInstance(tx, who.employeeAssignmentId);
          const [assignment] =
            await tx`select employee_id from allrice_employee_assignments where id=${who.employeeAssignmentId}`;
          for (const pair of pairs) {
            const id = randomUUID();
            await tx`insert into allrice_memories(id,organization_id,workspace_id,owner_id,instance_id,employee_id,
            content,summary,details,visibility,source_type,lifecycle_state,trust_level)
            values(${id},${who.organizationId},${who.workspaceId},${who.userId},${who.employeeAssignmentId},${assignment!.employee_id},
              ${pair.summary},${pair.summary},${pair.details},'private','user','durable','user_confirmed')`;
            await tx`insert into allrice_memory_revisions(organization_id,workspace_id,memory_id,revision,
            content,summary,details,trust_level,lifecycle_state,memory_class,confidence,reason,changed_by)
            values(${who.organizationId},${who.workspaceId},${id},1,${pair.summary},${pair.summary},${pair.details},
              'user_confirmed','durable','work_note',1,'synthetic owner confirmation',${who.userId})`;
          }
          projection = await freezeEmployeeMemoryIndexV2(
            tx,
            {
              organizationId: who.organizationId,
              workspaceId: who.workspaceId,
              ownerId: who.userId,
              instanceId: who.employeeAssignmentId,
              employeeId: assignment!.employee_id as string,
            },
            {},
          );
          return {
            systemPrompt: 'Synthetic memory policy',
            conversation: [],
            memories: [],
            employeeDocuments: projection.employeeDocuments,
            userRequest: '请按财务日报规则整理结果。',
          };
        },
      });
      await fixture.db`update allrice_employee_runs set status='running' where run_id=${f.rootRunId}`;
      const [job] =
        await fixture.db`select attempt from allrice_jobs where id=${f.worker.jobId}`;
      const scope = {
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        sessionId: f.session,
        runId: f.rootRunId,
      };
      const auth = {
        scope,
        worker: { ...f.worker, attempt: job!.attempt as number },
      };
      const execution: ExecutionContext = {
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
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          memberships: [],
          grants: [
            {
              resourceType: 'memory',
              action: 'resource:read',
              workspaceId: f.workspace,
            },
          ],
        },
      };
      return { ...f, auth, execution, projection: projection! };
    }
    async function state(runId: string) {
      const [row] =
        await fixture.db`select memory_context_state from allrice_employee_runs where run_id=${runId}`;
      return row!.memory_context_state as RunMemoryContextV2State;
    }
    async function changeState(
      runId: string,
      change: (
        value: RunMemoryContextV2State,
      ) => RunMemoryContextV2State | { schemaVersion: 1; pending: true } | null,
    ) {
      await fixture.db`update allrice_employee_runs set memory_context_state=${fixture.db.json(change(await state(runId)))} where run_id=${runId}`;
    }

    it('freezes a real owner chat at queue INSERT and preserves it on duplicate submission', async () => {
      const source = await createEmployeeAdministrationFixture(fixture.db);
      await savePlatformEmployeeDraft(source.employeeId, {
        definition: {
          ...source.definition,
          capabilities: {
            ...source.definition.capabilities,
            toolNames: ['workspace.skill.read', 'workspace.memory.search'],
          },
        },
      });
      await source.preview();
      expect((await source.publish()).valid).toBe(true);
      const context = (await authenticateSession(
        (await createSession(source.ownerId)).token,
        {
          organizationId: source.organizationId,
          workspaceId: source.workspaceId,
        },
      ))!;
      const assignment = (
        await getEmployeeWorkspace(context, source.workspaceId)
      ).employees.find(
        (entry) =>
          entry.currentVersion.manifest.schemaVersion === 2 &&
          entry.currentVersion.manifest.runtimePackage?.skills.some(
            (skill) => skill.id === source.skillId,
          ),
      )!;
      await ensureGeneralEmployeeInstance(fixture.db, assignment.id);
      const memory = await createPersonalEmployeeMemory(context, {
        workspaceId: source.workspaceId,
        instanceId: assignment.id,
        idempotencyKey: randomUUID(),
        ...defaultPair,
      });
      const session = await createChatSession(context, {
        workspaceId: source.workspaceId,
        employeeInstanceId: assignment.id,
        title: 'Memory index admission',
      });
      const input = {
        text: '请按我的财务日报规则整理今天的记录。',
        clientMessageId: randomUUID(),
      };
      const sent = await sendChatMessage(
        context,
        source.workspaceId,
        session.id,
        input,
      );
      const [saved] =
        await fixture.db`select prompt_snapshot,execution_snapshot,memory_context_state from allrice_employee_runs where run_id=${sent.run.id}`;
      expect(saved!.prompt_snapshot.memories).toEqual([]);
      expect(saved!.prompt_snapshot.employeeDocuments.schemaVersion).toBe(2);
      expect(JSON.stringify(saved!.prompt_snapshot)).not.toContain(
        defaultPair.details,
      );
      expect(saved!.memory_context_state.pins).toEqual([
        {
          number: 1,
          id: memory.id,
          revision: memory.revision,
          pairDigest: memory.pairDigest,
          hasDetails: true,
        },
      ]);
      expect(saved!.memory_context_state.spentBytes).toBe(
        Buffer.byteLength(saved!.prompt_snapshot.employeeDocuments.memory),
      );
      expect(
        saved!.execution_snapshot.capabilitySnapshot.bindings.toolNames,
      ).toContain('workspace.memory.read');
      expect(
        saved!.execution_snapshot.capabilitySnapshot.bindings.toolNames,
      ).not.toContain('workspace.memory.search');
      const replay = await sendChatMessage(
        context,
        source.workspaceId,
        session.id,
        input,
      );
      expect(replay.run.id).toBe(sent.run.id);
      expect(await state(sent.run.id)).toEqual(saved!.memory_context_state);
      const failedSession = await createChatSession(context, {
        workspaceId: source.workspaceId,
        employeeInstanceId: assignment.id,
        title: 'Synthetic queue rollback',
      });
      const queueState = async () =>
        (
          await fixture.db`select
        (select count(*) from allrice_runs where workspace_id=${source.workspaceId}) runs,
        (select count(*) from allrice_jobs where workspace_id=${source.workspaceId}) jobs,
        (select count(*) from allrice_employee_runs where workspace_id=${source.workspaceId}) employee_runs,
        (select count(*) from allrice_policy_snapshots where organization_id=${source.organizationId} and subject_id=${source.ownerId}) policies,
        (select count(*) from allrice_task_clocks where workspace_id=${source.workspaceId}) task_clocks,
        (select count(*) from allrice_conversation_followups where session_id=${failedSession.id}) followups,
        (select count(*) from allrice_conversation_commands where session_id=${failedSession.id}) commands,
        (select coalesce(jsonb_agg(jsonb_build_object('runId',r.run_id,'state',r.memory_context_state) order by r.run_id),'[]')
          from allrice_employee_runs r where r.workspace_id=${source.workspaceId}) memory_states,
        (select coalesce(jsonb_agg(to_jsonb(r)),'[]') from allrice_conversation_runtimes r where r.session_id=${failedSession.id}) runtime`
        )[0];
      const beforeFailure = await queueState();
      const failedInput = { ...input, clientMessageId: randomUUID() };
      await fixture.db`create function fail_memory_queue_insert() returns trigger language plpgsql as $$ begin
        if new.prompt_snapshot#>>'{employeeDocuments,schemaVersion}' is distinct from '2'
          or new.memory_context_state->>'schemaVersion' is distinct from '2' then
          raise exception 'fixture_v2_projection_missing'; end if;
        raise exception 'synthetic_memory_queue_failure'; end $$`;
      await fixture.db`create trigger fail_memory_queue_insert before insert on allrice_employee_runs
        for each row execute function fail_memory_queue_insert()`;
      try {
        await expect(
          sendChatMessage(
            context,
            source.workspaceId,
            failedSession.id,
            failedInput,
          ),
        ).rejects.toThrow('synthetic_memory_queue_failure');
        expect(await queueState()).toEqual(beforeFailure);
        // Message persistence precedes queue admission. Its durable input and
        // failed assistant receipt survive; only queue-owned writes roll back.
        const messages =
          await fixture.db`select * from allrice_messages where session_id=${failedSession.id}`;
        expect(messages).toHaveLength(2);
        const human = messages.find((row) => row.role === 'user');
        expect(human).toMatchObject({
          owner_id: source.ownerId,
          status: 'completed',
          client_message_id: failedInput.clientMessageId,
          content: { text: failedInput.text, citations: [] },
          completed_at: expect.any(Date),
        });
        expect(messages.find((row) => row.role === 'assistant')).toMatchObject({
          owner_id: source.ownerId,
          reply_to_id: human!.id,
          status: 'failed',
          error_code: 'EMPLOYEE_ENQUEUE_FAILED',
          completed_at: expect.any(Date),
          content: {
            text: 'Rice 暂时无法开始这次执行，请稍后重试。',
            citations: [],
          },
        });
        const receipts =
          await fixture.db`select * from allrice_chat_input_requests where session_id=${failedSession.id}`;
        expect(receipts).toEqual([
          expect.objectContaining({
            user_message_id: human!.id,
            client_message_id: failedInput.clientMessageId,
            owner_id: source.ownerId,
            kind: 'message',
            request_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          }),
        ]);
        expect(
          await fixture.db`select id from allrice_audit_events where resource_id=${human!.id} and action='message.create'`,
        ).toHaveLength(1);
        expect(
          await fixture.db`select run_id from allrice_employee_runs where user_message_id=${human!.id}`,
        ).toHaveLength(0);
        const [activity] =
          await fixture.db`select owner_id,employee_assignment_id,employee_instance_id,updated_at
          from allrice_chat_sessions where id=${failedSession.id}`;
        expect(activity).toMatchObject({
          owner_id: source.ownerId,
          employee_assignment_id: assignment.id,
          employee_instance_id: assignment.id,
        });
        expect(activity!.updated_at.getTime()).toBeGreaterThanOrEqual(
          new Date(failedSession.updatedAt).getTime(),
        );
      } finally {
        await fixture.db`drop trigger fail_memory_queue_insert on allrice_employee_runs`;
        await fixture.db`drop function fail_memory_queue_insert()`;
      }
    }, 120000);

    it('uses exactly the management/quota ordinary set at100 and refuses a whole over-budget detail', async () => {
      const pair = { summary: '🧑'.repeat(40), details: '🧑'.repeat(2000) };
      const f = await setup(Array.from({ length: 100 }, () => pair));
      expect(f.projection.memoryContextStateV2.pins).toHaveLength(100);
      expect(f.projection.memoryContextStateV2.initial.bytes).toBe(18303);
      expect(f.projection.employeeDocuments.memory).toContain(
        `[100] ${pair.summary}（有说明）`,
      );
      expect(JSON.stringify(f.projection)).not.toContain(pair.details);
      const scope = {
        ...f.auth.scope,
        instanceId: f.assignment,
        employeeId: f.employee,
      };
      // Synthetic first-INSERT fixtures for every excluded category; no
      // classification trigger or source/permission gate is disabled.
      await fixture.db`insert into allrice_memories(organization_id,workspace_id,owner_id,instance_id,employee_id,
        content,summary,visibility,source_type,lifecycle_state,trust_level)
        select ${f.org},${f.workspace},${f.user},${f.assignment},${f.employee},'待确认','待确认','private','user','candidate','derived'
        from generate_series(1,73)`;
      const excluded = Array.from({ length: 9 }, () => randomUUID());
      await fixture.db`insert into allrice_memories(id,organization_id,workspace_id,owner_id,instance_id,employee_id,
        content,summary,visibility,source_type,lifecycle_state,trust_level,captured_at)
        select id,${f.org},${f.workspace},${f.user},${f.assignment},${f.employee},'隔离规则','隔离规则','private','user','durable','user_confirmed',clock_timestamp()-interval '2 days'
        from unnest(${excluded}::uuid[]) id`;
      await fixture.db`update allrice_memories set archived_at=now() where id=${excluded[0]!}`;
      await fixture.db`update allrice_memories set expires_at=clock_timestamp()-interval '1 day' where id=${excluded[1]!}`;
      await fixture.db`update allrice_memories set visibility='workspace' where id=${excluded[2]!}`;
      await fixture.db`update allrice_memories set employee_id=null where id=${excluded[3]!}`;
      const [source] =
        await fixture.db`select * from allrice_employee_runs where run_id=${f.rootRunId}`;
      for (const [i, status] of ['pending', 'approved'].entries()) {
        await fixture.db`insert into allrice_experience_reviews(memory_id,organization_id,workspace_id,owner_id,client_request_id,
          request_digest,run_id,session_id,message_id,source_excerpt,source_digest,proposed_digest,requested_scope,share_acknowledged,
          status,reviewed_by,reviewed_at,review_reason)
          values(${excluded[4 + i]!},${f.org},${f.workspace},${f.user},${randomUUID()},${'sha256:' + 'a'.repeat(64)},${f.rootRunId},${f.session},
            ${source!.user_message_id},'Synthetic review',${'sha256:' + 'b'.repeat(64)},${'sha256:' + 'c'.repeat(64)},'private',false,
            ${status},${status === 'approved' ? f.user : null},${status === 'approved' ? new Date() : null},${status === 'approved' ? 'Synthetic approval' : null})`;
      }
      const brand = randomUUID(),
        context = randomUUID(),
        retrospective = randomUUID();
      await fixture.db.begin(async (tx) => {
        await tx`insert into allrice_brand_content_brands(id,organization_id,workspace_id,owner_id,instance_id,name,revision,current_context_id)
          values(${brand},${f.org},${f.workspace},${f.user},${f.assignment},'Synthetic brand',1,${context})`;
        await tx`insert into allrice_brand_content_contexts(id,organization_id,workspace_id,owner_id,instance_id,brand_id,number,brand_name,content,digest)
          values(${context},${f.org},${f.workspace},${f.user},${f.assignment},${brand},1,'Synthetic brand','{}',${'sha256:' + 'd'.repeat(64)})`;
        await tx`insert into allrice_brand_content_retrospectives(id,organization_id,workspace_id,owner_id,instance_id,brand_id,context_id,platform,
          feedback_ids,output,source_text,run_id,session_id,workflow)
          values(${retrospective},${f.org},${f.workspace},${f.user},${f.assignment},${brand},${context},'synthetic',${[randomUUID()]}::uuid[],
            '{}','Synthetic source',${f.rootRunId},${f.session},'{}')`;
        await tx`insert into allrice_brand_content_experiences(memory_id,organization_id,workspace_id,owner_id,instance_id,brand_id,retrospective_id,context_id,platform)
          values(${excluded[6]!},${f.org},${f.workspace},${f.user},${f.assignment},${brand},${retrospective},${context},'synthetic')`;
      });
      const methodRun = randomUUID(),
        userMessage = randomUUID(),
        assistantMessage = randomUUID();
      await fixture.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
        values(${methodRun},${f.org},${f.workspace},${f.user},'running','{}','{}')`;
      await fixture.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
        values(${userMessage},${f.org},${f.workspace},${f.session},${f.user},'user','{"text":"Synthetic authoring","citations":[]}'),
          (${assistantMessage},${f.org},${f.workspace},${f.session},${f.user},'assistant','{"text":"Synthetic authoring","citations":[]}')`;
      await fixture.db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,
        session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,execution_snapshot,method_authoring)
        values(${methodRun},${f.org},${f.workspace},${f.user},${f.assignment},${f.version},${f.session},${userMessage},${assistantMessage},
          ${fixture.db.json(source!.provider_snapshot)},'{}',${fixture.db.json(source!.execution_snapshot)},true)`;
      await fixture.db`update allrice_memories set source_type='message',source_id=${userMessage} where id=${excluded[7]!}`;
      const checkpointId = randomUUID();
      const checkpoint = {
        sessionId: f.session,
        harness: 'dsh' as const,
        threadId: null,
        generation: 0,
        coveredThroughMessageId: userMessage,
        summaryVersion: 'extractive-v1' as const,
        summary: 'Synthetic method checkpoint',
        configChecksum: f.snapshot.employee.definitionChecksum,
        estimatedTokens: 10,
        messageCount: 1,
      };
      await fixture.db`insert into allrice_context_checkpoints(id,organization_id,workspace_id,session_id,owner_id,harness,thread_id,
        thread_generation,covered_through_message_id,summary_version,summary,checksum,config_checksum,estimated_tokens,message_count)
        values(${checkpointId},${f.org},${f.workspace},${f.session},${f.user},'dsh',null,0,${userMessage},'extractive-v1',
          ${checkpoint.summary},${contextCheckpointChecksum(checkpoint)},${checkpoint.configChecksum},10,1)`;
      await fixture.db`update allrice_memories set source_type='checkpoint',source_id=${checkpointId} where id=${excluded[8]!}`;
      const page = await listPersonalEmployeeMemories(
        f.context,
        f.workspace,
        f.assignment,
      );
      const quota = await fixture.db.begin((tx) =>
        employeeMemoryCounts(tx, scope),
      );
      const next = await freezeEmployeeMemoryIndexV2(fixture.db, scope, {});
      expect(page.counts).toEqual({ active: 100, pending: 73, maxActive: 100 });
      expect(quota).toEqual(page.counts);
      expect(page.active.map((row) => row.id)).toEqual(
        next.memoryContextStateV2.pins.map((pin) => pin.id),
      );
      expect(next.memoryContextStateV2).toEqual(
        f.projection.memoryContextStateV2,
      );
      await expect(
        prepareRunMemoryContext(
          f.auth,
          [],
          f.projection.employeeDocuments.memory,
          2,
        ),
      ).resolves.toEqual([]);
      const before = await state(f.rootRunId);
      await expect(
        readRunMemoryOrdinal(f.auth, { number: 100 }),
      ).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_BUDGET_EXHAUSTED' });
      expect(await state(f.rootRunId)).toEqual(before);
    }, 120000);

    it('freezes empty0, refuses101 and damaged pairs without truncation or repair', async () => {
      const empty = await setup([]);
      expect(empty.projection.employeeDocuments).toMatchObject({
        schemaVersion: 2,
        memory: '',
      });
      expect(await state(empty.rootRunId)).toMatchObject({
        pins: [],
        spentBytes: 0,
        toolReads: 0,
      });
      await expect(
        readRunMemoryOrdinal(empty.auth, { number: 1 }),
      ).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_UNAVAILABLE' });
      await expect(
        setup(Array.from({ length: 101 }, () => defaultPair)),
      ).rejects.toThrow();
      const damaged = await setup();
      const pin = damaged.projection.memoryContextStateV2.pins[0]!;
      await fixture.db`update allrice_memories set summary=null where id=${pin.id}`;
      await expect(
        freezeEmployeeMemoryIndexV2(
          fixture.db,
          {
            ...damaged.auth.scope,
            instanceId: damaged.assignment,
            employeeId: damaged.employee,
          },
          {},
        ),
      ).rejects.toThrow();
      expect(
        (
          await fixture.db`select summary from allrice_memories where id=${pin.id}`
        )[0]!.summary,
      ).toBeNull();
    });

    it('reads one historical complete pair and does not reset on prepare/resume', async () => {
      const f = await setup();
      const pin = f.projection.memoryContextStateV2.pins[0]!;
      const output = await readRunMemoryOrdinal(f.auth, { number: 1 });
      expect(output).toBe(renderMemoryDetailV2(1, defaultPair));
      const first = await state(f.rootRunId);
      expect(first.toolReads).toBe(1);
      expect(first.spentBytes).toBe(
        first.initial.bytes + Buffer.byteLength(output),
      );
      // A later independently confirmed revision must not replace an issued pin.
      await fixture.db`update allrice_memories set summary='新规则',details='新的完整条件',content='新规则',revision=2 where id=${pin.id}`;
      await fixture.db`insert into allrice_memory_revisions(organization_id,workspace_id,memory_id,revision,
      content,summary,details,trust_level,lifecycle_state,memory_class,confidence,reason,changed_by)
      values(${f.org},${f.workspace},${pin.id},2,'新规则','新规则','新的完整条件',
        'user_confirmed','durable','work_note',1,'synthetic independent owner edit',${f.user})`;
      await assertRunMemoryContextCurrent(f.auth.scope);
      expect(await readRunMemoryOrdinal(f.auth, { number: 1 })).toBe(output);
      const spent = await state(f.rootRunId);
      await prepareRunMemoryContext(
        f.auth,
        [],
        f.projection.employeeDocuments.memory,
        2,
      );
      expect(await state(f.rootRunId)).toEqual(spent);
      const next = await freezeEmployeeMemoryIndexV2(
        fixture.db,
        { ...f.auth.scope, instanceId: f.assignment, employeeId: f.employee },
        {},
      );
      expect(next.memoryContextStateV2.pins[0]!.revision).toBe(2);
      expect(next.memoryContextStateV2.pins[0]!.pairDigest).not.toBe(
        pin.pairDigest,
      );
    });

    it('counts rereads to12, admits actual short results below512, and cannot double-spend', async () => {
      const f = await setup([{ summary: '短', details: null }]);
      const bytes = Buffer.byteLength(
        renderMemoryDetailV2(1, { summary: '短', details: null }),
      );
      for (let i = 0; i < 12; i++)
        await readRunMemoryOrdinal(f.auth, { number: 1 });
      expect((await state(f.rootRunId)).toolReads).toBe(12);
      await expect(
        readRunMemoryOrdinal(f.auth, { number: 1 }),
      ).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_BUDGET_EXHAUSTED' });
      const g = await setup([{ summary: '短', details: null }]);
      await changeState(g.rootRunId, (value) => ({
        ...value,
        spentBytes: 24000 - bytes,
        toolReads: 0,
      }));
      const reads = await Promise.allSettled([
        readRunMemoryOrdinal(g.auth, { number: 1 }),
        readRunMemoryOrdinal(g.auth, { number: 1 }),
      ]);
      expect(reads.filter((read) => read.status === 'fulfilled')).toHaveLength(
        1,
      );
      expect((await state(g.rootRunId)).spentBytes).toBe(24000);
      expect((await state(g.rootRunId)).toolReads).toBe(1);
    });

    it('never uses the legacy search/source pipeline for v2 and rejects corrupt, old or ungranted state', async () => {
      const f = await setup();
      const oldSearch = vi.fn(async () => []);
      await expect(
        readRunMemoryContext(f.auth, 'memory_search', oldSearch),
      ).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_UNAVAILABLE' });
      expect(oldSearch).not.toHaveBeenCalled();
      await expect(
        readRunExperienceSource(f.auth, `experience:sha256:${'a'.repeat(64)}`),
      ).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_UNAVAILABLE' });
      for (const input of [
        { number: 0 },
        { number: 101 },
        { number: '1' },
        { number: 1, ownerId: f.user },
      ])
        await expect(readRunMemoryOrdinal(f.auth, input)).rejects.toThrow();
      await changeState(f.rootRunId, (value) => ({
        ...value,
        pins: [{ ...value.pins[0]!, pairDigest: `sha256:${'b'.repeat(64)}` }],
      }));
      await expect(
        readRunMemoryOrdinal(f.auth, { number: 1 }),
      ).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_UNAVAILABLE' });
      for (const old of [null, { schemaVersion: 1, pending: true }] as const) {
        await changeState(f.rootRunId, () => old);
        await expect(
          prepareRunMemoryContext(
            f.auth,
            [],
            f.projection.employeeDocuments.memory,
            2,
          ),
        ).rejects.toThrow();
        expect(await state(f.rootRunId)).toEqual(old);
      }
      const denied = await setup([defaultPair], false);
      await expect(
        readRunMemoryOrdinal(denied.auth, { number: 1 }),
      ).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_UNAVAILABLE' });
      const damaged = await setup();
      const before = await state(damaged.rootRunId);
      await fixture.db`update allrice_memory_revisions set details='incomplete replacement'
      where memory_id=${before.pins[0]!.id} and revision=1`;
      await expect(
        readRunMemoryOrdinal(damaged.auth, { number: 1 }),
      ).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_UNAVAILABLE' });
      expect(await state(damaged.rootRunId)).toEqual(before);
    });

    it('rechecks current owner, principal, instance, confirmation and the exact worker lease', async () => {
      const f = await setup();
      const before = await state(f.rootRunId);
      await expect(
        readRunMemoryOrdinal(
          { ...f.auth, worker: { ...f.auth.worker, leaseToken: randomUUID() } },
          { number: 1 },
        ),
      ).rejects.toThrow();
      await expect(
        readRunMemoryOrdinal(
          { ...f.auth, scope: { ...f.auth.scope, ownerId: randomUUID() } },
          { number: 1 },
        ),
      ).rejects.toThrow();
      await fixture.db`update allrice_memories set trust_level='derived' where id=${before.pins[0]!.id}`;
      await expect(
        readRunMemoryOrdinal(f.auth, { number: 1 }),
      ).rejects.toThrow();
      await fixture.db`update allrice_memories set trust_level='user_confirmed' where id=${before.pins[0]!.id}`;
      await fixture.db`update allrice_memories set employee_id=null where id=${before.pins[0]!.id}`;
      await expect(
        readRunMemoryOrdinal(f.auth, { number: 1 }),
      ).rejects.toThrow();
      await expect(
        assertRunMemoryContextCurrent(f.auth.scope),
      ).rejects.toThrow();
      await fixture.db`update allrice_memories set employee_id=${f.employee},visibility='workspace' where id=${before.pins[0]!.id}`;
      await expect(
        readRunMemoryOrdinal(f.auth, { number: 1 }),
      ).rejects.toThrow();
      await expect(
        assertRunMemoryContextCurrent(f.auth.scope),
      ).rejects.toThrow();
      await fixture.db`update allrice_memories set visibility='private' where id=${before.pins[0]!.id}`;
      await fixture.db`update allrice_employee_instances set archived_at=now() where id=${f.assignment}`;
      await expect(
        readRunMemoryOrdinal(f.auth, { number: 1 }),
      ).rejects.toThrow();
      await fixture.db`update allrice_employee_instances set archived_at=null where id=${f.assignment}`;
      await fixture.db`update allrice_memberships set active=false where id=${f.membership}`;
      await expect(
        readRunMemoryOrdinal(f.auth, { number: 1 }),
      ).rejects.toThrow();
      expect(await state(f.rootRunId)).toEqual(before);
    });

    it('stops an old context on deletion ofA without deleting the independent confirmedB', async () => {
      const f = await setup([
        defaultPair,
        { summary: 'B独立规则', details: null },
      ]);
      const [a, b] = f.projection.memoryContextStateV2.pins;
      // Both rules can originate in the same user message; only A identity is withdrawn.
      const [message] =
        await fixture.db`select user_message_id from allrice_employee_runs where run_id=${f.rootRunId}`;
      await fixture.db`update allrice_memories set source_type='message',source_id=${message!.user_message_id} where id=any(${[a!.id, b!.id]}::uuid[])`;
      await fixture.db`update allrice_memories set archived_at=now() where id=${a!.id}`;
      await expect(
        assertRunMemoryContextCurrent(f.auth.scope),
      ).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_UNAVAILABLE' });
      await expect(
        readRunMemoryOrdinal(f.auth, { number: a!.number }),
      ).rejects.toThrow();
      const next = await freezeEmployeeMemoryIndexV2(
        fixture.db,
        { ...f.auth.scope, instanceId: f.assignment, employeeId: f.employee },
        {},
      );
      expect(next.memoryContextStateV2.pins.map((pin) => pin.id)).toEqual([
        b!.id,
      ]);
      const [row] =
        await fixture.db`select archived_at,lifecycle_state from allrice_memories where id=${b!.id}`;
      expect(row).toMatchObject({
        archived_at: null,
        lifecycle_state: 'durable',
      });
    });

    it('passes real DB→Broker→DSH output to the next synthetic provider request without innerJSON', async () => {
      const details = '\u0001'.repeat(1995) + '不得外发。';
      const f = await setup([{ summary: defaultPair.summary, details }]);
      const output = renderMemoryDetailV2(1, {
        summary: defaultPair.summary,
        details,
      });
      const calls: string[] = [];
      const invoked = new Set<string>();
      const h = await NativeHost.host({
        runId: f.rootRunId,
        rootSystemInstructions: 'Stable employee policy',
        employeeDocuments: f.projection.employeeDocuments,
        nativeTools: ['workspace.memory.read'],
        model: async (request: { sessionId: string }) => {
          if (invoked.has(request.sessionId)) return NativeHost.text('完成');
          invoked.add(request.sessionId);
          return [
            {
              type: 'tool-call',
              id: 'memory1',
              name: 'workspace_memory_read',
              arguments: '{"number":1}',
            },
          ];
        },
        bridge: async (
          method: string,
          params: {
            toolCallId: string;
            name: string;
            arguments: Record<string, unknown>;
            nativeSessionId: string;
          },
        ) => {
          if (method === 'allrice/run-authorize') {
            await assertRunMemoryContextCurrent(f.auth.scope);
            return { allowed: true };
          }
          if (method !== 'allrice/tool-call') throw Error(method);
          const result = await executeRiceTool({
            context: f.execution,
            employeeDocuments: f.projection.employeeDocuments,
            capabilities: ['storage:read'],
            storageRoot: '/must-not-export',
            sessionId: f.session,
            memoryReadAuthority: f.auth,
            call: {
              id: params.toolCallId,
              name: params.name,
              arguments: params.arguments,
              nativeSessionId: params.nativeSessionId,
            },
          });
          calls.push(result.modelContent);
          return result;
        },
      });
      await h.prompt('请按已确认的财务日报规则整理记录。');
      await h.wait();
      expect(h.initialization.capabilities.employeeDocumentsSchemaVersion).toBe(
        2,
      );
      expect(calls).toEqual([output]);
      const first = h.calls[0];
      expect(JSON.stringify(first.messages)).toContain('MEMORY_INDEX_V2');
      expect(JSON.stringify(first.messages)).not.toContain(
        JSON.stringify(details).slice(1, -1),
      );
      const request = h.calls[1];
      const result = request.messages
        .map(readDshToolResult)
        .find(
          (message: Record<string, unknown> | null) =>
            message?.toolCallId === 'memory1',
        );
      expect(result).toBeDefined();
      expect(
        (result!.content as { type: string; text: string }[])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join(''),
      ).toBe(output);
      const child = await h.spawn();
      await child.result;
      await h.wait();
      expect(calls).toEqual([output, output]);
      const childRequest = h.calls.find(
        (entry: { sessionId: string }) => entry.sessionId === child.childId,
      );
      expect(JSON.stringify(childRequest.messages)).not.toContain(
        'MEMORY_INDEX_V2',
      );
      expect(
        childRequest.tools.some(
          (tool: { name: string }) => tool.name === 'workspace_memory_read',
        ),
      ).toBe(true);
      const ledger = await state(f.rootRunId);
      expect(ledger.toolReads).toBe(2);
      expect(ledger.spentBytes).toBe(
        ledger.initial.bytes + 2 * Buffer.byteLength(output),
      );
    }, 45000);
  },
);
