/** Real native declaration/JSON-RPC -> Worker Broker -> isolated PostgreSQL.
 * The provider is deterministic; production admission still creates V1 Runs. */
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@allrice/contracts';
import * as client from '../../../../packages/database/src/core/client.ts';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import {
  authenticateSession,
  createSession,
} from '../../../../packages/database/src/identity.ts';
import { ensureGeneralEmployeeInstance } from '../../../../packages/database/src/employees/employee-instances.ts';
import { freezeEmployeeDocuments } from '../../../../packages/database/src/employees/employee-documents.ts';
import {
  deleteManagedEmployeeMemory,
  promoteManagedEmployeeMemory,
  correctManagedEmployeeMemory,
  createCheckpointMemoryCandidate,
} from '../../../../packages/database/src/workspace/service.ts';
import { contextCheckpointChecksum } from '../../../../packages/database/src/conversation/conversation-checkpoint.ts';
import { memoryPairDigest } from '../../../../packages/database/src/workspace/employee-memory.ts';
import { getPersonalEmployeeMemory } from '../../../../packages/database/src/employee-memory-management.ts';
import { executeRiceTool } from '../../src/tool-broker.ts';
import type { RiceToolCall } from '../../src/tool-broker/types.ts';
import { nativeBrokerRoundtrip } from '../../src/harness/dsh-native-broker.fixture.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('ordinary pair candidates through native/Worker storage', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  beforeAll(async () => {
    fixture = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await fixture?.close();
  });
  const pair = {
    summary: '日报按财务模板',
    details: '月结前不得外发\n完整说明🧑',
  };
  async function setup() {
    const f = await createRunAuthorityFixture(fixture.db, {
      toolNames: ['workspace.memory.remember'],
      allowedTools: ['workspace.memory.remember'],
    });
    await ensureGeneralEmployeeInstance(fixture.db, f.assignment);
    const context = (await authenticateSession(
      (await createSession(f.user)).token,
      { organizationId: f.org, workspaceId: f.workspace },
    ))!;
    const [row] = await fixture.db<
      { user_message_id: string }[]
    >`select user_message_id from allrice_employee_runs where run_id=${f.rootRunId}`;
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
        memberships: context.memberships,
        grants: [],
      },
    };
    const documents = { schemaVersion: 2 as const, user: '', memory: '' };
    const run = (call: RiceToolCall, current = execution) =>
      executeRiceTool({
        context: current,
        employeeDocuments: documents,
        capabilities: ['storage:write'],
        storageRoot: fixture.storageRoot,
        employeeId: f.employee,
        userMessageId: row!.user_message_id,
        userRequest: '请记住：日报按财务模板，月结前不得外发。',
        call,
      });
    const call = (id = randomUUID()): RiceToolCall => ({
      id,
      name: 'workspace.memory.remember',
      nativeSessionId: `native-${f.session}`,
      arguments: pair,
    });
    const mutation = (revision: number, currentPair = pair) => ({
      instanceId: f.assignment,
      expectedRevision: revision,
      pairDigest: memoryPairDigest(currentPair),
      idempotencyKey: randomUUID(),
    });
    return {
      ...f,
      context,
      execution,
      documents,
      run,
      call,
      mutation,
      messageId: row!.user_message_id,
    };
  }
  it('stores the exact human pair pending via decoded native tool arguments, without a read grant', async () => {
    const f = await setup();
    await fixture.db`update allrice_messages set content=${fixture.db.json({ text: '请记住：日报按财务模板，月结前不得外发。', citations: [] })} where id=${f.messageId}`;
    await nativeBrokerRoundtrip({
      canonicalName: 'workspace.memory.remember',
      wireName: 'workspace_memory_remember',
      run: { id: f.execution.runId, documents: f.documents },
      prompt: '请记住：日报按财务模板，月结前不得外发。',
      args: pair,
      invalidArgs: { ...pair, ownerId: f.user },
      forbiddenToolNames: [
        'workspace_memory_read',
        'workspace_memory_search',
        'workspace_experience_read',
      ],
      inspectSchema(schema) {
        const properties = schema.properties as Record<string, unknown>;
        expect(properties).toHaveProperty('summary');
        expect(properties).toHaveProperty('details');
        expect(properties).not.toHaveProperty('content');
        expect(properties).not.toHaveProperty('lifecycleState');
      },
      async onToolCall(call) {
        const result = await f.run(call);
        expect(JSON.parse(result.modelContent)).toMatchObject({
          content: pair.summary,
          lifecycleState: 'candidate',
          requiresConfirmation: true,
          notice: '已记为候选，确认后才生效',
        });
        expect(result.modelContent).not.toContain('月结前不得外发');
        return result;
      },
    });
    const rows =
      await fixture.db`select id,summary,details,content,lifecycle_state,trust_level,expires_at,source_type,source_id from allrice_memories where owner_id=${f.user}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ...pair,
      content: `${pair.summary}\n${pair.details}`,
      lifecycle_state: 'candidate',
      trust_level: 'derived',
      expires_at: null,
      source_type: 'message',
      source_id: f.messageId,
    });
    // The real production freeze factory has deliberately not switched versions.
    const projection = await freezeEmployeeDocuments(
      fixture.db,
      {
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        instanceId: f.assignment,
      },
      {},
      false,
    );
    expect(projection.employeeDocuments).not.toHaveProperty('schemaVersion');
    expect(projection.memories).toEqual([]);
  }, 60000);

  it('keeps operation identity across reclaim, rejects changed payload/old receipt, and permits a fresh same-pair proposal', async () => {
    const f = await setup(),
      aCall = f.call();
    const a = JSON.parse((await f.run(aCall)).modelContent) as { id: string };
    expect(
      JSON.parse(
        (
          await f.run(aCall, {
            ...f.execution,
            executionId: randomUUID(),
            worker: { ...f.execution.worker, id: randomUUID() },
          })
        ).modelContent,
      ).id,
    ).toBe(a.id);
    await expect(
      f.run({ ...aCall, arguments: { ...pair, details: 'changed' } }),
    ).rejects.toThrow();
    const [counts] =
      await fixture.db`select (select count(*)::int from allrice_memory_revisions where memory_id=${a.id}) revisions,
      (select count(*)::int from allrice_employee_memory_operations where memory_id=${a.id}) operations,
      (select count(*)::int from allrice_audit_events where resource_id=${a.id} and action='memory.create') creates`;
    expect(counts).toEqual({ revisions: 1, operations: 1, creates: 1 });
    const b = JSON.parse((await f.run(f.call())).modelContent) as {
      id: string;
    };
    const confirmed = await promoteManagedEmployeeMemory(
      f.context,
      f.workspace,
      b.id,
      f.mutation(1),
    );
    const frozen = await freezeEmployeeDocuments(
      fixture.db,
      {
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        instanceId: f.assignment,
      },
      {},
      false,
    );
    expect(frozen.memories).toContainEqual(
      expect.objectContaining({
        id: b.id,
        content: `${pair.summary}\n${pair.details}`,
      }),
    );
    expect(frozen.memories.map((memory) => memory.id)).not.toContain(a.id);
    await deleteManagedEmployeeMemory(
      f.context,
      f.workspace,
      a.id,
      f.mutation(1),
    );
    await expect(f.run(aCall)).rejects.toThrow();
    await expect(
      getPersonalEmployeeMemory(f.context, f.workspace, f.assignment, a.id),
    ).rejects.toThrow('not_found');
    const fresh = JSON.parse((await f.run(f.call())).modelContent) as {
      id: string;
      lifecycleState: string;
    };
    expect(fresh.id).not.toBe(a.id);
    expect(fresh.id).not.toBe(b.id);
    expect(fresh.lifecycleState).toBe('candidate');
    const edited = await correctManagedEmployeeMemory(
      f.context,
      f.workspace,
      b.id,
      {
        ...f.mutation(confirmed.revision),
        ...pair,
        reason: '本人编辑',
      },
    );
    expect(edited).toMatchObject({
      state: 'active',
      counts: { active: 1, pending: 1 },
    });
    const [deleted] =
      await fixture.db`select archived_at,revision from allrice_memories where id=${a.id}`;
    expect(deleted!.archived_at).not.toBeNull();
    expect(deleted!.revision).toBe(2);
  });

  it('accepts stored checkpoint pairs and legacy content without installing a producer', async () => {
    const f = await setup(),
      checkpointId = randomUUID();
    const checkpoint = {
      sessionId: f.session,
      harness: 'dsh' as const,
      threadId: `native-${f.session}`,
      generation: 0,
      coveredThroughMessageId: f.messageId,
      summaryVersion: 'extractive-v1' as const,
      summary: 'historical checkpoint',
      configChecksum: 'sha256:' + 'b'.repeat(64),
      estimatedTokens: 10,
      messageCount: 1,
    };
    await fixture.db`insert into allrice_context_checkpoints(id,organization_id,workspace_id,session_id,owner_id,harness,thread_id,thread_generation,covered_through_message_id,summary_version,summary,checksum,config_checksum,estimated_tokens,message_count)
      values(${checkpointId},${f.org},${f.workspace},${f.session},${f.user},'dsh',${`native-${f.session}`},0,${f.messageId},'extractive-v1','historical checkpoint',${contextCheckpointChecksum(checkpoint)},${checkpoint.configChecksum},10,1)`;
    const identity = {
      workspaceId: f.workspace,
      employeeId: f.employee,
      sessionId: f.session,
      checkpointId,
      sourceLabel: '历史候选',
    };
    const input = { ...identity, ...pair, idempotencyKey: randomUUID() };
    const first = await createCheckpointMemoryCandidate(f.context, input);
    expect(first.content).toBe(`${pair.summary}\n${pair.details}`);
    expect((await createCheckpointMemoryCandidate(f.context, input)).id).toBe(
      first.id,
    );
    await expect(
      createCheckpointMemoryCandidate(f.context, {
        ...input,
        details: 'changed',
      }),
    ).rejects.toThrow();
    await deleteManagedEmployeeMemory(
      f.context,
      f.workspace,
      first.id,
      f.mutation(first.revision),
    );
    await expect(
      createCheckpointMemoryCandidate(f.context, input),
    ).rejects.toThrow();
    const fresh = await createCheckpointMemoryCandidate(f.context, {
      ...input,
      idempotencyKey: randomUUID(),
    });
    expect(fresh.id).not.toBe(first.id);
    // One unarchived candidate per checkpoint remains the database contract.
    const legacyCheckpointId = randomUUID();
    const legacyCheckpoint = {
      ...checkpoint,
      summary: 'historical legacy checkpoint',
    };
    await fixture.db`insert into allrice_context_checkpoints(id,organization_id,workspace_id,session_id,owner_id,harness,thread_id,thread_generation,covered_through_message_id,summary_version,summary,checksum,config_checksum,estimated_tokens,message_count)
      values(${legacyCheckpointId},${f.org},${f.workspace},${f.session},${f.user},'dsh',${legacyCheckpoint.threadId},0,${f.messageId},'extractive-v1',${legacyCheckpoint.summary},${contextCheckpointChecksum(legacyCheckpoint)},${legacyCheckpoint.configChecksum},10,1)`;
    const legacy = await createCheckpointMemoryCandidate(f.context, {
      ...identity,
      checkpointId: legacyCheckpointId,
      content: '历史普通候选',
    });
    expect(legacy.lifecycleState).toBe('candidate');
    const [row] =
      await fixture.db`select summary,details,lifecycle_state,expires_at from allrice_memories where id=${fresh.id}`;
    expect(row).toEqual({
      ...pair,
      lifecycle_state: 'candidate',
      expires_at: null,
    });
    await expect(
      createCheckpointMemoryCandidate(f.context, {
        ...input,
        checkpointId: randomUUID(),
      }),
    ).rejects.toThrow('authorization_denied');
  });
});
