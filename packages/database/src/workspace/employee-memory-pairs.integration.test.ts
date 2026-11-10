import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from '../core/client.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { createRunAuthorityFixture } from '../run-authority.fixture.ts';
import { authenticateSession, createSession } from '../identity.ts';
import {
  ensureGeneralEmployeeInstance,
  createEmployeeInstance,
} from '../employees/employee-instances.ts';
import {
  createPersonalEmployeeMemory,
  correctPersonalEmployeeMemory,
  createTraceableMemory,
  correctWorkspaceMemory,
  promoteWorkspaceMemory,
} from './service.ts';
import {
  memoryContentDigest,
  memoryPairDigest,
  legacyPersonalMemoryPair,
} from './employee-memory.ts';
import { PATCH } from '../../../../apps/web/app/api/v1/memories/[id]/route.ts';
import { seedLegacyEmployeeMemory } from './employee-memory-v1.fixture.ts';

const ports = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock('../../../../apps/web/lib/identity/session', () => ({
  getRequestContext: ports.context,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'personal pairs: complete owner writes and legacy PATCH protection',
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
      await ensureGeneralEmployeeInstance(fixture.db, f.assignment);
      const context = (await authenticateSession(
        (await createSession(f.user)).token,
        {
          organizationId: f.org,
          workspaceId: f.workspace,
        },
      ))!;
      const input = {
        workspaceId: f.workspace,
        instanceId: f.assignment,
        idempotencyKey: randomUUID(),
        summary: '日报按财务模板',
        details: '月结前不得外发',
      };
      return { ...f, context, input };
    }
    const expected = (m: {
      instanceId: string;
      revision: number;
      pairDigest: string;
    }) => ({
      instanceId: m.instanceId,
      expectedRevision: m.revision,
      pairDigest: m.pairDigest,
      idempotencyKey: randomUUID(),
    });
    async function snapshot(id: string) {
      const [row] = await fixture.db`select jsonb_build_object(
      'memory',(select to_jsonb(m) from allrice_memories m where id=${id}),
      'revisions',(select jsonb_agg(to_jsonb(r) order by revision) from allrice_memory_revisions r where memory_id=${id}),
      'receipts',(select jsonb_agg(to_jsonb(o) order by operation_key) from allrice_employee_memory_operations o where memory_id=${id}),
      'audit',(select jsonb_agg(to_jsonb(a) order by id) from allrice_audit_events a where resource_id=${id}),
      'chunks',(select jsonb_agg(to_jsonb(c) order by id) from allrice_rag_chunks c where memory_id=${id})
    ) value`;
      return row!.value;
    }
    it('saves an owner-requested complete Unicode pair, revision and current receipt atomically', async () => {
      const f = await setup();
      const input = {
        ...f.input,
        summary: '🧑'.repeat(40),
        details: '\t"\\\n' + '🧑'.repeat(1996),
      };
      const [a, b] = await Promise.all([
        createPersonalEmployeeMemory(f.context, input),
        createPersonalEmployeeMemory(f.context, input),
      ]);
      expect(a).toEqual(b);
      expect(a.pairDigest).toBe(memoryPairDigest(input));
      expect(a).not.toHaveProperty('content');
      const saved = await snapshot(a.id);
      expect(saved.memory).toMatchObject({
        content: input.summary,
        summary: input.summary,
        details: input.details,
        expires_at: null,
        revision: 1,
      });
      expect(saved.revisions).toHaveLength(1);
      expect(saved.revisions[0]).toMatchObject({
        summary: input.summary,
        details: input.details,
      });
      expect(saved.receipts).toHaveLength(1);
      expect(
        saved.audit.filter(
          (e: { action: string }) => e.action === 'memory.create',
        ),
      ).toHaveLength(1);
      await expect(
        fixture.db`update allrice_memories set summary=${'🧑'.repeat(41)} where id=${a.id}`,
      ).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'allrice_memories_pair_check',
      });
      await expect(
        fixture.db`update allrice_memories set details=${'🧑'.repeat(2001)} where id=${a.id}`,
      ).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'allrice_memories_pair_check',
      });
      await expect(
        fixture.db`update allrice_memories set summary=null where id=${a.id}`,
      ).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'allrice_memories_pair_check',
      });
      expect(await snapshot(a.id)).toEqual(saved);
      const legacyKey = randomUUID();
      await expect(
        createTraceableMemory(f.context, {
          workspaceId: f.workspace,
          instanceId: f.assignment,
          idempotencyKey: legacyKey,
          sourceType: 'user',
          content: '🧑'.repeat(2001),
        }),
      ).rejects.toMatchObject({ name: 'ZodError' });
      const [receipts] =
        await fixture.db`select count(*)::int count from allrice_employee_memory_operations where operation_key=${legacyKey}`;
      expect(receipts!.count).toBe(0);
    });
    it.each(['月结前不得外发', null])(
      'rejects a new legacy HTTP PATCH at the CURRENT revision, details=%j, with zero writes',
      async (details) => {
        const f = await setup();
        const m = await createPersonalEmployeeMemory(f.context, {
          ...f.input,
          details,
        });
        const before = await snapshot(m.id);
        ports.context.mockResolvedValue(f.context);
        const response = await PATCH(
          new Request(
            `http://localhost/api/v1/memories/${m.id}?workspaceId=${f.workspace}`,
            {
              method: 'PATCH',
              headers: {
                origin: 'http://localhost',
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                instanceId: m.instanceId,
                expectedRevision: m.revision,
                contentDigest: memoryContentDigest(m.summary),
                idempotencyKey: randomUUID(),
                content: '日报按财务新模板',
                reason: '本人修改',
              }),
            },
          ),
          { params: Promise.resolve({ id: m.id }) },
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: 'employee_memory_contract_changed',
        });
        expect(await snapshot(m.id)).toEqual(before);
      },
    );
    it('requires explicit details, CASes the complete pair, and only explicit null clears it', async () => {
      const f = await setup(),
        m = await createPersonalEmployeeMemory(f.context, f.input);
      const input = {
        ...expected(m),
        summary: m.summary,
        reason: '本人修改说明',
      };
      const before = await snapshot(m.id);
      await expect(
        correctPersonalEmployeeMemory(f.context, f.workspace, m.id, input),
      ).rejects.toThrow();
      await expect(
        correctPersonalEmployeeMemory(f.context, f.workspace, m.id, {
          ...input,
          details: null,
          pairDigest: memoryPairDigest({ summary: m.summary, details: null }),
        }),
      ).rejects.toThrow('employee_memory_conflict');
      expect(await snapshot(m.id)).toEqual(before);
      const update = { ...input, details: '月结前及审计期间不得外发' };
      const edited = await correctPersonalEmployeeMemory(
        f.context,
        f.workspace,
        m.id,
        update,
      );
      expect(edited.revision).toBe(2);
      expect(edited.pairDigest).not.toBe(m.pairDigest);
      expect(
        await correctPersonalEmployeeMemory(
          f.context,
          f.workspace,
          m.id,
          update,
        ),
      ).toEqual(edited);
      await expect(
        correctPersonalEmployeeMemory(f.context, f.workspace, m.id, {
          ...update,
          details: null,
        }),
      ).rejects.toThrow('employee_memory_conflict');
      const cleared = await correctPersonalEmployeeMemory(
        f.context,
        f.workspace,
        m.id,
        {
          ...expected(edited),
          summary: edited.summary,
          details: null,
          reason: '本人清除说明',
        },
      );
      expect(cleared).toMatchObject({ revision: 3, details: null });
      await expect(
        correctPersonalEmployeeMemory(f.context, f.workspace, m.id, update),
      ).rejects.toThrow('employee_memory_conflict');
    });
    it('mechanically adapts one genuine full-content legacy edit, replays its current receipt and then protects the pair', async () => {
      const f = await setup();
      const legacy = {
        workspaceId: f.workspace,
        instanceId: f.assignment,
        idempotencyKey: randomUUID(),
        content: '旧正文'.repeat(30),
        sourceType: 'user' as const,
      };
      const m = await seedLegacyEmployeeMemory(fixture.db, f.context, legacy);
      const input = {
        instanceId: f.assignment,
        expectedRevision: 1,
        contentDigest: m.contentDigest,
        idempotencyKey: randomUUID(),
        content: '完整新正文'.repeat(20),
        reason: '本人修改旧记忆',
      };
      const edited = await correctWorkspaceMemory(
        f.context,
        f.workspace,
        m.id,
        input,
      );
      expect(edited.content).toBe(input.content);
      expect(
        await correctWorkspaceMemory(f.context, f.workspace, m.id, input),
      ).toEqual(edited);
      const before = await snapshot(m.id);
      expect(before.memory).toMatchObject(
        legacyPersonalMemoryPair(input.content),
      );
      expect(before.revisions[0]).toMatchObject({
        content: m.content,
        summary: null,
        details: null,
      });
      await expect(
        correctWorkspaceMemory(f.context, f.workspace, m.id, {
          ...input,
          expectedRevision: 2,
          contentDigest: edited.contentDigest,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow('employee_memory_contract_changed');
      expect(await snapshot(m.id)).toEqual(before);
    });
    it('keeps tenant, instance, membership and idempotency authority ahead of paired writes', async () => {
      const f = await setup(),
        foreign = await setup();
      const m = await createPersonalEmployeeMemory(f.context, f.input);
      const other = await createEmployeeInstance(f.context, {
        workspaceId: f.workspace,
        assignmentId: f.assignment,
        requestId: randomUUID(),
        profile: { name: 'Other' },
      });
      const input = {
        ...expected(m),
        summary: m.summary,
        details: m.details,
        reason: '本人编辑',
      };
      const before = await snapshot(m.id);
      await expect(
        correctPersonalEmployeeMemory(
          foreign.context,
          foreign.workspace,
          m.id,
          { ...input, instanceId: foreign.assignment },
        ),
      ).rejects.toThrow('not_found');
      await expect(
        correctPersonalEmployeeMemory(f.context, f.workspace, m.id, {
          ...input,
          instanceId: other.id,
        }),
      ).rejects.toThrow('not_found');
      await expect(
        createPersonalEmployeeMemory(f.context, { ...f.input, details: null }),
      ).rejects.toThrow('employee_memory_conflict');
      expect(await snapshot(m.id)).toEqual(before);
      await fixture.db`update allrice_memberships set active=false where id=${f.membership}`;
      await expect(
        createPersonalEmployeeMemory(f.context, f.input),
      ).rejects.toThrow('authorization_denied');
      expect(await snapshot(m.id)).toEqual(before);
    });
    it('preserves legacy pending confirmation and the complete pair; the storage-only v2 editor does not implement pending CRUD', async () => {
      const f = await setup();
      const m = await createTraceableMemory(f.context, {
        workspaceId: f.workspace,
        instanceId: f.assignment,
        idempotencyKey: randomUUID(),
        sourceType: 'user',
        lifecycleState: 'candidate',
        content: '原候选'.repeat(30),
      });
      const pair = legacyPersonalMemoryPair(m.content),
        before = await snapshot(m.id);
      await expect(
        correctPersonalEmployeeMemory(f.context, f.workspace, m.id, {
          instanceId: f.assignment,
          expectedRevision: 1,
          pairDigest: memoryPairDigest(pair),
          idempotencyKey: randomUUID(),
          ...pair,
          reason: '未接入候选合同',
        }),
      ).rejects.toThrow('employee_memory_contract_changed');
      expect(await snapshot(m.id)).toEqual(before);
      const promoted = await promoteWorkspaceMemory(
        f.context,
        f.workspace,
        m.id,
        {
          instanceId: f.assignment,
          expectedRevision: 1,
          contentDigest: m.contentDigest,
          idempotencyKey: randomUUID(),
        },
      );
      expect(promoted.lifecycleState).toBe('durable');
      expect((await snapshot(m.id)).memory).toMatchObject(pair);
    });
    it('rolls back pair, revision, chunks, audit and receipt on the first failed audit', async () => {
      const f = await setup(),
        m = await createPersonalEmployeeMemory(f.context, f.input);
      const before = await snapshot(m.id);
      await fixture.db
        .unsafe(`create function fail_pair_audit() returns trigger language plpgsql as $$ begin
      if new.action='memory.correct' then raise exception 'synthetic pair audit failure'; end if; return new; end $$;
      create trigger fail_pair_audit before insert on allrice_audit_events for each row execute function fail_pair_audit()`);
      try {
        await expect(
          correctPersonalEmployeeMemory(f.context, f.workspace, m.id, {
            ...expected(m),
            summary: m.summary,
            details: null,
            reason: '本人清除说明',
          }),
        ).rejects.toThrow('synthetic pair audit failure');
      } finally {
        await fixture.db.unsafe(
          'drop trigger fail_pair_audit on allrice_audit_events; drop function fail_pair_audit()',
        );
      }
      expect(await snapshot(m.id)).toEqual(before);
    });
  },
);
