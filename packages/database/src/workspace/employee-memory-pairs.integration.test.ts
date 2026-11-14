import { randomUUID } from 'node:crypto';
import { ApiErrorSchema } from '@allrice/contracts';
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
  promoteManagedEmployeeMemory,
} from './service.ts';
import { memoryContentDigest, memoryPairDigest } from './employee-memory.ts';
import { seedPersonalMemoryPair } from './employee-memory-pair.fixture.ts';

const ports = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock('../../../../apps/web/lib/identity/session', () => ({
  getRequestContext: ports.context,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'personal pairs: complete owner writes and retired full-content PATCH rejection',
  () => {
    let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let PATCH: (
      request: Request,
      route: { params: Promise<{ id: string }> },
    ) => Promise<Response>;
    beforeAll(async () => {
      fixture = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      // Web uses bundler resolution; its own typecheck still checks this real
      // route, without pulling it into the database's NodeNext compilation.
      const routePath =
        '../../../../apps/web/app/api/v1/memories/[id]/route.ts';
      ({ PATCH } = (await import(routePath)) as { PATCH: typeof PATCH });
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
      'audit',(select jsonb_agg(to_jsonb(a) order by id) from allrice_audit_events a where resource_id=${id})
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
        content: `${input.summary}\n${input.details}`,
        summary: input.summary,
        details: input.details,
        expires_at: null,
        revision: 1,
      });
      expect(saved.revisions).toHaveLength(1);
      expect(saved.revisions[0]).toMatchObject({
        content: `${input.summary}\n${input.details}`,
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
        expect(before.memory.content).toBe(
          details === null ? m.summary : `${m.summary}\n${details}`,
        );
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
                contentDigest: memoryContentDigest(before.memory.content),
                idempotencyKey: randomUUID(),
                content: '日报按财务新模板',
                reason: '本人修改',
              }),
            },
          ),
          { params: Promise.resolve({ id: m.id }) },
        );
        expect(response.status).toBe(400);
        expect(ApiErrorSchema.parse(await response.json()).error).toMatchObject(
          {
            code: 'INVALID_REQUEST',
            retryable: false,
          },
        );
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
      const afterEdit = await snapshot(m.id);
      expect(afterEdit.memory.content).toBe(
        `${update.summary}\n${update.details}`,
      );
      expect(afterEdit.revisions[0]).toEqual(before.revisions[0]);
      expect(afterEdit.revisions[1].content).toBe(afterEdit.memory.content);
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
      const afterClear = await snapshot(m.id);
      expect(afterClear.memory.content).toBe(cleared.summary);
      expect(afterClear.revisions[2].content).toBe(cleared.summary);
      await expect(
        correctPersonalEmployeeMemory(f.context, f.workspace, m.id, update),
      ).rejects.toThrow('employee_memory_conflict');
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
    it('confirms complete V2 candidates by pair CAS or owner save', async () => {
      const f = await setup();
      const input = {
        workspaceId: f.workspace,
        instanceId: f.assignment,
        summary: '原候选',
        details: '完整约束',
      };
      const m = await seedPersonalMemoryPair(fixture.db, f.context, input);
      const promoted = await promoteManagedEmployeeMemory(
        f.context,
        f.workspace,
        m.id,
        { ...expected({ ...m, instanceId: f.assignment }) },
      );
      expect(promoted.state).toBe('active');
      expect((await snapshot(m.id)).memory).toMatchObject({
        summary: input.summary,
        details: input.details,
      });
      const pending = await seedPersonalMemoryPair(fixture.db, f.context, {
        ...input,
        summary: '另一个待确认候选',
      });
      const saved = await correctPersonalEmployeeMemory(
        f.context,
        f.workspace,
        pending.id,
        {
          ...expected({ ...pending, instanceId: f.assignment }),
          summary: '本人修改并确认',
          details: '完整保存说明',
          reason: '本人编辑',
        },
      );
      expect(saved).toMatchObject({
        summary: '本人修改并确认',
        details: '完整保存说明',
        revision: 2,
      });
      expect((await snapshot(pending.id)).memory).toMatchObject({
        lifecycle_state: 'durable',
        trust_level: 'user_confirmed',
        expires_at: null,
      });
    });
    it('rolls back pair, revision, audit and receipt on the first failed audit', async () => {
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
