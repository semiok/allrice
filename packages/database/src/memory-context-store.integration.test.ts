/** Real PG storage tests with an explicitly synthetic authority contract.
 * The fixture is NOT a 271/273 producer, public transaction participation port,
 * or native root/child/source acceptance. No fixture enters production code. */
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RunMemoryContextV2StateSchema,
  memoryIndexPolicy,
  renderMemoryDetailV2,
  type PersonalMemoryPair,
  type RequestContext,
} from '@allrice/contracts';
import * as client from './core/client.ts';
import { createEmployeeMemoryPort } from './employee-memory-port.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from './identity.ts';
import { ensureGeneralEmployeeInstance } from './employees/employee-instances.ts';
import { renderNativeMemoryIndexV2 } from './memory-context-render.ts';
import {
  issueMemoryContextStorage,
  readMemoryContextStorageOrdinal,
  type MemoryContextStorageDraft,
  type MemoryContextStorageKey,
} from './memory-context-store.ts';
import { MemoryContextError } from './run-memory-context.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { runtimePolicyDigest } from './runtime-policy-digest.ts';
import {
  memoryPairContent,
  memoryPairDigest,
} from './workspace/employee-memory-primitives.ts';
import { ensureDefaultEmployee } from './workspace/service.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const live = () => new AbortController().signal;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};
const refused = { code: 'MEMORY_CONTEXT_UNAVAILABLE' };
const exhausted = { code: 'MEMORY_CONTEXT_BUDGET_EXHAUSTED' };
const uppercaseKey = (
  key: MemoryContextStorageKey,
): MemoryContextStorageKey => ({
  ...key,
  organizationId: key.organizationId.toUpperCase(),
  workspaceId: key.workspaceId.toUpperCase(),
  ownerId: key.ownerId.toUpperCase(),
  instanceId: key.instanceId.toUpperCase(),
  employeeId: key.employeeId.toUpperCase(),
  threadId: key.threadId.toUpperCase(),
});

suite(
  'memory context internal storage; authority is a contract fixture',
  () => {
    let database: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    beforeAll(async () => {
      database = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(database.db);
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      await database?.close();
    }, 30000);

    class MemoryContextAuthorityContractFixture {
      // These source/module/root/child facts stand in ONLY for the missing owner
      // contract. They are never inferred from the guest, fake Run or SQL joins.
      allowed = true;
      sourceCurrent = true;
      readonly rootSessionRef = `fixture-root:${randomUUID()}`;
      readonly childSessionRef = `fixture-child:${randomUUID()}`;
      readonly key: MemoryContextStorageKey;
      readonly origin: MemoryContextStorageDraft['origin'];
      readonly nativeSessions = new Set<string>();
      constructor(
        readonly context: RequestContext,
        scope: Omit<MemoryContextStorageKey, 'threadId' | 'budgetRef'>,
      ) {
        this.key = {
          ...scope,
          threadId: randomUUID(),
          budgetRef: `fixture-B:${randomUUID()}`,
        };
        this.origin = {
          executionGeneration: '4.0',
          nativeOwnerRef: `fixture-owner:${randomUUID()}`,
          nativeProfileRef: `fixture-profile:${randomUUID()}`,
          rootNativeSessionRef: this.rootSessionRef,
          moduleRelease: {
            moduleId: 'employee-memory',
            contractVersion: 1,
            contentVersion: '1.0.0',
            digest: `sha256:${'a'.repeat(64)}`,
          },
          moduleConfigRevisionRef: 'fixture-config-1',
        };
        this.nativeSessions.add(this.rootSessionRef);
        this.nativeSessions.add(this.childSessionRef);
      }
      async transaction<T>(
        nativeSession: string,
        signal: AbortSignal,
        operation: (tx: TransactionSql) => Promise<T>,
        options: {
          applicationName?: string;
          afterCommit?: () => Promise<void>;
        } = {},
      ) {
        signal.throwIfAborted();
        if (
          !this.allowed ||
          !this.sourceCurrent ||
          !this.nativeSessions.has(nativeSession)
        )
          throw new MemoryContextError('MEMORY_CONTEXT_UNAVAILABLE');
        const result = await database.db.begin(async (tx) => {
          if (options.applicationName)
            await tx`select set_config('application_name',${options.applicationName},true)`;
          return operation(tx);
        });
        await options.afterCommit?.();
        signal.throwIfAborted();
        return result as T;
      }
      async draft(tx: TransactionSql): Promise<MemoryContextStorageDraft> {
        // ALL records in this fixture are known ordinary/user sources. This is
        // test assembly, not a replacement production ordinary/source predicate.
        const k = this.key;
        const rows = await tx<
          {
            id: string;
            revision: number;
            summary: string;
            details: string | null;
          }[]
        >`select id,revision,summary,details from allrice_memories
        where organization_id=${k.organizationId} and workspace_id=${k.workspaceId}
          and owner_id=${k.ownerId} and instance_id=${k.instanceId}
          and employee_id=${k.employeeId} and visibility='private'
          and lifecycle_state='durable' and trust_level='user_confirmed'
          and archived_at is null and (expires_at is null or expires_at>clock_timestamp())
        order by updated_at desc,id desc`;
        const pins = rows.map((pair, i) => ({
          number: i + 1,
          id: pair.id,
          revision: pair.revision,
          pairDigest: memoryPairDigest(pair),
          hasDetails: pair.details !== null,
        }));
        const document = renderNativeMemoryIndexV2(
          rows.map((pair) => ({
            summary: pair.summary,
            hasDetails: pair.details !== null,
          })),
        );
        const bytes = Buffer.byteLength(document, 'utf8');
        return {
          origin: { ...this.origin },
          document,
          state: RunMemoryContextV2StateSchema.parse({
            schemaVersion: 2,
            meter: 'utf8_bytes',
            limits: memoryIndexPolicy,
            initial: {
              digest: runtimePolicyDigest(pins),
              documentDigest: runtimePolicyDigest(document),
              bytes,
            },
            pins,
            spentBytes: bytes,
            toolReads: 0,
          }),
        };
      }
      issue(signal = live()) {
        return this.transaction(this.rootSessionRef, signal, async (tx) =>
          issueMemoryContextStorage(tx, this.key, await this.draft(tx), signal),
        );
      }
      read(
        number: number,
        signal = live(),
        nativeSession = this.rootSessionRef,
        options: Parameters<
          MemoryContextAuthorityContractFixture['transaction']
        >[3] = {},
      ) {
        return this.transaction(
          nativeSession,
          signal,
          (tx) =>
            readMemoryContextStorageOrdinal(tx, this.key, { number }, signal),
          options,
        );
      }
      async stored() {
        const k = this.key;
        const [row] = await database.db<
          { id: string; document: string; state: unknown }[]
        >`
        select id,document,state from allrice_employee_memory_contexts
        where organization_id=${k.organizationId} and workspace_id=${k.workspaceId}
          and owner_id=${k.ownerId} and instance_id=${k.instanceId} and budget_ref=${k.budgetRef}`;
        return row
          ? { ...row, state: RunMemoryContextV2StateSchema.parse(row.state) }
          : null;
      }
    }
    async function setup(pairs: PersonalMemoryPair[] = []) {
      const suffix = randomUUID();
      const principal = await ensureBootstrapPortalPrincipal({
        organizationSlug: `memory-context-${suffix}`,
        organizationName: 'Context storage fixture',
        workspaceSlug: 'default',
        workspaceName: 'Default',
        email: `memory-context-${suffix}@example.test`,
        displayName: 'Owner',
        role: 'member',
      });
      const context = (await authenticateSession(
        (await createSession(principal.user.id)).token,
        principal,
      ))!;
      const assignment = await ensureDefaultEmployee(
        context,
        principal.workspaceId,
      );
      if (!assignment) throw Error('memory_context_fixture_assignment_missing');
      await ensureGeneralEmployeeInstance(database.db, assignment.id);
      const f = new MemoryContextAuthorityContractFixture(context, {
        organizationId: principal.organizationId,
        workspaceId: principal.workspaceId,
        ownerId: principal.user.id,
        instanceId: assignment.id,
        employeeId: assignment.employeeId,
      });
      await database.db.begin(async (tx) => {
        for (const pair of pairs) {
          const id = randomUUID();
          const k = f.key;
          await tx`insert into allrice_memories(id,organization_id,workspace_id,owner_id,instance_id,employee_id,
          content,summary,details,visibility,source_type,lifecycle_state,trust_level)
          values(${id},${k.organizationId},${k.workspaceId},${k.ownerId},${k.instanceId},${k.employeeId},
            ${memoryPairContent(pair)},${pair.summary},${pair.details},'private','user','durable','user_confirmed')`;
          await tx`insert into allrice_memory_revisions(organization_id,workspace_id,memory_id,revision,
          content,summary,details,trust_level,lifecycle_state,memory_class,confidence,reason,changed_by)
          values(${k.organizationId},${k.workspaceId},${id},1,${memoryPairContent(pair)},${pair.summary},${pair.details},
            'user_confirmed','durable','work_note',1,'synthetic ordinary-source fixture',${k.ownerId})`;
        }
      });
      return f;
    }

    it.each([0, 100, 101])(
      'persists the complete fixture set at %i, never crops',
      async (count) => {
        const f = await setup(
          Array.from({ length: count }, (_, i) => ({
            summary: `记忆${i}`,
            details: i % 2 ? null : '完整条件',
          })),
        );
        if (count === 101) {
          await expect(f.issue()).rejects.toThrow();
          expect(await f.stored()).toBeNull();
          return;
        }
        const issued = await f.issue();
        expect(issued.state.pins).toHaveLength(count);
        expect(issued.state.spentBytes).toBe(
          Buffer.byteLength(issued.document, 'utf8'),
        );
        expect(issued.state.toolReads).toBe(0);
        expect((await f.issue()).id).toBe(issued.id);
        const [runs] =
          await database.db`select count(*)::int count from allrice_employee_runs
      where organization_id=${f.key.organizationId}`;
        expect(runs!.count).toBe(0);
        if (!count) {
          expect(issued.document).toBe('');
          await expect(f.read(1)).rejects.toMatchObject(refused);
        }
      },
    );

    it('serializes concurrent first issue on the same scoped B into one stored allowance', async () => {
      const f = await setup([{ summary: '并发发行', details: '不重复额度' }]);
      const results = await Promise.all([f.issue(), f.issue(), f.issue()]);
      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      expect(results[1]!.state).toEqual(results[0]!.state);
      expect(results[2]!.state).toEqual(results[0]!.state);
      const [row] =
        await database.db`select count(*)::int count from allrice_employee_memory_contexts
      where organization_id=${f.key.organizationId} and budget_ref=${f.key.budgetRef}`;
      expect(row!.count).toBe(1);
    });

    it('restores and reads legal uppercase UUID keys while keeping budget/native references case-sensitive', async () => {
      const pair = { summary: '大小写恢复', details: '原始完整说明' };
      const f = await setup([pair]);
      f.key.budgetRef = `Fixture-B:CaSe:${randomUUID()}`;
      f.origin.nativeOwnerRef = `Fixture-Native-Owner:CaSe:${randomUUID()}`;
      f.origin.nativeProfileRef = `Fixture-Native-Profile:CaSe:${randomUUID()}`;
      const upper = uppercaseKey(f.key);
      const issued = await f.transaction(f.rootSessionRef, live(), async (tx) =>
        issueMemoryContextStorage(tx, upper, await f.draft(tx), live()),
      );
      const text = renderMemoryDetailV2(1, pair);
      expect(await f.read(1)).toBe(text);
      expect(
        await f.transaction(f.rootSessionRef, live(), (tx) =>
          readMemoryContextStorageOrdinal(tx, upper, { number: 1 }, live()),
        ),
      ).toBe(text);
      const restored = await f.transaction(
        f.rootSessionRef,
        live(),
        async (tx) =>
          issueMemoryContextStorage(tx, upper, await f.draft(tx), live()),
      );
      expect(restored.id).toBe(issued.id);
      expect(restored.state.toolReads).toBe(2);
      expect(restored.state.spentBytes).toBe(
        issued.state.initial.bytes + 2 * Buffer.byteLength(text, 'utf8'),
      );
      expect(restored.origin).toEqual(f.origin);
      expect(upper.budgetRef).toBe(f.key.budgetRef);
      await expect(
        f.transaction(f.rootSessionRef, live(), (tx) =>
          readMemoryContextStorageOrdinal(
            tx,
            {
              ...upper,
              budgetRef: upper.budgetRef.toLowerCase(),
            },
            { number: 1 },
            live(),
          ),
        ),
      ).rejects.toMatchObject(refused);
    });

    it('uses one allowance for concurrent first issue with different UUID casing and the same S/B', async () => {
      const pair = { summary: '同一个预算', details: '大小写不分裂锁' };
      const f = await setup([pair]);
      const issue = (key: MemoryContextStorageKey) =>
        f.transaction(f.rootSessionRef, live(), async (tx) =>
          issueMemoryContextStorage(tx, key, await f.draft(tx), live()),
        );
      const upper = uppercaseKey(f.key);
      const mixed = {
        ...upper,
        ownerId: f.key.ownerId,
        threadId: f.key.threadId,
      };
      const issued = await Promise.all([
        issue(f.key),
        issue(upper),
        issue(mixed),
      ]);
      expect(new Set(issued.map((value) => value.id)).size).toBe(1);
      expect(issued.every((value) => value.state.toolReads === 0)).toBe(true);
      await Promise.all([
        f.read(1),
        f.transaction(f.childSessionRef, live(), (tx) =>
          readMemoryContextStorageOrdinal(tx, upper, { number: 1 }, live()),
        ),
      ]);
      const restored = await issue(mixed);
      expect(restored.state.toolReads).toBe(2);
      expect(restored.state.spentBytes).toBe(
        issued[0]!.state.initial.bytes +
          2 * Buffer.byteLength(renderMemoryDetailV2(1, pair), 'utf8'),
      );
      const [row] =
        await database.db`select count(*)::int count from allrice_employee_memory_contexts
        where organization_id=${f.key.organizationId} and budget_ref=${f.key.budgetRef}`;
      expect(row!.count).toBe(1);
    });

    it('rejects a stale or mismatched initial complete pair before persisting an allowance', async () => {
      const f = await setup([{ summary: '原始摘要', details: '原始说明' }]);
      await expect(
        f.transaction(f.rootSessionRef, live(), async (tx) => {
          const draft = await f.draft(tx);
          await tx`update allrice_memories set details='不匹配的当前说明'
            where id=${draft.state.pins[0]!.id}`;
          return issueMemoryContextStorage(tx, f.key, draft, live());
        }),
      ).rejects.toMatchObject(refused);
      expect(await f.stored()).toBeNull();
    });

    it('preserves the issued complete pair after the owner edits it; withdrawing any pin refuses all', async () => {
      const f = await setup();
      // User intent: “周报按这个规则记住，以后我会查看完整说明。” The actual
      // management port and all memory/revision/operation/audit writes are real.
      const port = createEmployeeMemoryPort({
        qualification: { requireCurrentAccess: async () => {} },
      });
      const pair = {
        summary: '周报按公司模板',
        details: '保留全量条件😀\n仅财务部月结后可用。',
      };
      const create = async (value: PersonalMemoryPair) =>
        (
          await port.create(
            f.context,
            {
              workspaceId: f.key.workspaceId,
              instanceId: f.key.instanceId,
              idempotencyKey: randomUUID(),
              ...value,
            },
            live(),
          )
        ).memory;
      const a = await create(pair);
      const b = await create({ summary: '第二条', details: null });
      const issued = await f.issue();
      expect(issued.document).not.toContain(pair.details);
      expect(JSON.stringify(issued.state)).not.toContain(pair.details);
      const ordinal = issued.state.pins.find((pin) => pin.id === a.id)!.number;
      await port.correct(
        f.context,
        {
          target: { workspaceId: f.key.workspaceId, memoryId: a.id },
          body: {
            instanceId: f.key.instanceId,
            expectedRevision: a.revision,
            pairDigest: a.pairDigest,
            idempotencyKey: randomUUID(),
            summary: '改后的摘要',
            details: null,
            reason: '本人编辑',
          },
        },
        live(),
      );
      expect(await f.read(ordinal)).toBe(renderMemoryDetailV2(ordinal, pair));
      expect((await f.issue()).document).toBe(issued.document);
      await port.withdraw(
        f.context,
        {
          target: { workspaceId: f.key.workspaceId, memoryId: b.id },
          body: {
            instanceId: f.key.instanceId,
            expectedRevision: b.revision,
            pairDigest: b.pairDigest,
            idempotencyKey: randomUUID(),
          },
        },
        live(),
      );
      await expect(f.read(ordinal)).rejects.toMatchObject(refused);
      await expect(f.issue()).rejects.toMatchObject(refused);
    });

    it('holds every memory-owned pin until the accounting transaction commits', async () => {
      const f = await setup([
        { summary: '要读的条目', details: '原样正文' },
        { summary: '另一个pin', details: null },
      ]);
      const issued = await f.issue();
      const id = issued.state.pins[1]!.id;
      const held = deferred(),
        release = deferred();
      const reader = f.transaction(f.rootSessionRef, live(), async (tx) => {
        const result = await readMemoryContextStorageOrdinal(
          tx,
          f.key,
          { number: 1 },
          live(),
        );
        held.resolve();
        await release.promise;
        return result;
      });
      await held.promise;
      const applicationName = `memory-context-withdraw:${randomUUID()}`;
      const writer = database.db.begin(async (tx) => {
        await tx`select set_config('application_name',${applicationName},true)`;
        await tx`update allrice_memories set archived_at=clock_timestamp() where id=${id}`;
      });
      try {
        await vi.waitFor(async () => {
          const [row] =
            await database.db`select exists(select 1 from pg_stat_activity
          where application_name=${applicationName} and wait_event_type='Lock') waiting`;
          expect(row!.waiting).toBe(true);
        });
      } finally {
        release.resolve();
        await Promise.all([reader, writer]);
      }
      expect((await f.stored())!.state.toolReads).toBe(1);
      await expect(f.read(1)).rejects.toMatchObject(refused);
    });

    it.each(['expired', 'scope', 'private', 'pending'] as const)(
      'refuses the entire context when another pin loses memory-owned %s qualification',
      async (change) => {
        const f = await setup([
          { summary: '第一条', details: null },
          { summary: '第二条', details: '条件' },
        ]);
        const issued = await f.issue();
        const id = issued.state.pins[1]!.id;
        if (change === 'expired')
          await database.db`update allrice_memories
            set captured_at=statement_timestamp()-interval '2 seconds',
              expires_at=statement_timestamp()-interval '1 second' where id=${id}`;
        if (change === 'scope')
          await database.db`update allrice_memories set instance_id=null where id=${id}`;
        if (change === 'private')
          await database.db`update allrice_memories set visibility='workspace' where id=${id}`;
        if (change === 'pending')
          await database.db`update allrice_memories set lifecycle_state='candidate',trust_level='derived' where id=${id}`;
        await expect(f.read(1)).rejects.toMatchObject(refused);
        expect((await f.stored())!.state).toEqual(issued.state);
      },
    );

    it('never issues while reading a missing B or a foreign scope/thread', async () => {
      const f = await setup([{ summary: '本人摘要', details: '完整条件' }]);
      await expect(f.read(1)).rejects.toMatchObject(refused);
      expect(await f.stored()).toBeNull();
      await f.issue();
      const foreign = await setup();
      for (const key of [
        { ...f.key, threadId: randomUUID() },
        { ...f.key, employeeId: randomUUID() },
        { ...foreign.key, budgetRef: f.key.budgetRef },
      ])
        await expect(
          database.db.begin((tx) =>
            readMemoryContextStorageOrdinal(tx, key, { number: 1 }, live()),
          ),
        ).rejects.toMatchObject(refused);
      await expect(
        f.read(1, live(), 'fixture-unapproved-descendant'),
      ).rejects.toMatchObject(refused);
      f.sourceCurrent = false;
      await expect(f.read(1)).rejects.toMatchObject(refused);
      f.sourceCurrent = true;
      f.allowed = false;
      await expect(f.read(1)).rejects.toMatchObject(refused);
    });

    it('charges original UTF-8 text on every root/approved-child read, including repeats and concurrent last reads', async () => {
      const pair = { summary: '预算😀', details: '原样中文\n😀' };
      const f = await setup([pair]);
      const issued = await f.issue();
      const text = renderMemoryDetailV2(1, pair);
      for (let i = 0; i < 11; i++)
        expect(
          await f.read(1, live(), i % 2 ? f.childSessionRef : f.rootSessionRef),
        ).toBe(text);
      const last = await Promise.allSettled([
        f.read(1),
        f.read(1, live(), f.childSessionRef),
      ]);
      expect(
        last.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(last.find((result) => result.status === 'rejected')).toMatchObject(
        { reason: exhausted },
      );
      const stored = (await f.stored())!;
      expect(stored.id).toBe(issued.id);
      expect(stored.state.toolReads).toBe(12);
      expect(stored.state.spentBytes).toBe(
        issued.state.initial.bytes + 12 * Buffer.byteLength(text, 'utf8'),
      );
      expect(stored.state.pins).toEqual(issued.state.pins);
      await expect(f.read(1)).rejects.toMatchObject(exhausted);
      f.origin.nativeProfileRef = 'fixture-host-rebound';
      f.origin.moduleConfigRevisionRef = 'fixture-config-2';
      const restored = await f.issue();
      expect(restored.state).toEqual(stored.state);
      expect(restored.origin).toEqual(issued.origin);
    });

    it('refuses an entire response before it would exceed the original byte allowance', async () => {
      const pair = { summary: '大说明', details: '😀'.repeat(2000) };
      const f = await setup([pair]);
      const issued = await f.issue();
      const text = renderMemoryDetailV2(1, pair);
      const bytes = Buffer.byteLength(text, 'utf8');
      const maximum = Math.floor(
        (memoryIndexPolicy.maximumRunBytes - issued.state.initial.bytes) /
          bytes,
      );
      expect(bytes).toBeLessThanOrEqual(memoryIndexPolicy.maximumResponseBytes);
      for (let i = 0; i < maximum; i++) expect(await f.read(1)).toBe(text);
      const before = await f.stored();
      await expect(f.read(1)).rejects.toMatchObject(exhausted);
      expect(await f.stored()).toEqual(before);
    });

    it.each(['document', 'pin', 'reads', 'bytes', 'revision', 'pair'] as const)(
      'refuses corrupted %s without repair or spending',
      async (change) => {
        const f = await setup([{ summary: '保留摘要', details: '原说明' }]);
        const issued = await f.issue();
        const id = issued.state.pins[0]!.id;
        if (change === 'revision')
          await database.db`delete from allrice_memory_revisions where memory_id=${id}`;
        else if (change === 'pair')
          await database.db`update allrice_memory_revisions set details='被篡改的旧说明' where memory_id=${id}`;
        else {
          const state = structuredClone(issued.state);
          let document = issued.document;
          if (change === 'document') {
            document = issued.document.replace('保留摘要', '其他摘要');
            state.initial.documentDigest = runtimePolicyDigest(document);
            state.initial.bytes = Buffer.byteLength(document, 'utf8');
            state.spentBytes = state.initial.bytes;
          }
          if (change === 'pin') state.pins[0]!.hasDetails = false;
          if (change === 'reads') state.toolReads = -1;
          if (change === 'bytes') state.spentBytes = state.initial.bytes - 1;
          await database.db`update allrice_employee_memory_contexts
        set state=${database.db.json(state)},document=${document} where id=${issued.id}`;
        }
        await expect(f.read(1)).rejects.toMatchObject(refused);
        await expect(f.issue()).rejects.toMatchObject(refused);
      },
    );

    it('joins real SQL waiting on the context lock after abort and rolls back precommit spending', async () => {
      const f = await setup([{ summary: '在途取消', details: '完整正文' }]);
      const issued = await f.issue();
      const locked = deferred(),
        release = deferred();
      const blocker = database.db.begin(async (tx) => {
        await tx`select id from allrice_employee_memory_contexts where id=${issued.id} for update`;
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const controller = new AbortController();
      const applicationName = `memory-context-wait:${randomUUID()}`;
      let settled = false;
      const read = f
        .read(1, controller.signal, f.rootSessionRef, { applicationName })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          settled = true;
        });
      try {
        await vi.waitFor(async () => {
          const [row] =
            await database.db`select exists(select 1 from pg_stat_activity
          where application_name=${applicationName} and wait_event_type='Lock') waiting`;
          expect(row!.waiting).toBe(true);
        });
        controller.abort(new Error('fixture canceled during SQL'));
        expect(settled).toBe(false);
      } finally {
        release.resolve();
        await blocker;
      }
      expect(await read).toMatchObject({ error: controller.signal.reason });
      expect((await f.stored())!.state).toEqual(issued.state);
    });

    it('keeps committed spend and the same B after canceled delivery or unknown ACK; never refunds or changes key', async () => {
      const f = await setup([{ summary: '提交后未知', details: '完整说明' }]);
      const issued = await f.issue();
      const budgetRef = f.key.budgetRef;
      const committed = deferred(),
        deliver = deferred();
      const controller = new AbortController();
      const canceled = f
        .read(1, controller.signal, f.rootSessionRef, {
          afterCommit: async () => {
            committed.resolve();
            await deliver.promise;
          },
        })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      await committed.promise;
      expect((await f.stored())!.state.toolReads).toBe(1);
      controller.abort(new Error('fixture canceled after commit'));
      deliver.resolve();
      expect(await canceled).toMatchObject({ error: controller.signal.reason });
      const unknown = new Error('fixture ACK delivery unknown after commit');
      await expect(
        f.read(1, live(), f.childSessionRef, {
          afterCommit: async () => {
            throw unknown;
          },
        }),
      ).rejects.toBe(unknown);
      const stored = (await f.stored())!;
      expect(stored.state.toolReads).toBe(2);
      expect(stored.state.spentBytes).toBeGreaterThan(issued.state.spentBytes);
      expect((await f.issue()).state).toEqual(stored.state);
      expect(f.key.budgetRef).toBe(budgetRef);
    });
  },
);
