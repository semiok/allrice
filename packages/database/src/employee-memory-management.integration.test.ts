import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ApiErrorSchema,
  EmployeeMemoryListSchema,
  EmployeeMemoryDetailResponseSchema,
  EmployeeMemoryWriteResponseSchema,
  type EmployeeMemoryRecord,
  type RequestContext,
} from '@allrice/contracts';
import * as client from './core/client.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createRunAuthorityFixture } from './run-authority.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from './identity.ts';
import {
  ensureGeneralEmployeeInstance,
  createEmployeeInstance,
} from './employees/employee-instances.ts';
import {
  createTraceableMemory,
  listWorkspaceMemoryRevisions,
} from './workspace/service.ts';
import {
  memoryContentDigest,
  memoryPairDigest,
} from './workspace/employee-memory.ts';
import { freezeEmployeeDocuments } from './employees/employee-documents.ts';

const ports = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock('../../../apps/web/lib/identity/session', () => ({
  getRequestContext: ports.context,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'memory management v2: real owner HTTP, atomic admission and administrator audit',
  () => {
    type ReadHandler = (request: Request) => Promise<Response>;
    type TargetHandler<T> = (
      request: Request,
      route: { params: Promise<T> },
    ) => Promise<Response>;
    type MemoryHandler = TargetHandler<{ id: string }>;
    let manage: ReadHandler, create: ReadHandler, rawList: ReadHandler;
    let detail: MemoryHandler,
      edit: MemoryHandler,
      remove: MemoryHandler,
      promote: MemoryHandler,
      pin: MemoryHandler;
    let adminList: TargetHandler<{ organizationId: string }>;
    let adminDetail: TargetHandler<{ organizationId: string; id: string }>;
    let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let admin: RequestContext;
    beforeAll(async () => {
      fixture = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      // Follow the existing cross-Web route integration seam: runtime-load real
      // handlers while Web's own bundler typecheck remains responsible for them.
      const managePath =
        '../../../apps/web/app/api/v1/memories/manage/route.ts';
      const createPath = '../../../apps/web/app/api/v1/memories/route.ts';
      const recordPath = '../../../apps/web/app/api/v1/memories/[id]/route.ts';
      const promotePath =
        '../../../apps/web/app/api/v1/memories/[id]/promote/route.ts';
      const pinPath = '../../../apps/web/app/api/v1/memories/[id]/pin/route.ts';
      const adminListPath =
        '../../../apps/web/app/api/v1/admin/organizations/[organizationId]/employee-memories/route.ts';
      const adminDetailPath =
        '../../../apps/web/app/api/v1/admin/organizations/[organizationId]/employee-memories/[id]/route.ts';
      ({ GET: manage } = (await import(managePath)) as { GET: ReadHandler });
      ({ POST: create, GET: rawList } = (await import(createPath)) as {
        POST: ReadHandler;
        GET: ReadHandler;
      });
      ({
        GET: detail,
        PATCH: edit,
        DELETE: remove,
      } = (await import(recordPath)) as {
        GET: MemoryHandler;
        PATCH: MemoryHandler;
        DELETE: MemoryHandler;
      });
      ({ POST: promote } = (await import(promotePath)) as {
        POST: MemoryHandler;
      });
      ({ POST: pin } = (await import(pinPath)) as { POST: MemoryHandler });
      ({ GET: adminList } = (await import(adminListPath)) as {
        GET: typeof adminList;
      });
      ({ GET: adminDetail } = (await import(adminDetailPath)) as {
        GET: typeof adminDetail;
      });
      const principal = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'allrice-platform',
        organizationName: 'Platform',
        workspaceSlug: 'default',
        workspaceName: 'Default',
        email: 'memory-admin@example.test',
        displayName: 'Admin',
        role: 'member',
      });
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', principal.user.email);
      admin = (await authenticateSession(
        (await createSession(principal.user.id)).token,
      ))!;
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    }, 30000);
    async function setup() {
      const f = await createRunAuthorityFixture(fixture.db);
      await ensureGeneralEmployeeInstance(fixture.db, f.assignment);
      const context = (await authenticateSession(
        (await createSession(f.user)).token,
        { organizationId: f.org, workspaceId: f.workspace },
      ))!;
      return { ...f, context };
    }
    type Fixture = Awaited<ReturnType<typeof setup>>;
    function request(
      f: Fixture,
      method: string,
      path = '/api/v1/memories',
      body?: unknown,
      query: Record<string, string> = {},
    ) {
      ports.context.mockResolvedValue(f.context);
      const url = new URL(path, 'http://localhost');
      for (const [key, value] of Object.entries({
        workspaceId: f.workspace,
        instanceId: f.assignment,
        ...query,
      }))
        url.searchParams.set(key, value);
      return new Request(url, {
        method,
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    const params = (id: string) => ({ params: Promise.resolve({ id }) });
    const cas = (f: Fixture, row: EmployeeMemoryRecord) => ({
      instanceId: f.assignment,
      expectedRevision: row.revision,
      pairDigest: row.pairDigest,
      idempotencyKey: randomUUID(),
    });
    async function page(f: Fixture, query: Record<string, string> = {}) {
      const response = await manage(
        request(f, 'GET', '/api/v1/memories/manage', undefined, query),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      return EmployeeMemoryListSchema.parse(await response.json());
    }
    async function read(f: Fixture, id: string) {
      const response = await detail(
        request(f, 'GET', `/api/v1/memories/${id}`),
        params(id),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      return EmployeeMemoryDetailResponseSchema.parse(await response.json())
        .memory;
    }
    async function add(f: Fixture, overrides: Record<string, unknown> = {}) {
      const response = await create(
        request(f, 'POST', undefined, {
          workspaceId: f.workspace,
          instanceId: f.assignment,
          idempotencyKey: randomUUID(),
          summary: '本人新增记忆',
          details: '限定条件不得丢失',
          ...overrides,
        }),
      );
      expect(response.status).toBe(201);
      return EmployeeMemoryWriteResponseSchema.parse(await response.json());
    }
    async function snapshot(id: string) {
      const [row] = await fixture.db`select jsonb_build_object(
      'memory',(select to_jsonb(m) from allrice_memories m where id=${id}),
      'revisions',(select jsonb_agg(to_jsonb(r) order by revision) from allrice_memory_revisions r where memory_id=${id}),
      'receipts',(select jsonb_agg(to_jsonb(o) order by operation_key) from allrice_employee_memory_operations o where memory_id=${id}),
      'audit',(select jsonb_agg(to_jsonb(a) order by id) from allrice_audit_events a where resource_id=${id}),
      'chunks',(select jsonb_agg(to_jsonb(c) order by id) from allrice_rag_chunks c where memory_id=${id})) value`;
      return row!.value;
    }
    async function conflict(response: Response, reason: string) {
      expect(response.status).toBe(409);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const body = ApiErrorSchema.parse(await response.json());
      expect(body.error).toMatchObject({
        code: 'CONFLICT',
        retryable: false,
        details: { domain: 'employee_memory', reason },
      });
      return body.error.details!;
    }
    async function seed(
      f: Fixture,
      count: number,
      state: 'active' | 'pending' = 'active',
    ) {
      // Valid current pair fixtures are inserted directly, never downgraded into v1.
      const rows = await fixture.db<
        { id: string }[]
      >`insert into allrice_memories
      (organization_id,workspace_id,employee_id,owner_id,instance_id,content,summary,details,source_type,trust_level,lifecycle_state,captured_at,created_at,updated_at)
      select ${f.org},${f.workspace},${f.employee},${f.user},${f.assignment},'条目'||n,'条目'||n,'完整说明'||n,'user','user_confirmed',${state === 'active' ? 'durable' : 'candidate'},
        '2024-01-01T00:00:00Z'::timestamptz+n*interval '1 second','2025-01-01T00:00:00Z'::timestamptz+n*interval '1 second',
        '2026-01-01T00:00:00Z'::timestamptz+${state === 'active' ? 1 : -1}*n*interval '1 second'
      from generate_series(1,${count}) n returning id`;
      if (rows.length)
        await fixture.db`insert into allrice_memory_revisions
      (organization_id,workspace_id,memory_id,revision,content,summary,details,trust_level,lifecycle_state,memory_class,confidence,expires_at,reason,changed_by)
      select organization_id,workspace_id,id,revision,content,summary,details,trust_level,lifecycle_state,memory_class,confidence,expires_at,'synthetic current pair baseline',owner_id
      from allrice_memories where id=any(${rows.map((row) => row.id)}::uuid[])`;
      return rows.map((row) => row.id);
    }
    async function pending(
      f: Fixture,
      content = '待本人确认',
      sourceType:
        | 'user'
        | 'message'
        | 'checkpoint'
        | 'tool'
        | 'connector'
        | 'file' = 'user',
      sourceId: string | null = null,
    ) {
      const row = await createTraceableMemory(f.context, {
        workspaceId: f.workspace,
        instanceId: f.assignment,
        sourceType,
        sourceId,
        idempotencyKey: randomUUID(),
        lifecycleState: 'candidate',
        content,
      });
      return read(f, row.id);
    }

    it('returns an empty full list; creates a complete Unicode pair with server-owned fields and real capturedAt', async () => {
      const f = await setup();
      expect(await page(f)).toEqual({
        schemaVersion: 2,
        workspaceId: f.workspace,
        instanceId: f.assignment,
        counts: { active: 0, pending: 0, maxActive: 100 },
        active: [],
        pending: [],
      });
      const summary = '🧑'.repeat(40),
        details = '\t"\\\n' + '🧑'.repeat(1996);
      const result = await add(f, { summary, details });
      expect(result.counts).toEqual({ active: 1, pending: 0, maxActive: 100 });
      expect(result.memory).toMatchObject({
        summary,
        details,
        hasDetails: true,
        state: 'active',
        revision: 1,
        pairDigest: memoryPairDigest({ summary, details }),
      });
      const before = await snapshot(result.memory.id);
      expect(before.memory).toMatchObject({
        owner_id: f.user,
        employee_id: f.employee,
        visibility: 'private',
        source_type: 'user',
        source_id: null,
        lifecycle_state: 'durable',
        trust_level: 'user_confirmed',
        expires_at: null,
        content: summary,
        summary,
        details,
      });
      expect(before.revisions).toHaveLength(1);
      expect(before.receipts).toHaveLength(1);
      expect(before.audit).toHaveLength(1);
      expect(before.chunks).toHaveLength(1);
      await fixture.db`update allrice_memories set captured_at='2024-02-03T00:00:00Z'::timestamptz,created_at='2025-04-05T00:00:00Z'::timestamptz where id=${result.memory.id}`;
      const current = await read(f, result.memory.id);
      expect(current.capturedAt).toBe('2024-02-03T00:00:00.000Z');
      const listed = await page(f);
      expect(listed.active[0]).toEqual(
        Object.fromEntries(
          Object.entries(current).filter(([key]) => key !== 'details'),
        ),
      );
      expect(Object.keys(current).sort()).toEqual(
        [
          'id',
          'summary',
          'details',
          'hasDetails',
          'state',
          'revision',
          'pairDigest',
          'capturedAt',
          'updatedAt',
        ].sort(),
      );
      expect(JSON.stringify(listed)).not.toContain(details);
      const noDetail = await add(f, {
        summary: '新条目可以省略说明',
        details: undefined,
      });
      expect(noDetail.memory).toMatchObject({
        details: null,
        hasDetails: false,
      });
      const forbidden = await create(
        request(f, 'POST', undefined, {
          workspaceId: f.workspace,
          instanceId: f.assignment,
          summary: '不能指定来源',
          idempotencyKey: randomUUID(),
          sourceType: 'tool',
          ownerId: admin.actor.id,
        }),
      );
      expect(forbidden.status).toBe(400);
    });

    it('returns all 100 active and more than 50 pending, ordered by distinct real timestamps, without source/profile/detail fields', async () => {
      const f = await setup();
      await seed(f, 100);
      await seed(f, 73, 'pending');
      const result = await page(f);
      expect(result.counts).toEqual({
        active: 100,
        pending: 73,
        maxActive: 100,
      });
      expect(result.active).toHaveLength(100);
      expect(result.pending).toHaveLength(73);
      expect(
        new Set([...result.active, ...result.pending].map((row) => row.id))
          .size,
      ).toBe(173);
      expect(result.active.map((row) => row.summary)).toEqual(
        Array.from({ length: 100 }, (_, n) => '条目' + (100 - n)),
      );
      expect(result.pending.map((row) => row.summary)).toEqual(
        Array.from({ length: 73 }, (_, n) => '条目' + (73 - n)),
      );
      const ties = result.pending.slice(0, 2).map((row) => row.id);
      await fixture.db`update allrice_memories set captured_at='2024-02-01T00:00:00Z'::timestamptz where id=any(${ties}::uuid[])`;
      expect((await page(f)).pending.slice(0, 2).map((row) => row.id)).toEqual(
        ties.sort().reverse(),
      );
      for (const row of [...result.active, ...result.pending]) {
        expect(Object.keys(row).sort()).toEqual(
          [
            'id',
            'summary',
            'hasDetails',
            'state',
            'revision',
            'pairDigest',
            'capturedAt',
            'updatedAt',
          ].sort(),
        );
        expect(row.capturedAt).not.toBe(row.updatedAt);
      }
      const retiredQueries: Record<string, string>[] = [
        { state: 'archived' },
        { after: result.active[0]!.id },
        { search: '条目' },
        { pin: 'true' },
        { preview: '1' },
      ];
      for (const query of retiredQueries) {
        const response = await manage(
          request(f, 'GET', '/api/v1/memories/manage', undefined, query),
        );
        expect(response.status).toBe(400);
      }
      const expired = result.active[0]!;
      await fixture.db`update allrice_memories set captured_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' where id=${expired.id}`;
      expect((await page(f)).active.map((row) => row.id)).not.toContain(
        expired.id,
      );
      expect((await detail(request(f, 'GET'), params(expired.id))).status).toBe(
        404,
      );
    });

    it('requires explicit details, changes the entire pair atomically and preserves capturedAt and old raw revisions', async () => {
      const f = await setup(),
        original = (await add(f)).memory;
      const input = {
        ...cas(f, original),
        summary: original.summary,
        reason: '本人编辑',
      };
      const before = await snapshot(original.id);
      const missing = await edit(
        request(f, 'PATCH', undefined, input),
        params(original.id),
      );
      expect(missing.status).toBe(400);
      expect(await snapshot(original.id)).toEqual(before);
      const changed = await edit(
        request(f, 'PATCH', undefined, {
          ...input,
          details: '新增范围，末尾不得外发',
        }),
        params(original.id),
      );
      expect(changed.status).toBe(200);
      const result = EmployeeMemoryWriteResponseSchema.parse(
        await changed.json(),
      );
      expect(result.memory).toMatchObject({
        summary: original.summary,
        details: '新增范围，末尾不得外发',
        revision: 2,
        capturedAt: original.capturedAt,
      });
      expect(result.memory.pairDigest).not.toBe(original.pairDigest);
      const after = await snapshot(original.id);
      expect(after.revisions[0]).toEqual(before.revisions[0]);
      const unseenDetails = {
        ...cas(f, result.memory),
        pairDigest: original.pairDigest,
      };
      await conflict(
        await remove(
          request(f, 'DELETE', undefined, unseenDetails),
          params(original.id),
        ),
        'cas_conflict',
      );
      await conflict(
        await promote(
          request(f, 'POST', undefined, {
            ...unseenDetails,
            idempotencyKey: randomUUID(),
          }),
          params(original.id),
        ),
        'cas_conflict',
      );
      await conflict(
        await edit(
          request(f, 'PATCH', undefined, {
            ...unseenDetails,
            idempotencyKey: randomUUID(),
            summary: original.summary,
            details: null,
            reason: '未读当前说明',
          }),
          params(original.id),
        ),
        'cas_conflict',
      );
      expect(await snapshot(original.id)).toEqual(after);
      const stale = await edit(
        request(f, 'PATCH', undefined, {
          ...input,
          idempotencyKey: randomUUID(),
          details: null,
        }),
        params(original.id),
      );
      await conflict(stale, 'cas_conflict');
      expect(await snapshot(original.id)).toEqual(after);
      const cleared = await edit(
        request(f, 'PATCH', undefined, {
          ...cas(f, result.memory),
          summary: result.memory.summary,
          details: null,
          reason: '本人清除说明',
        }),
        params(original.id),
      );
      const saved = EmployeeMemoryWriteResponseSchema.parse(
        await cleared.json(),
      );
      expect(saved.memory).toMatchObject({
        revision: 3,
        details: null,
        hasDetails: false,
      });
      const legacy = await edit(
        request(f, 'PATCH', undefined, {
          instanceId: f.assignment,
          expectedRevision: saved.memory.revision,
          contentDigest: memoryContentDigest(saved.memory.summary),
          idempotencyKey: randomUUID(),
          content: '旧编辑器不能清说明',
          reason: '本人编辑',
        }),
        params(original.id),
      );
      expect(await conflict(legacy, 'contract_changed')).toEqual({
        domain: 'employee_memory',
        reason: 'contract_changed',
        requiredSchemaVersion: 2,
      });
      expect((await snapshot(original.id)).memory).toMatchObject({
        revision: 3,
        details: null,
      });
    });

    it('confirms pending by full-pair save or promote, clears a real future expiry, and does not add capacity twice', async () => {
      const f = await setup();
      const a = await pending(f, '候选原文'.repeat(20));
      await fixture.db`update allrice_memories set expires_at=clock_timestamp()+interval '1 day' where id=${a.id}`;
      const input = {
        ...cas(f, a),
        summary: '本人修改候选并确认',
        details: '确认时保留全部限定条件',
        reason: '本人编辑',
      };
      const response = await edit(
        request(f, 'PATCH', undefined, input),
        params(a.id),
      );
      expect(response.status).toBe(200);
      const saved = EmployeeMemoryWriteResponseSchema.parse(
        await response.json(),
      );
      expect(saved.memory).toMatchObject({
        state: 'active',
        revision: 2,
        capturedAt: a.capturedAt,
        summary: input.summary,
        details: input.details,
      });
      expect(saved.counts).toEqual({ active: 1, pending: 0, maxActive: 100 });
      expect((await snapshot(a.id)).memory).toMatchObject({
        expires_at: null,
        lifecycle_state: 'durable',
        trust_level: 'user_confirmed',
      });
      const b = await pending(f, '不修改正文直接确认');
      const confirmation = cas(f, b);
      const promoted = await promote(
        request(f, 'POST', undefined, confirmation),
        params(b.id),
      );
      const active = EmployeeMemoryWriteResponseSchema.parse(
        await promoted.json(),
      );
      expect(active.memory).toMatchObject({
        state: 'active',
        summary: b.summary,
        details: b.details,
        revision: 2,
        capturedAt: b.capturedAt,
      });
      expect(active.counts.active).toBe(2);
      const before = await snapshot(b.id);
      const replay = await promote(
        request(f, 'POST', undefined, confirmation),
        params(b.id),
      );
      expect(await replay.json()).toEqual(active);
      expect(await snapshot(b.id)).toEqual(before);
      const currentConfirmation = await promote(
        request(f, 'POST', undefined, cas(f, active.memory)),
        params(b.id),
      );
      expect(
        EmployeeMemoryWriteResponseSchema.parse(
          await currentConfirmation.json(),
        ).memory.revision,
      ).toBe(2);
      expect((await page(f)).counts).toEqual({
        active: 2,
        pending: 0,
        maxActive: 100,
      });
    });

    it.each([
      ['create', 'promote'],
      ['promote', 'patch'],
      ['create', 'patch'],
    ] as const)(
      'admits exactly one %s/%s at 99 active',
      async (first, second) => {
        const f = await setup();
        await seed(f, 99);
        const a = await pending(f, '待确认甲'),
          b = await pending(f, '待确认乙');
        async function increment(action: string, row: EmployeeMemoryRecord) {
          if (action === 'create')
            return create(
              request(f, 'POST', undefined, {
                workspaceId: f.workspace,
                instanceId: f.assignment,
                summary: '第100个名额',
                details: null,
                idempotencyKey: randomUUID(),
              }),
            );
          if (action === 'promote')
            return promote(
              request(f, 'POST', undefined, cas(f, row)),
              params(row.id),
            );
          return edit(
            request(f, 'PATCH', undefined, {
              ...cas(f, row),
              summary: row.summary,
              details: row.details,
              reason: '本人保存候选',
            }),
            params(row.id),
          );
        }
        const results = await Promise.all([
          increment(first, a),
          increment(second, b),
        ]);
        expect(
          results.filter((r) => r.status === 200 || r.status === 201),
        ).toHaveLength(1);
        const denied = results.find((r) => r.status === 409)!;
        expect(await conflict(denied, 'memory_limit_reached')).toEqual({
          domain: 'employee_memory',
          reason: 'memory_limit_reached',
          counts: { active: 100, maxActive: 100 },
        });
        expect((await page(f)).counts.active).toBe(100);
      },
    );

    it('rejects full-capacity pending save/promote with zero writes while allowing active edit and exact replay', async () => {
      const f = await setup();
      const ids = await seed(f, 100);
      const candidate = await pending(f);
      const before = await snapshot(candidate.id);
      await conflict(
        await edit(
          request(f, 'PATCH', undefined, {
            ...cas(f, candidate),
            summary: '不能半保存',
            details: '不能半确认',
            reason: '本人编辑',
          }),
          params(candidate.id),
        ),
        'memory_limit_reached',
      );
      await conflict(
        await promote(
          request(f, 'POST', undefined, cas(f, candidate)),
          params(candidate.id),
        ),
        'memory_limit_reached',
      );
      const legacyKey = randomUUID();
      await conflict(
        await create(
          request(f, 'POST', undefined, {
            workspaceId: f.workspace,
            instanceId: f.assignment,
            sourceType: 'user',
            content: '旧创建不能绕过名额',
            idempotencyKey: legacyKey,
          }),
        ),
        'memory_limit_reached',
      );
      expect(
        await fixture.db`select operation_key from allrice_employee_memory_operations where operation_key=${legacyKey}`,
      ).toHaveLength(0);
      expect(await snapshot(candidate.id)).toEqual(before);
      const active = await read(f, ids[0]!);
      const input = {
        ...cas(f, active),
        summary: active.summary,
        details: '满额仍可修改完整详情',
        reason: '本人编辑',
      };
      const response = await edit(
        request(f, 'PATCH', undefined, input),
        params(active.id),
      );
      const result = EmployeeMemoryWriteResponseSchema.parse(
        await response.json(),
      );
      expect(result.counts).toEqual({
        active: 100,
        pending: 1,
        maxActive: 100,
      });
      const confirmation = await promote(
        request(f, 'POST', undefined, cas(f, result.memory)),
        params(active.id),
      );
      expect(
        EmployeeMemoryWriteResponseSchema.parse(await confirmation.json())
          .memory.revision,
      ).toBe(result.memory.revision);
      const after = await snapshot(active.id);
      const replay = await edit(
        request(f, 'PATCH', undefined, input),
        params(active.id),
      );
      expect(await replay.json()).toEqual(result);
      expect(await snapshot(active.id)).toEqual(after);
      await conflict(
        await edit(
          request(f, 'PATCH', undefined, { ...input, details: '同key换内容' }),
          params(active.id),
        ),
        'idempotency_conflict',
      );
      await conflict(
        await promote(
          request(f, 'POST', undefined, {
            ...cas(f, result.memory),
            idempotencyKey: input.idempotencyKey,
          }),
          params(active.id),
        ),
        'idempotency_conflict',
      );
      const newer = await edit(
        request(f, 'PATCH', undefined, {
          ...cas(f, result.memory),
          summary: active.summary,
          details: null,
          reason: '再次修改',
        }),
        params(active.id),
      );
      expect(newer.status).toBe(200);
      await conflict(
        await edit(request(f, 'PATCH', undefined, input), params(active.id)),
        'idempotency_conflict',
      );
    });

    it('serializes deletion against confirmation at 100 and only releases the deleted identity', async () => {
      const f = await setup();
      const ids = await seed(f, 100);
      const current = await read(f, ids[0]!),
        candidate = await pending(f);
      const input = cas(f, current);
      const [deleted, confirmed] = await Promise.all([
        remove(request(f, 'DELETE', undefined, input), params(current.id)),
        promote(
          request(f, 'POST', undefined, cas(f, candidate)),
          params(candidate.id),
        ),
      ]);
      expect(deleted.status).toBe(204);
      expect(await deleted.text()).toBe('');
      expect([200, 409]).toContain(confirmed.status);
      const result = await page(f);
      expect(result.counts.active).toBe(confirmed.status === 200 ? 100 : 99);
      expect(result.active.map((row) => row.id)).not.toContain(current.id);
      expect((await detail(request(f, 'GET'), params(current.id))).status).toBe(
        404,
      );
      const before = await snapshot(current.id);
      expect(
        (
          await remove(
            request(f, 'DELETE', undefined, input),
            params(current.id),
          )
        ).status,
      ).toBe(204);
      expect(await snapshot(current.id)).toEqual(before);
      await conflict(
        await remove(
          request(f, 'DELETE', undefined, {
            ...input,
            pairDigest: memoryPairDigest({
              summary: current.summary,
              details: null,
            }),
          }),
          params(current.id),
        ),
        'idempotency_conflict',
      );
      const revived = await promote(
        request(f, 'POST', undefined, cas(f, current)),
        params(current.id),
      );
      expect(revived.status).toBe(404);
      expect((await snapshot(current.id)).memory).toMatchObject({
        revision: 2,
        archived_at: expect.any(String),
      });
    });

    it('preserves current creation replay at capacity and lets background candidates bypass the foreground quota lock', async () => {
      const f = await setup();
      const input = {
        workspaceId: f.workspace,
        instanceId: f.assignment,
        summary: '先前成功创建',
        details: '仍是当前修订',
        idempotencyKey: randomUUID(),
      };
      const created = await create(request(f, 'POST', undefined, input));
      const result = EmployeeMemoryWriteResponseSchema.parse(
        await created.json(),
      );
      await seed(f, 99);
      const before = await snapshot(result.memory.id);
      const replay = await create(request(f, 'POST', undefined, input));
      expect(await replay.json()).toEqual(result);
      expect(await snapshot(result.memory.id)).toEqual(before);
      let release!: () => void, acquired!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const blocker = fixture.db.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`memory-order:${f.org}:${f.user}:${f.assignment}`},0))`;
        acquired();
        await held;
      });
      await ready;
      const candidateWrite = createTraceableMemory(f.context, {
        workspaceId: f.workspace,
        instanceId: f.assignment,
        sourceType: 'user',
        content: '后台仅产候选',
        lifecycleState: 'candidate',
        idempotencyKey: randomUUID(),
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const candidate = await Promise.race([
          candidateWrite,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    'Candidate production waited for the foreground quota lock',
                  ),
                ),
              5000,
            );
          }),
        ]);
        expect(candidate.lifecycleState).toBe('candidate');
      } finally {
        clearTimeout(timeout);
        release();
        await blocker;
        await candidateWrite.catch(() => undefined);
      }
      expect((await page(f)).counts).toEqual({
        active: 100,
        pending: 1,
        maxActive: 100,
      });
    });

    it.each(['pending', 'active'] as const)(
      'deleting same-source %s A never hides or disables B or its full-capacity active edits',
      async (state) => {
        const f = await setup();
        const [origin] = await fixture.db<
          { user_message_id: string }[]
        >`select user_message_id from allrice_employee_runs where run_id=${f.rootRunId}`;
        let a = await pending(
          f,
          '同源候选A',
          'message',
          origin!.user_message_id,
        );
        if (state === 'active')
          a = EmployeeMemoryWriteResponseSchema.parse(
            await (
              await promote(
                request(f, 'POST', undefined, cas(f, a)),
                params(a.id),
              )
            ).json(),
          ).memory;
        const b = await pending(
          f,
          '同源候选B',
          'message',
          origin!.user_message_id,
        );
        expect(
          (
            await remove(
              request(f, 'DELETE', undefined, cas(f, a)),
              params(a.id),
            )
          ).status,
        ).toBe(204);
        const afterDeletion = await page(f);
        expect(afterDeletion.counts).toEqual({
          active: 0,
          pending: 1,
          maxActive: 100,
        });
        expect(afterDeletion.pending.map((row) => row.id)).toContain(b.id);
        const confirmation = await promote(
          request(f, 'POST', undefined, cas(f, b)),
          params(b.id),
        );
        const active = EmployeeMemoryWriteResponseSchema.parse(
          await confirmation.json(),
        ).memory;
        await seed(f, 99);
        const edited = await edit(
          request(f, 'PATCH', undefined, {
            ...cas(f, active),
            summary: active.summary,
            details: '独立确认的B仍可用',
            reason: '本人编辑',
          }),
          params(b.id),
        );
        expect(
          EmployeeMemoryWriteResponseSchema.parse(await edited.json()).counts
            .active,
        ).toBe(100);
        expect((await detail(request(f, 'GET'), params(a.id))).status).toBe(
          404,
        );
        expect((await read(f, b.id)).details).toBe('独立确认的B仍可用');
      },
    );

    it('keeps opaque ordinary tool/connector owner confirmation without inventing external resource authority', async () => {
      const f = await setup();
      for (const kind of ['tool', 'connector'] as const) {
        // Historical/internal DB contract only: no real producer or C receipt is fabricated.
        const row = await pending(f, `${kind}既有普通候选`, kind, randomUUID());
        const response = await promote(
          request(f, 'POST', undefined, cas(f, row)),
          params(row.id),
        );
        expect(
          EmployeeMemoryWriteResponseSchema.parse(await response.json()).memory
            .state,
        ).toBe('active');
      }
    });

    it('rechecks real message/checkpoint withdrawal for pending confirmation but does not rejudge an active edit', async () => {
      const f = await setup();
      const [origin] = await fixture.db<
        { user_message_id: string }[]
      >`select user_message_id from allrice_employee_runs where run_id=${f.rootRunId}`;
      const activePending = await pending(
        f,
        '先合法确认的记忆',
        'message',
        origin!.user_message_id,
      );
      const confirmed = await promote(
        request(f, 'POST', undefined, cas(f, activePending)),
        params(activePending.id),
      );
      const active = EmployeeMemoryWriteResponseSchema.parse(
        await confirmed.json(),
      ).memory;
      const message = await pending(
        f,
        '尚未确认的消息候选',
        'message',
        origin!.user_message_id,
      );
      const checkpointId = randomUUID();
      await fixture.db`insert into allrice_context_checkpoints(id,organization_id,workspace_id,session_id,owner_id,harness,thread_generation,covered_through_message_id,summary_version,summary,checksum,config_checksum,estimated_tokens,message_count)
      values(${checkpointId},${f.org},${f.workspace},${f.session},${f.user},'dsh',1,${origin!.user_message_id},'extractive-v1','无完整lineage也不新增门槛',${'sha256:' + 'a'.repeat(64)},${'sha256:' + 'b'.repeat(64)},1,1)`;
      const cp = await pending(
        f,
        '真实checkpoint候选',
        'checkpoint',
        checkpointId,
      );
      const incompleteLineage = await pending(
        f,
        '无完整lineage仍可本人确认',
        'checkpoint',
        checkpointId,
      );
      const ordinaryConfirmation = await promote(
        request(f, 'POST', undefined, cas(f, incompleteLineage)),
        params(incompleteLineage.id),
      );
      expect(
        EmployeeMemoryWriteResponseSchema.parse(
          await ordinaryConfirmation.json(),
        ).memory.state,
      ).toBe('active');
      const snapshotMessage = await snapshot(message.id),
        snapshotCp = await snapshot(cp.id);
      await fixture.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${f.session}`;
      for (const row of [message, cp]) {
        const response = await promote(
          request(f, 'POST', undefined, cas(f, row)),
          params(row.id),
        );
        expect(response.status).toBe(403);
      }
      expect(await snapshot(message.id)).toEqual(snapshotMessage);
      expect(await snapshot(cp.id)).toEqual(snapshotCp);
      const response = await edit(
        request(f, 'PATCH', undefined, {
          ...cas(f, active),
          summary: active.summary,
          details: '已独立确认仍可编辑',
          reason: '本人编辑',
        }),
        params(active.id),
      );
      expect(response.status).toBe(200);
    });

    it('does not promote a file candidate after its exact stored resource is withdrawn', async () => {
      const f = await setup(),
        objectId = randomUUID();
      await fixture.db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state)
      values(${objectId},${f.org},${f.workspace},${f.user},${'synthetic/' + objectId},'uploads','text/plain',1,${'sha256:' + 'c'.repeat(64)},'ready')`;
      const row = await pending(f, '文件资料入口', 'file', objectId);
      const before = await snapshot(row.id);
      await fixture.db`update allrice_storage_objects set state='deleted',deleted_at=clock_timestamp() where id=${objectId}`;
      const response = await promote(
        request(f, 'POST', undefined, cas(f, row)),
        params(row.id),
      );
      expect(response.status).toBe(404);
      expect(await snapshot(row.id)).toEqual(before);
    });

    it('checks owner, tenant, instance, membership, viewer writes and current browser session before mutation or replay', async () => {
      const f = await setup(),
        foreign = await setup();
      const row = (await add(f)).memory;
      const input = {
        ...cas(f, row),
        summary: row.summary,
        details: row.details,
        reason: '本人编辑',
      };
      const before = await snapshot(row.id);
      const other = await createEmployeeInstance(f.context, {
        workspaceId: f.workspace,
        assignmentId: f.assignment,
        requestId: randomUUID(),
        profile: { name: 'Other' },
      });
      expect(
        (
          await detail(
            request(f, 'GET', undefined, undefined, { instanceId: other.id }),
            params(row.id),
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await edit(
            request(f, 'PATCH', undefined, { ...input, instanceId: other.id }),
            params(row.id),
          )
        ).status,
      ).toBe(404);
      const cross = await detail(
        request(foreign, 'GET', undefined, undefined, {
          workspaceId: f.workspace,
          instanceId: f.assignment,
        }),
        params(row.id),
      );
      expect([403, 404]).toContain(cross.status);
      expect(JSON.stringify(await cross.json())).not.toContain(row.summary);
      expect(
        (
          await edit(
            request(foreign, 'PATCH', undefined, {
              ...input,
              instanceId: foreign.assignment,
            }),
            params(row.id),
          )
        ).status,
      ).toBe(404);
      await fixture.db`update allrice_memberships set role='viewer' where id=${f.membership}`;
      expect((await read(f, row.id)).id).toBe(row.id);
      expect(
        (await edit(request(f, 'PATCH', undefined, input), params(row.id)))
          .status,
      ).toBe(403);
      await fixture.db`update allrice_memberships set role='admin',active=false where id=${f.membership}`;
      expect(
        (await manage(request(f, 'GET', '/api/v1/memories/manage'))).status,
      ).toBe(403);
      expect(
        (await edit(request(f, 'PATCH', undefined, input), params(row.id)))
          .status,
      ).toBe(403);
      await fixture.db`update allrice_memberships set active=true where id=${f.membership}`;
      expect(await snapshot(row.id)).toEqual(before);
      const success = await edit(
        request(f, 'PATCH', undefined, input),
        params(row.id),
      );
      expect(success.status).toBe(200);
      const saved = await snapshot(row.id);
      await fixture.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${f.context.sessionId}`;
      expect(
        (await edit(request(f, 'PATCH', undefined, input), params(row.id)))
          .status,
      ).toBe(403);
      expect(await snapshot(row.id)).toEqual(saved);
    });

    it('rejects malformed JSON, origin spoofing, invalid Unicode/length and omitted CAS without writing anything', async () => {
      const f = await setup(),
        row = (await add(f)).memory;
      const before = await snapshot(row.id);
      for (const body of [
        {
          ...cas(f, row),
          summary: row.summary,
          details: '🧑'.repeat(2001),
          reason: '本人编辑',
        },
        {
          ...cas(f, row),
          summary: '🧑'.repeat(41),
          details: null,
          reason: '本人编辑',
        },
        {
          ...cas(f, row),
          summary: '\u0000',
          details: null,
          reason: '本人编辑',
        },
        {
          instanceId: f.assignment,
          summary: row.summary,
          details: null,
          reason: '本人编辑',
        },
      ])
        expect(
          (await edit(request(f, 'PATCH', undefined, body), params(row.id)))
            .status,
        ).toBe(400);
      const malformed = request(f, 'PATCH');
      expect(
        (
          await edit(
            new Request(malformed.url, {
              method: 'PATCH',
              headers: malformed.headers,
              body: '{',
            }),
            params(row.id),
          )
        ).status,
      ).toBe(400);
      const spoof = request(f, 'PATCH', undefined, {
        ...cas(f, row),
        summary: row.summary,
        details: null,
        reason: '本人编辑',
      });
      spoof.headers.set('origin', 'https://foreign.test');
      expect((await edit(spoof, params(row.id))).status).toBe(403);
      expect(await snapshot(row.id)).toEqual(before);
      ports.context.mockResolvedValueOnce(null);
      expect(
        (await manage(new Request('http://localhost/api/v1/memories/manage')))
          .status,
      ).toBe(401);
    });

    it('retires management pin without changing historic metadata or the frozen v1 projection, and keeps raw source paths distinct', async () => {
      const f = await setup(),
        row = (await add(f)).memory;
      await fixture.db`update allrice_memories set metadata=jsonb_build_object('memoryPinOrder',1) where id=${row.id}`;
      const before = await snapshot(row.id);
      const scope = {
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        instanceId: f.assignment,
      };
      const frozen = await freezeEmployeeDocuments(fixture.db, scope, {}, true);
      const response = await pin(
        request(f, 'POST', undefined, {
          instanceId: f.assignment,
          expectedRevision: row.revision,
          contentDigest: memoryContentDigest(row.summary),
          idempotencyKey: randomUUID(),
          pinned: false,
        }),
        params(row.id),
      );
      await conflict(response, 'contract_changed');
      expect(await snapshot(row.id)).toEqual(before);
      expect(
        await freezeEmployeeDocuments(fixture.db, scope, {}, true),
      ).toEqual(frozen);
      const source = await rawList(
        request(f, 'GET', undefined, undefined, { runId: f.rootRunId }),
      );
      expect(source.status).toBe(200);
      expect(await source.json()).toEqual({ memories: [] });
      expect(
        await listWorkspaceMemoryRevisions(
          f.context,
          f.workspace,
          row.id,
          f.assignment,
        ),
      ).toHaveLength(1);
    });

    it('admin list and UUID detail retain the real actor, minimal projection and one body-free audit per successful read', async () => {
      const f = await setup(),
        row = (
          await add(f, {
            summary: '管理员可读的摘要',
            details: '不得进入审计正文',
          })
        ).memory;
      const make = (
        context: RequestContext,
        query: Record<string, string> = {},
      ) => {
        ports.context.mockResolvedValue(context);
        return new Request(
          'http://localhost/api/v1/admin/organizations/' +
            f.org +
            '/employee-memories?' +
            new URLSearchParams({
              ownerId: f.user,
              instanceId: f.assignment,
              ...query,
            }),
        );
      };
      const listResponse = await adminList(make(admin), {
        params: Promise.resolve({ organizationId: f.org }),
      });
      expect(listResponse.status).toBe(200);
      expect(listResponse.headers.get('cache-control')).toBe(
        'private, no-store',
      );
      const result = EmployeeMemoryListSchema.parse(await listResponse.json());
      expect(result.active.map((r) => r.id)).toEqual([row.id]);
      expect(JSON.stringify(result)).not.toContain(row.details!);
      const detailResponse = await adminDetail(make(admin), {
        params: Promise.resolve({ organizationId: f.org, id: row.id }),
      });
      expect(detailResponse.status).toBe(200);
      expect(detailResponse.headers.get('cache-control')).toBe(
        'private, no-store',
      );
      expect(
        EmployeeMemoryDetailResponseSchema.parse(await detailResponse.json())
          .memory,
      ).toEqual(row);
      const audits =
        await fixture.db`select actor_id,resource_id,metadata from allrice_audit_events where organization_id=${f.org} and action='employee_memory.admin_read' order by metadata->>'returnedCount',resource_id`;
      expect(audits).toHaveLength(2);
      expect(audits.every((event) => event.actor_id === admin.actor.id)).toBe(
        true,
      );
      for (const event of audits) {
        expect(event.metadata).toMatchObject({
          ownerId: f.user,
          instanceId: f.assignment,
          schemaVersion: 2,
          returnedCount: 1,
        });
        expect(Object.keys(event.metadata).sort()).toEqual(
          (event.resource_id === row.id
            ? [
                'ownerId',
                'instanceId',
                'schemaVersion',
                'returnedCount',
                'memoryId',
              ]
            : ['ownerId', 'instanceId', 'schemaVersion', 'returnedCount']
          ).sort(),
        );
      }
      expect(JSON.stringify(audits)).not.toContain(row.summary);
      expect(JSON.stringify(audits)).not.toContain(row.details!);
      expect(
        (
          await adminList(make(f.context), {
            params: Promise.resolve({ organizationId: f.org }),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await adminList(make(admin, { ownerId: randomUUID() }), {
            params: Promise.resolve({ organizationId: f.org }),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await adminList(make(admin), {
            params: Promise.resolve({ organizationId: randomUUID() }),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await adminDetail(make(admin, { ownerId: randomUUID() }), {
            params: Promise.resolve({ organizationId: f.org, id: row.id }),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await adminList(make({ ...admin, sessionId: randomUUID() }), {
            params: Promise.resolve({ organizationId: f.org }),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await adminList(make(admin, { state: 'archived' }), {
            params: Promise.resolve({ organizationId: f.org }),
          })
        ).status,
      ).toBe(400);
      expect(
        await fixture.db`select id from allrice_audit_events where organization_id=${f.org} and action='employee_memory.admin_read'`,
      ).toHaveLength(2);
      const beforeAdminWrite = await snapshot(row.id);
      const writeAsAdmin = await edit(
        request({ ...f, context: admin }, 'PATCH', undefined, {
          ...cas(f, row),
          summary: row.summary,
          details: null,
          reason: '管理员不能代本人编辑',
        }),
        params(row.id),
      );
      expect([403, 404]).toContain(writeAsAdmin.status);
      expect(await snapshot(row.id)).toEqual(beforeAdminWrite);
      expect((await snapshot(row.id)).memory.revision).toBe(1);
    });

    it('preserves the existing independent admin target scope when owner access or instance availability has ended', async () => {
      const f = await setup(),
        row = (
          await add(f, { summary: '历史只读目标', details: '不伪造本人权限' })
        ).memory;
      await fixture.db`update allrice_employee_instances set archived_at=clock_timestamp() where id=${f.assignment}`;
      await fixture.db`update allrice_employee_assignments set active=false where id=${f.assignment}`;
      await fixture.db`update allrice_memberships set active=false where id=${f.membership}`;
      expect((await detail(request(f, 'GET'), params(row.id))).status).toBe(
        403,
      );
      const make = () => {
        ports.context.mockResolvedValue(admin);
        return new Request(
          'http://localhost/api/v1/admin/organizations/' +
            f.org +
            '/employee-memories?' +
            new URLSearchParams({ ownerId: f.user, instanceId: f.assignment }),
        );
      };
      const listed = await adminList(make(), {
        params: Promise.resolve({ organizationId: f.org }),
      });
      expect(listed.status).toBe(200);
      expect(
        EmployeeMemoryListSchema.parse(await listed.json()).active.map(
          (item) => item.id,
        ),
      ).toEqual([row.id]);
      const read = await adminDetail(make(), {
        params: Promise.resolve({ organizationId: f.org, id: row.id }),
      });
      expect(read.status).toBe(200);
      expect(
        EmployeeMemoryDetailResponseSchema.parse(await read.json()).memory,
      ).toEqual(row);
      const audits =
        await fixture.db`select actor_id,metadata from allrice_audit_events where organization_id=${f.org} and action='employee_memory.admin_read'`;
      expect(audits).toHaveLength(2);
      expect(audits.every((event) => event.actor_id === admin.actor.id)).toBe(
        true,
      );
      expect(JSON.stringify(audits)).not.toContain(row.details!);
      expect((await snapshot(row.id)).memory.revision).toBe(1);
    });

    it('rolls back pair/state/count admission, revision, chunks, audit and success receipt when the first audit fails', async () => {
      const f = await setup(),
        row = await pending(f);
      const before = await snapshot(row.id);
      await fixture.db
        .unsafe(`create function fail_managed_memory_audit() returns trigger language plpgsql as $$ begin
      if new.action='memory.correct' then raise exception 'synthetic management audit failure'; end if; return new; end $$;
      create trigger fail_managed_memory_audit before insert on allrice_audit_events for each row execute function fail_managed_memory_audit()`);
      try {
        const response = await edit(
          request(f, 'PATCH', undefined, {
            ...cas(f, row),
            summary: '本人保存并确认',
            details: '不可部分提交',
            reason: '本人编辑',
          }),
          params(row.id),
        );
        expect(response.status).toBe(500);
      } finally {
        await fixture.db.unsafe(
          'drop trigger fail_managed_memory_audit on allrice_audit_events; drop function fail_managed_memory_audit()',
        );
      }
      expect(await snapshot(row.id)).toEqual(before);
      expect((await page(f)).counts).toEqual({
        active: 0,
        pending: 1,
        maxActive: 100,
      });
    });
  },
);
