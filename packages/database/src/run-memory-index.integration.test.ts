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
import { memoryPairDigest } from './workspace/employee-memory.ts';
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
    }, 120000);

    it('shares a full100-summary initial charge and refuses a whole over-budget detail', async () => {
      const pair = { summary: '🧑'.repeat(40), details: '🧑'.repeat(2000) };
      const f = await setup(Array.from({ length: 100 }, () => pair));
      expect(f.projection.memoryContextStateV2.pins).toHaveLength(100);
      expect(f.projection.memoryContextStateV2.initial.bytes).toBe(18303);
      expect(f.projection.employeeDocuments.memory).toContain(
        `[100] ${pair.summary}（有说明）`,
      );
      expect(JSON.stringify(f.projection)).not.toContain(pair.details);
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
        { ...f.auth.scope, instanceId: f.assignment },
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
        { ...f.auth.scope, instanceId: f.assignment },
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
