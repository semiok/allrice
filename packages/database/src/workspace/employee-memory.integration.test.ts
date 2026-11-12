import { freezeEmployeeDocuments } from '../employees/employee-documents.ts';
import {
  assertEmployeeChatHumanSource,
  readEmployeeChatSourceKind,
} from '../employees/employee-chat-authority.ts';
import { admitEmployeeDocuments } from '../../../../apps/worker/src/jobs/employee-document-admission.ts';
import {
  prepareRunMemoryContext,
  assertRunMemoryContextCurrent,
} from '../run-memory-context.ts';
import { readRunExperienceSource } from '../run-experience-source.ts';
import { readToolBrokerMemoryContext } from '../execution/tool-broker.ts';
import { seedLegacyEmployeeMemory } from './employee-memory-v1.fixture.ts';
import { setPersonalEmployeeMemoryPin } from './service.ts';
/** Actual isolated PostgreSQL, current identities and the public memory services.
 * No model calls. Test data and all schema changes live in runtime.fixture. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  renderMemoryContext,
  initialMemoryContextBytes,
  type ExecutionContext,
} from '@allrice/contracts';
import * as client from '../core/client.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { createRunAuthorityFixture } from '../run-authority.fixture.ts';
import { authenticateSession, createSession } from '../identity.ts';
import {
  createEmployeeInstance,
  ensureGeneralEmployeeInstance,
  changeEmployeeInstanceLifecycle,
} from '../employees/employee-instances.ts';
import { resolveEmployeeContentSource } from '../employees/employee-content-sources.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { filterEmployeeMethodMemories } from '../employees/employee-method-chat.ts';
import { searchToolBrokerMemories } from '../execution/tool-broker.ts';
import { recallRagChunks } from '../data.ts';
import {
  createTraceableMemory,
  correctWorkspaceMemory,
  correctPersonalEmployeeMemory,
  promoteWorkspaceMemory,
  deleteWorkspaceMemory,
  listWorkspaceMemories,
  listWorkspaceMemoryRevisions,
  searchWorkspaceMemories,
  embedWorkspaceText,
  getEmployeeWorkspace,
} from './service.ts';
import {
  EmployeeMemoryConflict,
  memoryContentDigest,
  memoryPairDigest,
  legacyPersonalMemoryPair,
} from './employee-memory.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'employee memory: current instance, exact confirmation and atomic receipt',
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
    async function setup() {
      const f = await createRunAuthorityFixture(fixture.db, {
        toolNames: ['workspace.memory.search', 'workspace.experience.read'],
        allowedTools: ['workspace.memory.search', 'workspace.experience.read'],
      });
      const context = (await authenticateSession(
        (await createSession(f.user)).token,
        { organizationId: f.org, workspaceId: f.workspace },
      ))!;
      await ensureGeneralEmployeeInstance(fixture.db, f.assignment);
      const other = await createEmployeeInstance(context, {
        workspaceId: f.workspace,
        assignmentId: f.assignment,
        requestId: randomUUID(),
        profile: { name: 'Other instance' },
      });
      const [message] = await fixture.db<
        { user_message_id: string }[]
      >`select user_message_id from allrice_employee_runs where run_id=${f.rootRunId}`;
      const execution: ExecutionContext = {
        executionId: randomUUID(),
        runId: f.rootRunId,
        jobId: f.worker.jobId,
        worker: { type: 'worker', id: f.worker.workerId },
        delegatedBy: { type: 'user', id: context.actor.id },
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
          memberships: context.memberships,
          grants: [
            {
              resourceType: 'memory',
              action: 'resource:read',
              workspaceId: f.workspace,
            },
          ],
        },
      };
      const create = (content: string, extra: Record<string, unknown> = {}) =>
        createTraceableMemory(context, {
          workspaceId: f.workspace,
          instanceId: f.assignment,
          idempotencyKey: randomUUID(),
          content,
          sourceType: 'user',
          ...extra,
        });
      return {
        ...f,
        context,
        other,
        create,
        execution,
        messageId: message!.user_message_id,
        scope: {
          organizationId: f.org,
          workspaceId: f.workspace,
          ownerId: f.user,
          runId: f.rootRunId,
        },
      };
    }
    const exact = (m: {
      instanceId: string | null;
      revision: number;
      contentDigest: string;
    }) => ({
      instanceId: m.instanceId!,
      expectedRevision: m.revision,
      contentDigest: m.contentDigest,
      idempotencyKey: randomUUID(),
    });

    it('keeps internal first-withdrawal filtering and rebuilds literal memory from the original ledger selection', async () => {
      const f = await setup();
      const withdrawn = await f.create('撤回后不能送入首轮模型'),
        kept = await f.create(
          '原冻结字节 {{missing}}；必须保留12笔，不合并退款。',
        );
      const frozen = [withdrawn, kept].map(({ id, revision, content }) => ({
        id,
        revision,
        content,
      }));
      const scope = { ...f.scope, sessionId: f.session };
      const [job] =
        await fixture.db`select attempt from allrice_jobs where id=${f.worker.jobId}`;
      const auth = {
        scope,
        worker: { ...f.worker, attempt: Number(job!.attempt) },
      };
      await fixture.db`update allrice_employee_runs set status='running',memory_context_state='{"schemaVersion":1,"pending":true}' where run_id=${f.rootRunId}`;
      await deleteWorkspaceMemory(
        f.context,
        f.workspace,
        withdrawn.id,
        exact(withdrawn),
      );
      const eligible = await filterEmployeeMethodMemories(scope, frozen);
      const selected = await prepareRunMemoryContext(auth, eligible);
      expect(selected).toEqual([frozen[1]]);
      expect(renderMemoryContext(selected)).toContain('原冻结字节 {{missing}}');
      expect(renderMemoryContext(selected)).not.toContain('撤回后');
      const state = async () =>
        (
          await fixture.db`select memory_context_state s from allrice_employee_runs where run_id=${f.rootRunId}`
        )[0]!.s;
      const initial = await state();
      expect(initial.initial.ids).toEqual([kept.id]);
      expect(initial.initial.bytes).toBe(initialMemoryContextBytes(selected));
      expect(initial.initial).not.toHaveProperty('documentDigest');
      expect(initial).not.toHaveProperty('confirmedPins');
      const edited = await editActive(f, kept, '下个任务的新正文', '本人更新');
      const resumed = await prepareRunMemoryContext(
        auth,
        await filterEmployeeMethodMemories(scope, frozen),
      );
      expect(renderMemoryContext(resumed)).toBe(renderMemoryContext(selected));
      expect(await state()).toEqual(initial);
      await deleteWorkspaceMemory(
        f.context,
        f.workspace,
        kept.id,
        exact(edited),
      );
      await expect(
        prepareRunMemoryContext(
          auth,
          await filterEmployeeMethodMemories(scope, frozen),
        ),
      ).rejects.toThrow('MEMORY_CONTEXT_UNAVAILABLE');
      expect(await state()).toEqual(initial);
    });

    it('does not issue a document budget or pins when an internal old ledger is NULL', async () => {
      const f = await setup(),
        memory = await f.create('旧任务不得重新获额度');
      const scope = { ...f.scope, sessionId: f.session };
      const [job] =
        await fixture.db`select attempt from allrice_jobs where id=${f.worker.jobId}`;
      await fixture.db`update allrice_employee_runs set status='running',memory_context_state=null where run_id=${f.rootRunId}`;
      const selected = await prepareRunMemoryContext(
        {
          scope,
          worker: { ...f.worker, attempt: Number(job!.attempt) },
        },
        [{ id: memory.id, revision: memory.revision, content: memory.content }],
      );
      expect(renderMemoryContext(selected)).toBe('');
      expect(
        (
          await fixture.db`select memory_context_state s from allrice_employee_runs where run_id=${f.rootRunId}`
        )[0]!.s,
      ).toBeNull();
    });

    async function editActive(
      f: Awaited<ReturnType<typeof setup>>,
      m: {
        id: string;
        content: string;
        revision: number;
        instanceId: string | null;
      },
      summary: string,
      reason: string,
    ) {
      const edited = await correctPersonalEmployeeMemory(
        f.context,
        f.workspace,
        m.id,
        {
          instanceId: m.instanceId!,
          expectedRevision: m.revision,
          pairDigest: memoryPairDigest(legacyPersonalMemoryPair(m.content)),
          idempotencyKey: randomUUID(),
          summary,
          details: null,
          reason,
        },
      );
      return { ...edited, contentDigest: memoryContentDigest(edited.summary) };
    }
    const legacyMemory = (
      f: Awaited<ReturnType<typeof setup>>,
      content: string,
      lifecycleState: 'candidate' | 'durable' = 'durable',
    ) =>
      seedLegacyEmployeeMemory(fixture.db, f.context, {
        workspaceId: f.workspace,
        instanceId: f.assignment,
        content,
        sourceType: 'user',
        lifecycleState,
      });

    it('freezes whole document revisions, shares search/source pins and spend, and stops after withdrawal', async () => {
      const f = await setup();
      const first = await f.create('稳定资料入口：先核对12笔，不得合并退款。');
      await f.create('未确认不得带入', { lifecycleState: 'candidate' });
      const scope = { ...f.scope, sessionId: f.session };
      const [job] =
        await fixture.db`select attempt from allrice_jobs where id=${f.worker.jobId}`;
      const auth = {
        scope,
        worker: { ...f.worker, attempt: job!.attempt as number },
      };
      const document = await freezeEmployeeDocuments(
        fixture.db,
        { ...scope, instanceId: f.assignment },
        {
          companyName: '企业',
          departmentName: '核对部',
          responsibilities: '不得越权',
        },
        true,
      );
      expect(document.memories.map((m) => m.id)).toEqual([first.id]);
      expect(document.employeeDocuments.user).toContain('核对部');
      await fixture.db`update allrice_employee_runs set status='running',memory_context_state='{"schemaVersion":1,"pending":true}' where run_id=${f.rootRunId}`;
      await prepareRunMemoryContext(
        auth,
        document.memories,
        document.employeeDocuments.memory,
      );
      const [initial] =
        await fixture.db`select memory_context_state s from allrice_employee_runs where run_id=${f.rootRunId}`;
      expect(initial!.s.initial.bytes).toBe(
        Buffer.byteLength(document.employeeDocuments.memory),
      );
      await assertRunMemoryContextCurrent(scope);
      const handle = document.memories[0]!.sourceHandle!;
      const source = await readRunExperienceSource(auth, handle);
      expect(source.items[0]).toMatchObject({
        memory: { content: first.content },
      });
      const edited = await editActive(
        f,
        first,
        '新任务入口：按新说明核对。',
        '本人更新',
      );
      await assertRunMemoryContextCurrent(scope);
      expect(
        (await readRunExperienceSource(auth, handle)).items[0],
      ).toMatchObject({ memory: { content: first.content } });
      const search = await readToolBrokerMemoryContext(
        f.execution,
        '稳定资料入口',
        20,
        auth,
      );
      expect(search.items[0]!.revision).toBe(first.revision);
      expect(search.items[0]!.sourceHandle).toBe(handle);
      const [spent] =
        await fixture.db`select memory_context_state s from allrice_employee_runs where run_id=${f.rootRunId}`;
      await prepareRunMemoryContext(
        auth,
        document.memories,
        document.employeeDocuments.memory,
      );
      expect(
        (
          await fixture.db`select memory_context_state s from allrice_employee_runs where run_id=${f.rootRunId}`
        )[0]!.s,
      ).toEqual(spent!.s);
      await deleteWorkspaceMemory(
        f.context,
        f.workspace,
        first.id,
        exact(edited),
      );
      await expect(assertRunMemoryContextCurrent(scope)).rejects.toThrow(
        'MEMORY_CONTEXT_UNAVAILABLE',
      );
      await expect(readRunExperienceSource(auth, handle)).rejects.toThrow();
      expect(
        (
          await fixture.db`select memory_context_state s from allrice_employee_runs where run_id=${f.rootRunId}`
        )[0]!.s,
      ).toEqual(spent!.s);
    });
    it('admits current human documents, rejects old or unknown ordinary snapshots, and preserves proven internal producers', async () => {
      const f = await setup();
      const input = { context: f.execution, userMessageId: f.messageId };
      await expect(readEmployeeChatSourceKind(input)).resolves.toBe('human');
      await expect(
        assertEmployeeChatHumanSource(input),
      ).resolves.toBeUndefined();
      await expect(
        admitEmployeeDocuments({ ...input, documents: true }),
      ).resolves.toBe('human');
      await expect(
        admitEmployeeDocuments({ ...input, documents: false }),
      ).rejects.toMatchObject({
        code: 'MEMORY_CONTEXT_UNAVAILABLE',
        retryable: false,
      });
      const missing = { ...input, userMessageId: randomUUID() };
      await expect(readEmployeeChatSourceKind(missing)).resolves.toBe(
        'unavailable',
      );
      await expect(
        assertEmployeeChatHumanSource(missing),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      for (const documents of [true, false])
        await expect(
          admitEmployeeDocuments({ ...missing, documents }),
        ).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_UNAVAILABLE' });
      // A real durable internal producer, not a forged role=user or caller flag.
      await fixture.db`insert into allrice_platform_quality_checks(id,request_id,organization_id,workspace_id,owner_id,run_id,job_id,session_id,input_digest,frozen)
        values(${randomUUID()},${randomUUID()},${f.org},${f.workspace},${f.user},${f.rootRunId},${f.worker.jobId},${f.session},${runtimePolicyDigest({ fixture: true })},'{}')`;
      await expect(readEmployeeChatSourceKind(input)).resolves.toBe('internal');
      await expect(assertEmployeeChatHumanSource(input)).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      await expect(
        admitEmployeeDocuments({ ...input, documents: false }),
      ).resolves.toBe('internal');
      await expect(
        admitEmployeeDocuments({ ...input, documents: true }),
      ).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_UNAVAILABLE' });
      const legacy = await createRunAuthorityFixture(fixture.db, {
        snapshot: (value) => ({ ...value, schemaVersion: 1 }),
      });
      const [message] =
        await fixture.db`select user_message_id from allrice_employee_runs where run_id=${legacy.rootRunId}`;
      const legacyInput = {
        context: {
          ...f.execution,
          runId: legacy.rootRunId,
          organizationId: legacy.org,
          workspaceId: legacy.workspace,
          policySnapshot: {
            ...f.execution.policySnapshot,
            subjectId: legacy.user,
          },
        },
        userMessageId: message!.user_message_id as string,
      };
      await expect(readEmployeeChatSourceKind(legacyInput)).resolves.toBe(
        'unavailable',
      );
      await expect(
        assertEmployeeChatHumanSource(legacyInput),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        admitEmployeeDocuments({ ...legacyInput, documents: false }),
      ).rejects.toMatchObject({ code: 'MEMORY_CONTEXT_UNAVAILABLE' });
    });

    it.each(['expiry', 'membership', 'instance'] as const)(
      'rechecks %s before reusing a frozen document pin',
      async (change) => {
        const f = await setup();
        await f.create('恢复前已确认入口');
        const scope = { ...f.scope, sessionId: f.session };
        const [job] =
          await fixture.db`select attempt from allrice_jobs where id=${f.worker.jobId}`;
        const auth = {
          scope,
          worker: { ...f.worker, attempt: job!.attempt as number },
        };
        const frozen = await freezeEmployeeDocuments(
          fixture.db,
          { ...f.scope, instanceId: f.assignment },
          {},
          true,
        );
        await fixture.db`update allrice_employee_runs set status='running',memory_context_state='{"schemaVersion":1,"pending":true}' where run_id=${f.rootRunId}`;
        await prepareRunMemoryContext(
          auth,
          frozen.memories,
          frozen.employeeDocuments.memory,
        );
        await assertRunMemoryContextCurrent(scope);
        if (change === 'expiry')
          await fixture.db`update allrice_memories set expires_at=clock_timestamp() where id=${frozen.memories[0]!.id}`;
        else if (change === 'membership')
          await fixture.db`update allrice_memberships set active=false where organization_id=${f.org} and user_id=${f.user}`;
        else
          await changeEmployeeInstanceLifecycle(f.context, f.assignment, {
            workspaceId: f.workspace,
            expectedRevision: 1,
            operation: 'archive',
            requestId: randomUUID(),
          });
        await expect(assertRunMemoryContextCurrent(scope)).rejects.toThrow();
        await expect(
          readRunExperienceSource(auth, frozen.memories[0]!.sourceHandle!),
        ).rejects.toThrow();
      },
    );

    it('owner pin order uses the same bounded selection, exact revision and idempotency without cross-instance writes', async () => {
      const f = await setup();
      const older = await f.create('较早的常用入口');
      // Cross the byte limit, so omitting locator cost would select extra IDs.
      for (let i = 0; i < 9; i++)
        await f.create(`新入口${i}${'x'.repeat(700)}`);
      const preference = { ...exact(older), pinned: true };
      const saved = await setPersonalEmployeeMemoryPin(
        f.context,
        f.workspace,
        older.id,
        preference,
      );
      expect(
        await setPersonalEmployeeMemoryPin(
          f.context,
          f.workspace,
          older.id,
          preference,
        ),
      ).toEqual(saved);
      const projected = await freezeEmployeeDocuments(
        fixture.db,
        { ...f.scope, instanceId: f.assignment },
        {},
        true,
      );
      expect(projected.memories[0]!.id).toBe(older.id);
      expect(projected.memories.length).toBeLessThan(projected.eligibleCount);
      const withoutSourceTool = await freezeEmployeeDocuments(
        fixture.db,
        { ...f.scope, instanceId: f.assignment },
        {},
        false,
      );
      expect(withoutSourceTool.memories.map((m) => m.id)).toEqual(
        projected.memories.map((m) => m.id),
      );
      expect(withoutSourceTool.employeeDocuments.memory).not.toContain(
        'sourceHandle',
      );
      expect(saved.content).toBe(older.content);
      await expect(
        setPersonalEmployeeMemoryPin(f.context, f.workspace, older.id, {
          ...exact(saved),
          instanceId: f.other.id,
          pinned: false,
        }),
      ).rejects.toThrow();
    });

    it('retains historical v1 pinned-edit capacity rejection and always allows unpin to repair capacity', async () => {
      const f = await setup();
      const saved = [];
      for (let i = 0; i < 8; i++) {
        const item = await legacyMemory(f, `常用入口${i}`);
        saved.push(
          await setPersonalEmployeeMemoryPin(f.context, f.workspace, item.id, {
            ...exact(item),
            pinned: true,
          }),
        );
      }
      let rejected = false;
      for (const item of saved) {
        try {
          await correctWorkspaceMemory(f.context, f.workspace, item.id, {
            ...exact(item),
            content: 'x'.repeat(1000),
            reason: '本人编辑',
          });
        } catch (error) {
          expect(error).toMatchObject({ message: 'employee_memory_capacity' });
          const [unchanged] =
            await fixture.db`select content,revision from allrice_memories where id=${item.id}`;
          expect(unchanged).toMatchObject({
            content: item.content,
            revision: item.revision,
          });
          rejected = true;
          break;
        }
      }
      expect(rejected).toBe(true);
      // Isolated historical over-capacity fixture; repairing it must be possible.
      await fixture.db`update allrice_memories set content=repeat('y',2000) where id=any(${saved.map((m) => m.id)}::uuid[])`;
      const item = saved.at(-1)!;
      const [current] =
        await fixture.db`select revision,content from allrice_memories where id=${item.id}`;
      await expect(
        setPersonalEmployeeMemoryPin(f.context, f.workspace, item.id, {
          ...exact(item),
          expectedRevision: current!.revision,
          contentDigest: memoryContentDigest(current!.content),
          pinned: false,
        }),
      ).resolves.toMatchObject({ id: item.id });
    });

    it('binds proposals from the stored source; list, recall, raw RAG, revisions, broker and resumed input cannot cross instances', async () => {
      const f = await setup();
      const good = await f.create('月报资料入口 CURRENT_CONFIRMED');
      const candidate = await f.create('月报资料入口 CANDIDATE', {
        lifecycleState: 'candidate',
      });
      const other = await f.create('月报资料入口 WRONG_INSTANCE', {
        instanceId: f.other.id,
      });
      const expired = await f.create('月报资料入口 EXPIRED');
      await fixture.db`update allrice_memories set captured_at=now()-interval '2 days', expires_at=now()-interval '1 day' where id=${expired.id}`;
      const foreign = await setup();
      await foreign.create('月报资料入口 WRONG_TENANT');
      const input = {
        workspaceId: f.workspace,
        query: '月报资料入口',
        instanceId: f.assignment,
        limit: 20,
      };
      expect(
        (
          await listWorkspaceMemories(f.context, f.workspace, undefined, {
            instanceId: f.assignment,
          })
        )
          .map((m) => m.id)
          .sort(),
      ).toEqual([good.id, candidate.id, expired.id].sort());
      expect(
        (await searchWorkspaceMemories(f.context, input)).map((m) => m.id),
      ).toEqual([good.id]);
      expect(
        (
          await recallRagChunks(f.context, {
            workspaceId: f.workspace,
            instanceId: f.assignment,
            embedding: embedWorkspaceText('月报资料入口'),
          })
        ).map((m) => m.memory_id),
      ).toEqual([good.id]);
      expect(
        (await searchToolBrokerMemories(f.execution, '月报资料入口', 20)).map(
          (m) => m.id,
        ),
      ).toEqual([good.id]);
      expect(
        await filterEmployeeMethodMemories(f.scope, [
          good,
          candidate,
          other,
          expired,
        ]),
      ).toEqual([good]);
      await expect(
        listWorkspaceMemoryRevisions(
          f.context,
          f.workspace,
          other.id,
          f.assignment,
        ),
      ).rejects.toThrow('not_found');
      await expect(
        listWorkspaceMemories(f.context, f.workspace),
      ).rejects.toThrow('authorization_denied');
      await expect(
        listWorkspaceMemories(f.context, f.workspace, undefined, {
          instanceId: foreign.assignment,
        }),
      ).rejects.toThrow();
      await expect(
        createTraceableMemory(f.context, {
          workspaceId: f.workspace,
          instanceId: foreign.assignment,
          content: 'forged',
          sourceType: 'user',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow();
      const proposal = {
        workspaceId: f.workspace,
        content: 'new proposal',
        sourceType: 'message',
        sourceId: f.messageId,
        lifecycleState: 'candidate',
      };
      const created = await createTraceableMemory(f.context, proposal);
      expect(created.instanceId).toBe(f.assignment);
      await expect(
        createTraceableMemory(f.context, {
          ...proposal,
          instanceId: f.other.id,
        }),
      ).rejects.toThrow('authorization_denied');
    });

    it('never lets an approved legacy review bypass owner instance confirmation, expiry or withdrawal', async () => {
      const f = await setup();
      const good = await f.create('月报核对流程 CURRENT');
      const other = await f.create('月报核对流程 OTHER_INSTANCE', {
        instanceId: f.other.id,
      });
      const unbound = await f.create('月报核对流程 UNBOUND');
      const candidate = await f.create('月报核对流程 PENDING', {
        lifecycleState: 'candidate',
      });
      const verified = await f.create('月报核对流程 PLATFORM_VERIFIED');
      const expired = await f.create('月报核对流程 EXPIRED');
      const archived = await f.create('月报核对流程 WITHDRAWN');
      await fixture.db`update allrice_memories set instance_id=null where id=${unbound.id}`;
      await fixture.db`update allrice_memories set trust_level='platform_verified' where id=${verified.id}`;
      await fixture.db`update allrice_memories set captured_at=now()-interval '2 days',expires_at=now()-interval '1 day' where id=${expired.id}`;
      await fixture.db`update allrice_memories set archived_at=now() where id=${archived.id}`;
      const memories = [
        good,
        other,
        unbound,
        candidate,
        verified,
        expired,
        archived,
      ];
      for (const m of memories) {
        const digest = memoryContentDigest(m.content);
        await fixture.db`insert into allrice_experience_reviews
          (memory_id,organization_id,workspace_id,owner_id,client_request_id,request_digest,
           run_id,session_id,message_id,source_excerpt,source_digest,proposed_digest,
           requested_scope,share_acknowledged,status,reviewed_by,reviewed_at,review_reason)
          values(${m.id},${f.org},${f.workspace},${f.user},${randomUUID()},${digest},
            ${f.rootRunId},${f.session},${f.messageId},'Synthetic source',${digest},${digest},
            'private',false,'approved',${f.user},now(),'Synthetic legacy review')`;
        const [revision] =
          await fixture.db`select id from allrice_memory_revisions where memory_id=${m.id} and revision=${m.revision}`;
        const source = {
          context: f.context,
          employeeId: m.employeeId!,
          instanceId: f.assignment,
          ownership: {
            scope: 'personal' as const,
            organizationId: f.org,
            ownerId: f.user,
          },
          ref: {
            sourceKind: 'experience' as const,
            contentId: m.id,
            revisionId: revision!.id,
            digest: runtimePolicyDigest({
              memoryId: m.id,
              revisionId: revision!.id,
              revision: m.revision,
              content: m.content,
            }),
          },
          sql: fixture.db,
          lock: false,
          allowDraft: false,
        };
        expect((await resolveEmployeeContentSource(source)).dto.available).toBe(
          m.id === good.id,
        );
        expect(
          (
            await resolveEmployeeContentSource({
              ...source,
              instanceId: undefined,
            })
          ).dto.available,
        ).toBe(false);
      }
      expect(
        (
          await searchWorkspaceMemories(f.context, {
            workspaceId: f.workspace,
            instanceId: f.assignment,
            query: '月报核对流程',
            limit: 20,
          })
        ).map((m) => m.id),
      ).toEqual([good.id]);
      expect(
        (await searchToolBrokerMemories(f.execution, '月报核对流程', 20)).map(
          (m) => m.id,
        ),
      ).toEqual([good.id]);
      expect(
        (
          await recallRagChunks(f.context, {
            workspaceId: f.workspace,
            instanceId: f.assignment,
            embedding: embedWorkspaceText('月报核对流程'),
          })
        ).map((m) => m.memory_id),
      ).toEqual([good.id]);
      expect(
        await recallRagChunks(f.context, {
          workspaceId: f.workspace,
          embedding: embedWorkspaceText('月报核对流程'),
        }),
      ).toEqual([]);
      expect(await filterEmployeeMethodMemories(f.scope, memories)).toEqual([
        good,
      ]);
    });

    it('finds the same bounded confirmed records through browser and model search without vector chunks', async () => {
      const f = await setup();
      const ids: string[] = [];
      for (let i = 0; i < 22; i++)
        ids.push((await f.create(`月报资料入口 ${i}`)).id);
      await fixture.db`delete from allrice_rag_chunks where memory_id=any(${ids}::uuid[])`;
      const web = await searchWorkspaceMemories(f.context, {
        workspaceId: f.workspace,
        instanceId: f.assignment,
        query: '月报资料入口',
        limit: 20,
      });
      const broker = await searchToolBrokerMemories(
        f.execution,
        '月报资料入口',
        100,
      );
      expect(web).toHaveLength(20);
      expect(broker.map((m) => m.id)).toEqual(web.map((m) => m.id));
      expect(web.every((m) => ids.includes(m.id))).toBe(true);
      expect(
        await fixture.db`select id from allrice_memories where id=any(${ids}::uuid[])`,
      ).toHaveLength(22);
    });

    it('keeps ordinary edits frozen for the current Run while every instance reference rechecks its own scope', async () => {
      const f = await setup();
      const m = await f.create('Confirmed monthly report source');
      const [revision] =
        await fixture.db`select id from allrice_memory_revisions where memory_id=${m.id} and revision=1`;
      const input = {
        context: f.context,
        employeeId: m.employeeId!,
        instanceId: f.assignment,
        ownership: {
          scope: 'personal' as const,
          organizationId: f.org,
          ownerId: f.context.actor.id,
        },
        ref: {
          sourceKind: 'experience' as const,
          contentId: m.id,
          revisionId: revision!.id,
          digest: runtimePolicyDigest({
            memoryId: m.id,
            revisionId: revision!.id,
            revision: 1,
            content: m.content,
          }),
        },
        sql: fixture.db,
        lock: false,
        allowDraft: false,
      };
      expect((await resolveEmployeeContentSource(input)).dto.available).toBe(
        true,
      );
      const foreignInstance = await resolveEmployeeContentSource({
        ...input,
        instanceId: f.other.id,
      });
      expect(foreignInstance.dto.available).toBe(false);
      expect(foreignInstance.dto).not.toHaveProperty('body');
      await editActive(
        f,
        m,
        'Corrected monthly report source',
        'Owner edited next-run preference',
      );
      expect(await filterEmployeeMethodMemories(f.scope, [m])).toEqual([m]);
      const current = (
        await listWorkspaceMemories(f.context, f.workspace, undefined, {
          instanceId: f.assignment,
        })
      )[0]!;
      await deleteWorkspaceMemory(f.context, f.workspace, m.id, exact(current));
      expect(await filterEmployeeMethodMemories(f.scope, [m])).toEqual([]);
    });

    it('keeps workspace startup available after its general instance is archived without reviving it', async () => {
      const f = await setup();
      await f.create('Personal source');
      await changeEmployeeInstanceLifecycle(f.context, f.assignment, {
        workspaceId: f.workspace,
        requestId: randomUUID(),
        expectedRevision: 1,
        operation: 'archive',
      });
      const workspace = await getEmployeeWorkspace(f.context, f.workspace);
      expect(workspace.memories).toEqual([]);
      const [instance] =
        await fixture.db`select archived_at from allrice_employee_instances where id=${f.assignment}`;
      expect(instance!.archived_at).not.toBeNull();
    });

    it('retains historical v1 edit CAS/current receipts and does not revive discarded sources', async () => {
      const f = await setup();
      const candidate = await legacyMemory(f, '月报入口 A', 'candidate');
      const confirmation = exact(candidate);
      await expect(
        promoteWorkspaceMemory(f.context, f.workspace, candidate.id, {
          ...confirmation,
          contentDigest: memoryContentDigest('unseen'),
        }),
      ).rejects.toBeInstanceOf(EmployeeMemoryConflict);
      const corrected = await correctWorkspaceMemory(
        f.context,
        f.workspace,
        candidate.id,
        { ...exact(candidate), content: '月报入口 B', reason: 'owner edit' },
      );
      await expect(
        promoteWorkspaceMemory(
          f.context,
          f.workspace,
          candidate.id,
          confirmation,
        ),
      ).rejects.toBeInstanceOf(EmployeeMemoryConflict);
      const archive = exact(corrected);
      await deleteWorkspaceMemory(
        f.context,
        f.workspace,
        candidate.id,
        archive,
      );
      await deleteWorkspaceMemory(
        f.context,
        f.workspace,
        candidate.id,
        archive,
      );
      expect(
        (
          await listWorkspaceMemoryRevisions(
            f.context,
            f.workspace,
            candidate.id,
            f.assignment,
          )
        ).map((r) => r.revision),
      ).toEqual([3, 2, 1]);
      const [counts] =
        await fixture.db`select (select count(*)::int from allrice_rag_chunks where memory_id=${candidate.id}) chunks,
      (select count(*)::int from allrice_audit_events where resource_id=${candidate.id} and action='memory.delete') archives`;
      expect(counts).toEqual({ chunks: 0, archives: 1 });
      const proposal = {
        workspaceId: f.workspace,
        content: '来源去重',
        sourceType: 'message',
        sourceId: f.messageId,
        lifecycleState: 'candidate',
      };
      const first = await createTraceableMemory(f.context, proposal);
      expect((await createTraceableMemory(f.context, proposal)).id).toBe(
        first.id,
      );
      const secondProposal = { ...proposal, content: '同条消息的另一项偏好' };
      const second = await createTraceableMemory(f.context, secondProposal);
      await deleteWorkspaceMemory(
        f.context,
        f.workspace,
        first.id,
        exact(first),
      );
      expect(await createTraceableMemory(f.context, secondProposal)).toEqual(
        second,
      );
      expect(
        await listWorkspaceMemoryRevisions(
          f.context,
          f.workspace,
          second.id,
          f.assignment,
        ),
      ).toHaveLength(1);
      await expect(
        createTraceableMemory(f.context, proposal),
      ).rejects.toBeInstanceOf(EmployeeMemoryConflict);
      await expect(
        createTraceableMemory(f.context, {
          ...proposal,
          content: 'Rephrased old discarded proposal',
        }),
      ).rejects.toBeInstanceOf(EmployeeMemoryConflict);
    });

    it('serializes historical v1 edit/confirmation, preserves one winning revision and rejects changed idempotency payloads', async () => {
      const f = await setup();
      const m = await legacyMemory(f, 'original', 'candidate');
      const result = await Promise.allSettled([
        promoteWorkspaceMemory(f.context, f.workspace, m.id, exact(m)),
        correctWorkspaceMemory(f.context, f.workspace, m.id, {
          ...exact(m),
          content: 'edited',
          reason: 'owner edit',
        }),
      ]);
      expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(result.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(
        await listWorkspaceMemoryRevisions(
          f.context,
          f.workspace,
          m.id,
          f.assignment,
        ),
      ).toHaveLength(2);
      const key = randomUUID();
      const input = {
        workspaceId: f.workspace,
        instanceId: f.assignment,
        idempotencyKey: key,
        content: 'same',
        sourceType: 'user',
      };
      const [a, b] = await Promise.all([
        createTraceableMemory(f.context, input),
        createTraceableMemory(f.context, input),
      ]);
      expect(a).toEqual(b);
      await expect(
        createTraceableMemory(f.context, { ...input, content: 'different' }),
      ).rejects.toBeInstanceOf(EmployeeMemoryConflict);
    });

    it('checks current membership, browser session and archived instance even with a stale context or an old receipt', async () => {
      const f = await setup();
      const m = await f.create('revocation', { lifecycleState: 'candidate' });
      const key = exact(m);
      await fixture.db`update allrice_memberships set active=false where id=${f.membership}`;
      await expect(
        promoteWorkspaceMemory(f.context, f.workspace, m.id, key),
      ).rejects.toThrow('authorization_denied');
      expect(
        await searchToolBrokerMemories(f.execution, 'revocation', 20),
      ).toEqual([]);
      await fixture.db`update allrice_memberships set active=true where id=${f.membership}`;
      await fixture.db`update allrice_employee_instances set archived_at=now() where id=${f.assignment}`;
      await expect(
        listWorkspaceMemories(f.context, f.workspace, undefined, {
          instanceId: f.assignment,
        }),
      ).rejects.toThrow('instance_archived');
      await fixture.db`update allrice_employee_instances set archived_at=null where id=${f.assignment}`;
      await fixture.db`update allrice_sessions set revoked_at=now() where id=${f.context.sessionId}`;
      await expect(
        promoteWorkspaceMemory(f.context, f.workspace, m.id, key),
      ).rejects.toThrow('authorization_denied');
    });

    it('rolls back content, revision, chunks and receipt when an audit write fails', async () => {
      const f = await setup();
      const m = await f.create('before');
      await fixture.db
        .unsafe(`create function fail_memory_audit() returns trigger language plpgsql as $$ begin
      if new.action='memory.correct' then raise exception 'synthetic audit failure'; end if; return new; end $$;
      create trigger fail_memory_audit before insert on allrice_audit_events for each row execute function fail_memory_audit()`);
      try {
        await expect(
          editActive(f, m, 'after', 'test atomicity'),
        ).rejects.toThrow('synthetic audit failure');
      } finally {
        await fixture.db.unsafe(
          'drop trigger fail_memory_audit on allrice_audit_events; drop function fail_memory_audit()',
        );
      }
      const [row] =
        await fixture.db`select content,revision from allrice_memories where id=${m.id}`;
      expect(row).toEqual({ content: 'before', revision: 1 });
      const [chunk] =
        await fixture.db`select content from allrice_rag_chunks where memory_id=${m.id}`;
      expect(chunk!.content).toBe('before');
      expect(
        await listWorkspaceMemoryRevisions(
          f.context,
          f.workspace,
          m.id,
          f.assignment,
        ),
      ).toHaveLength(1);
      const [ops] =
        await fixture.db`select count(*)::int n from allrice_employee_memory_operations where memory_id=${m.id}`;
      expect(ops!.n).toBe(1);
    });
  },
);
