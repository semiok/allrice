/** Actual isolated PostgreSQL, current identities and the public memory services.
 * No model calls. Test data and all schema changes live in runtime.fixture. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@allrice/contracts';
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
      const f = await createRunAuthorityFixture(fixture.db);
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
      await correctWorkspaceMemory(f.context, f.workspace, m.id, {
        ...exact(m),
        content: 'Corrected monthly report source',
        reason: 'Owner edited next-run preference',
      });
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

    it('requires the exact viewed revision and content, keeps retries idempotent, and does not revive discarded sources', async () => {
      const f = await setup();
      const candidate = await f.create('月报入口 A', {
        lifecycleState: 'candidate',
      });
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

    it('serializes concurrent edit/confirmation, preserves a single winning revision and rejects a changed idempotency payload', async () => {
      const f = await setup();
      const m = await f.create('original', { lifecycleState: 'candidate' });
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
          correctWorkspaceMemory(f.context, f.workspace, m.id, {
            ...exact(m),
            content: 'after',
            reason: 'test atomicity',
          }),
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
