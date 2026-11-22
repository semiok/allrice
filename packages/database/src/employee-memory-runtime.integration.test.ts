/** Actual PG transactions, original memory writers and 990 caller lifecycle.
 * ONLY the missing module/B/call/human-source/restore producers are represented
 * by the explicitly named owner contract fixture below. Its relation and
 * private assembly mock are never installed in production or a public port. */
import { randomUUID } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import type { Sql, TransactionSql } from 'postgres';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  AdoptedHumanSourceProjectionSchema,
  CurrentEmployeeBusinessProjectionSchema,
  LogicalExecutionBindingProjectionSchema,
  RunMemoryContextV2StateSchema,
  renderMemoryDetailV2,
  type ActualNativeCallSelectorProjection,
  type AdoptedHumanSourceProjection,
  type EmployeeBusinessTargetProjection,
  type PersonalMemoryPair,
  type RequestContext,
} from '@allrice/contracts';
import { z } from 'zod';
import * as client from './core/client.ts';
import {
  createEmployeeMemoryPort,
  EmployeeMemoryWriteOutcomeUnknown,
} from './employee-memory-port.ts';
import {
  NativeMemoryReconcileTargetSchema,
  type NativeMemoryTarget,
} from './employee-memory-runtime.ts';
import { nativeMemorySource } from './memory-native-source.ts';
import type * as MemoryRuntimeBinding from './memory-runtime-binding.ts';
import type {
  MemoryRuntimeAssembly,
  MemoryRuntimeExecution,
  MemoryRuntimeOwnerReads,
} from './memory-runtime-binding.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from './identity.ts';
import { ensureGeneralEmployeeInstance } from './employees/employee-instances.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { ensureDefaultEmployee } from './workspace/service.ts';
import { insertEmployeeMemoryPair } from './workspace/employee-memory-mutation.ts';
import type { EmployeeMemoryScope } from './workspace/employee-memory.ts';

const ownerFixture = vi.hoisted(() => ({
  assembly: null as MemoryRuntimeAssembly | null,
}));
vi.mock('./memory-runtime-binding.ts', async (original) => {
  const actual = await original<typeof MemoryRuntimeBinding>();
  return {
    ...actual,
    requireMemoryRuntimeAssembly: () =>
      ownerFixture.assembly ?? actual.requireMemoryRuntimeAssembly(),
  };
});

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const live = () => new AbortController().signal;
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const release = {
  moduleId: 'employee-memory',
  contractVersion: 1 as const,
  contentVersion: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
};
const ExecutionSchema = z
  .object({
    binding: LogicalExecutionBindingProjectionSchema,
    nativeOwnerRef: z.string(),
    nativeProfileRef: z.string(),
    nativeSessionRef: z.string(),
    parentSessionRef: z.string().nullable(),
    moduleConfigRevisionRef: z.string(),
  })
  .strict();
type AuthorityRow = {
  allowed: boolean;
  source_allowed: boolean;
  execution_live: boolean;
  revision: number;
  config_ref: string;
  facts: unknown;
  observations: unknown;
  revoked_sources: string[];
  restore_expected: boolean;
  source_revision: number;
};

suite(
  'native memory owner transactions under an explicit producer contract fixture',
  () => {
    let database: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    const releases: (() => void)[] = [],
      pending: Promise<unknown>[] = [];
    const track = <T>(promise: Promise<T>) => {
      pending.push(promise);
      void promise.catch(() => {});
      return promise;
    };
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      database = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(database.db);
      await database.db`create table memory_runtime_owner_contract_fixture(
      id uuid primary key,owner_id uuid not null,allowed boolean not null default true,
      execution_live boolean not null default true,
      revision integer not null default 1,config_ref text not null,
      facts jsonb not null,observations jsonb not null,
      restore_expected boolean not null default false,reject_receipt boolean not null default false,receipt_gate text,commit_gate text,context_gate text)`;
      await database.db`create table memory_runtime_source_contract_fixture(
      id uuid primary key references memory_runtime_owner_contract_fixture(id),
      source_allowed boolean not null default true,revoked_sources text[] not null default '{}',revision integer not null default 1)`;
      await database.db`create function memory_runtime_contract_reject_receipt() returns trigger language plpgsql as $$
      declare gate_key text;
      begin
        select receipt_gate into gate_key from memory_runtime_owner_contract_fixture where owner_id=new.owner_id;
        if gate_key is not null then perform pg_advisory_xact_lock(hashtextextended(gate_key,0)); end if;
        if exists(select 1 from memory_runtime_owner_contract_fixture f where f.owner_id=new.owner_id and f.reject_receipt)
          then raise exception 'fixture_receipt_rejected' using errcode='P0001'; end if;
        return new;
      end $$`;
      await database.db`create trigger memory_runtime_contract_reject_receipt before insert on allrice_employee_memory_operations
      for each row execute function memory_runtime_contract_reject_receipt()`;
      await database.db`create function memory_runtime_contract_commit_gate() returns trigger language plpgsql as $$
      declare gate_key text;
      begin
        select commit_gate into gate_key from memory_runtime_owner_contract_fixture where owner_id=new.owner_id;
        if gate_key is not null then perform pg_advisory_xact_lock(hashtextextended(gate_key,0)); end if;
        return new;
      end $$`;
      await database.db`create constraint trigger memory_runtime_contract_commit_gate after insert on allrice_employee_memory_operations
      deferrable initially deferred for each row execute function memory_runtime_contract_commit_gate()`;
      await database.db`create function memory_runtime_contract_context_gate() returns trigger language plpgsql as $$
      declare gate_key text;
      begin
        select context_gate into gate_key from memory_runtime_owner_contract_fixture where owner_id=new.owner_id;
        if gate_key is not null then perform pg_advisory_xact_lock(hashtextextended(gate_key,0)); end if;
        return new;
      end $$`;
      await database.db`create trigger memory_runtime_contract_context_gate before update on allrice_employee_memory_contexts
      for each row execute function memory_runtime_contract_context_gate()`;
    }, 120000);
    afterEach(async () => {
      for (const releaseGate of releases.splice(0)) releaseGate();
      await Promise.allSettled(pending.splice(0));
      ownerFixture.assembly = null;
      vi.restoreAllMocks();
      vi.spyOn(client, 'getDatabase').mockReturnValue(database.db);
    }, 30000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await database?.close();
    }, 30000);

    class MissingProducerOwnerContractFixture implements MemoryRuntimeAssembly {
      readonly id = randomUUID();
      readonly threadId = randomUUID();
      readonly rootRequest = `fixture-root-request:${randomUUID()}`;
      readonly rememberRequest = `fixture-remember-request:${randomUUID()}`;
      readonly readRequest = `fixture-read-request:${randomUUID()}`;
      readonly childRequest = `fixture-child-request:${randomUUID()}`;
      readonly applicationName = `memory-runtime-contract:${randomUUID()}`;
      readonly pids: number[] = [];
      readonly businessScope;
      readonly root: MemoryRuntimeExecution;
      readonly observations: Record<string, MemoryRuntimeExecution>;
      readonly port = createEmployeeMemoryPort({
        qualification: {
          requireCurrentAccess: async (_context, _target, signal) => {
            await this.row(database.db, false, signal);
          },
        },
      });
      constructor(
        readonly context: RequestContext,
        readonly scope: EmployeeMemoryScope,
      ) {
        this.businessScope = {
          organizationId: scope.organizationId,
          workspaceId: scope.workspaceId,
          ownerId: scope.ownerId,
          employeeInstanceId: scope.instanceId,
          employeeId: scope.employeeId,
        };
        const rootSessionRef = `fixture-root:${randomUUID()}`;
        this.root = {
          binding: {
            scope: this.businessScope,
            threadId: this.threadId,
            executionGeneration: '4.0',
            b: `fixture-B:${randomUUID()}`,
            executionBoundaryRef: `fixture-boundary:${randomUUID()}`,
            rootOriginRef: `fixture-root-origin:${randomUUID()}`,
            rootSessionRef,
            nativeCall: null,
          },
          nativeOwnerRef: `fixture-original-owner:${randomUUID()}`,
          nativeProfileRef: `fixture-original-profile:${randomUUID()}`,
          nativeSessionRef: rootSessionRef,
          parentSessionRef: null,
          moduleConfigRevisionRef: 'fixture-config-1',
        };
        const call = {
          rootSessionRef,
          parentSessionRef: null,
          sessionRef: rootSessionRef,
          callRef: `fixture-call:${randomUUID()}`,
          toolId: 'memory_remember',
          toolVersion: 'fixture-native-v1',
        };
        const childSessionRef = `fixture-child:${randomUUID()}`;
        this.observations = {
          [this.rootRequest]: this.root,
          [this.rememberRequest]: {
            ...this.root,
            binding: { ...this.root.binding, nativeCall: call },
          },
          [this.readRequest]: {
            ...this.root,
            binding: {
              ...this.root.binding,
              nativeCall: {
                ...call,
                callRef: `fixture-read:${randomUUID()}`,
                toolId: 'memory_read',
              },
            },
          },
          [this.childRequest]: {
            ...this.root,
            nativeSessionRef: childSessionRef,
            parentSessionRef: rootSessionRef,
            binding: {
              ...this.root.binding,
              nativeCall: {
                ...call,
                parentSessionRef: rootSessionRef,
                sessionRef: childSessionRef,
                callRef: `fixture-child-read:${randomUUID()}`,
                toolId: 'memory_read',
              },
            },
          },
        };
      }
      async install() {
        await database.db`insert into memory_runtime_owner_contract_fixture(id,owner_id,config_ref,facts,observations)
        values(${this.id},${this.scope.ownerId},'fixture-config-1',${JSON.stringify(this.root)}::jsonb,${JSON.stringify(this.observations)}::jsonb)`;
        await database.db`insert into memory_runtime_source_contract_fixture(id) values(${this.id})`;
        ownerFixture.assembly = this;
        return this;
      }
      async row(tx: Sql | TransactionSql, lock: boolean, signal: AbortSignal) {
        const [row] = await tx<
          AuthorityRow[]
        >`select f.*,s.source_allowed,s.revoked_sources,s.revision source_revision
        from memory_runtime_owner_contract_fixture f join memory_runtime_source_contract_fixture s on s.id=f.id
        where f.id=${this.id} ${lock ? tx`for share of f` : tx``}`;
        signal.throwIfAborted();
        if (!row?.allowed) throw Error('fixture_current_module_denied');
        return row;
      }
      projection(target: EmployeeBusinessTargetProjection, row: AuthorityRow) {
        if (
          target.workspaceId !== this.scope.workspaceId ||
          target.employeeInstanceId !== this.scope.instanceId ||
          target.threadId !== this.threadId ||
          (target.module.kind === 'required' &&
            JSON.stringify(target.module.release) !== JSON.stringify(release))
        )
          throw Error('fixture_current_target_denied');
        return CurrentEmployeeBusinessProjectionSchema.parse({
          scope: this.businessScope,
          threadId: target.threadId,
          access: target.access,
          identityRevisionRef: `fixture-current-${row.revision}`,
          executionGeneration: '4.0',
          module:
            target.module.kind === 'not-applicable'
              ? { kind: 'not-applicable' }
              : {
                  kind: 'required',
                  binding: {
                    organizationId: this.scope.organizationId,
                    workspaceId: this.scope.workspaceId,
                    ownerId: this.scope.ownerId,
                    instanceId: this.scope.instanceId,
                    release,
                    revision: row.revision,
                    enabledAt: '2026-11-22T00:00:00Z',
                    revokedAt: null,
                  },
                  configDigest: `fixture-config-digest:${row.config_ref}`,
                },
        });
      }
      async current(
        _context: RequestContext,
        target: EmployeeBusinessTargetProjection,
        signal: AbortSignal,
      ) {
        return this.projection(
          target,
          await this.row(database.db, false, signal),
        );
      }
      source(
        call: ActualNativeCallSelectorProjection,
        row: AuthorityRow,
      ): AdoptedHumanSourceProjection {
        const observations = z
          .record(z.string(), ExecutionSchema)
          .parse(row.observations);
        if (
          !row.source_allowed ||
          !Object.values(observations).some(
            (observation) =>
              JSON.stringify(observation.binding.nativeCall) ===
              JSON.stringify(call.nativeCall),
          ) ||
          call.nativeCall.toolId !== 'memory_remember' ||
          JSON.stringify(call.scope) !== JSON.stringify(this.businessScope) ||
          call.b !== this.root.binding.b ||
          call.threadId !== this.threadId ||
          call.executionBoundaryRef !==
            this.root.binding.executionBoundaryRef ||
          call.rootOriginRef !== this.root.binding.rootOriginRef
        )
          throw Error('fixture_actual_human_source_denied');
        const sourceRef = `fixture-human:${call.nativeCall.callRef}`;
        if (row.revoked_sources.includes(sourceRef))
          throw Error('fixture_current_source_revoked');
        return AdoptedHumanSourceProjectionSchema.parse({
          ...call,
          sourceRef,
          proof: {
            version: 'fixture-proof-v1',
            digest: `fixture-proof:${call.nativeCall.callRef}`,
          },
          accessRevisionRef: `fixture-access-${row.source_revision}`,
          kind: 'ordinary-human-message',
        });
      }
      async bind(
        tx: Sql | TransactionSql,
        _context: RequestContext,
        target: EmployeeBusinessTargetProjection,
        signal: AbortSignal,
      ): Promise<MemoryRuntimeOwnerReads> {
        const [identity] = await tx<
          { pid: number }[]
        >`select set_config('application_name',${this.applicationName},true),pg_backend_pid() pid`;
        this.pids.push(identity!.pid);
        const read = () => this.row(tx, true, signal);
        // Distinct current/module and human-source owners preserve the declared
        // lock order. Source authority is acquired AFTER memory-order by native
        // and existing management transitions alike; no reverse lock upgrade.
        const readSource = async () => {
          const row = await this.row(tx, false, signal);
          const [source] = await tx<
            {
              source_allowed: boolean;
              revoked_sources: string[];
              source_revision: number;
            }[]
          >`
          select source_allowed,revoked_sources,revision source_revision from memory_runtime_source_contract_fixture where id=${this.id} for share`;
          return { ...row, ...source! };
        };
        return {
          current: async () => {
            const row = await read();
            // A synthetic restore producer is explicit about its consistency
            // requirement. No missing snapshot is silently granted fresh budget.
            if (row.restore_expected) {
              const [stored] =
                await tx`select id from allrice_employee_memory_contexts
              where organization_id=${this.scope.organizationId} and instance_id=${this.scope.instanceId} and budget_ref=${this.root.binding.b}`;
              if (!stored) throw Error('fixture_restore_collection_incomplete');
            }
            return this.projection(target, row);
          },
          actual: async (selector) => {
            const row = await read(),
              observations = z
                .record(z.string(), ExecutionSchema)
                .parse(row.observations);
            if (
              !row.execution_live ||
              selector.workspaceId !== this.scope.workspaceId ||
              selector.employeeInstanceId !== this.scope.instanceId ||
              selector.threadId !== this.threadId
            )
              throw Error('fixture_actual_execution_denied');
            const execution = observations[selector.nativeRequestRef];
            if (!execution) throw Error('fixture_actual_request_unknown');
            return { ...execution, moduleConfigRevisionRef: row.config_ref };
          },
          stored: async (selector) => {
            const row = await read();
            if (
              selector.workspaceId !== this.scope.workspaceId ||
              selector.employeeInstanceId !== this.scope.instanceId ||
              selector.threadId !== this.threadId ||
              selector.b !== this.root.binding.b
            )
              throw Error('fixture_stored_execution_denied');
            return ExecutionSchema.parse(row.facts);
          },
          adopted: async (selector) => {
            const row = await readSource();
            if (!row.execution_live)
              throw Error('fixture_actual_execution_denied');
            return this.source(selector, row);
          },
          storedSource: async (selector) => {
            // Deliberately independent of execution_live. Current source and
            // original call association still have to be present and match.
            const result = this.source(selector, await readSource());
            if (result.sourceRef !== selector.sourceRef)
              throw Error('fixture_stored_source_mismatch');
            return result;
          },
        };
      }
      target(nativeRequestRef = this.rootRequest): NativeMemoryTarget {
        return {
          workspaceId: this.scope.workspaceId,
          employeeInstanceId: this.scope.instanceId,
          threadId: this.threadId,
          nativeRequestRef,
          moduleRelease: release,
        };
      }
      issue(signal = live()) {
        return this.port.issueContext(this.context, this.target(), signal);
      }
      read(number: number, signal = live(), request = this.readRequest) {
        return this.port.readOrdinal(
          this.context,
          this.target(request),
          { number },
          signal,
        );
      }
      remember(
        input: unknown = { summary: '原始候选', details: '原始完整说明' },
        signal = live(),
        request = this.rememberRequest,
      ) {
        return this.port.remember(
          this.context,
          this.target(request),
          input,
          signal,
        );
      }
      async reconcile(request = this.rememberRequest) {
        const row = await this.row(database.db, false, live()),
          observation = this.observations[request];
        if (!observation?.binding.nativeCall)
          throw Error('fixture_real_call_required');
        const b = observation.binding,
          source = this.source(
            {
              scope: b.scope,
              threadId: b.threadId,
              b: b.b,
              executionBoundaryRef: b.executionBoundaryRef,
              rootOriginRef: b.rootOriginRef,
              nativeCall: observation.binding.nativeCall,
            },
            row,
          );
        return this.port.reconcileRemember(
          this.context,
          NativeMemoryReconcileTargetSchema.parse({
            scope: source.scope,
            threadId: source.threadId,
            b: source.b,
            executionBoundaryRef: source.executionBoundaryRef,
            rootOriginRef: source.rootOriginRef,
            nativeCall: source.nativeCall,
            sourceRef: source.sourceRef,
            moduleRelease: release,
          }),
          live(),
        );
      }
      async state() {
        const [row] = await database.db<
          {
            id: string;
            document: string;
            state: unknown;
            module_config_revision_ref: string;
          }[]
        >`
        select id,document,state,module_config_revision_ref from allrice_employee_memory_contexts
        where organization_id=${this.scope.organizationId} and workspace_id=${this.scope.workspaceId}
          and owner_id=${this.scope.ownerId} and instance_id=${this.scope.instanceId} and budget_ref=${this.root.binding.b}`;
        return row
          ? { ...row, state: RunMemoryContextV2StateSchema.parse(row.state) }
          : null;
      }
      async change(
        fields: Partial<{
          allowed: boolean;
          source_allowed: boolean;
          execution_live: boolean;
          config_ref: string;
          revoked_sources: string[];
          restore_expected: boolean;
          reject_receipt: boolean;
          receipt_gate: string | null;
          commit_gate: string | null;
          context_gate: string | null;
        }>,
      ) {
        const { source_allowed, revoked_sources, ...current } = fields;
        const source = {
          ...(source_allowed === undefined ? {} : { source_allowed }),
          ...(revoked_sources === undefined ? {} : { revoked_sources }),
        };
        await database.db.begin(async (tx) => {
          if (Object.keys(current).length)
            await tx`update memory_runtime_owner_contract_fixture set ${tx(current)},revision=revision+1 where id=${this.id}`;
          if (Object.keys(source).length)
            await tx`update memory_runtime_source_contract_fixture set ${tx(source)},revision=revision+1 where id=${this.id}`;
        });
      }
      async secondCall() {
        const request = `fixture-another-request:${randomUUID()}`,
          old = this.observations[this.rememberRequest];
        if (!old?.binding.nativeCall) throw Error('fixture_real_call_required');
        this.observations[request] = {
          ...old,
          binding: {
            ...old.binding,
            nativeCall: {
              ...old.binding.nativeCall,
              callRef: `fixture-call:${randomUUID()}`,
            },
          },
        };
        await database.db`update memory_runtime_owner_contract_fixture set observations=${JSON.stringify(this.observations)}::jsonb where id=${this.id}`;
        return request;
      }
    }

    async function setup(pairs: PersonalMemoryPair[] = []) {
      const suffix = randomUUID();
      const principal = await ensureBootstrapPortalPrincipal({
        organizationSlug: `native-memory-${suffix}`,
        organizationName: 'Native memory fixture',
        workspaceSlug: 'default',
        workspaceName: 'Default',
        email: `native-memory-${suffix}@example.test`,
        displayName: 'Owner',
        role: 'member',
      });
      const authenticated = (await authenticateSession(
        (await createSession(principal.user.id)).token,
        principal,
      ))!;
      const context = { ...authenticated, workspaceId: principal.workspaceId };
      const assignment = await ensureDefaultEmployee(
        context,
        principal.workspaceId,
      );
      if (!assignment) throw Error('fixture_assignment_required');
      await ensureGeneralEmployeeInstance(database.db, assignment.id);
      const f = await new MissingProducerOwnerContractFixture(context, {
        organizationId: principal.organizationId,
        workspaceId: principal.workspaceId,
        ownerId: principal.user.id,
        instanceId: assignment.id,
        employeeId: assignment.employeeId,
      }).install();
      await database.db.begin(async (tx) => {
        for (const pair of pairs)
          await insertEmployeeMemoryPair(tx, context, f.scope, pair, {
            sourceType: 'user',
            sourceId: null,
            sourceLabel: 'real pair fixture',
            trust: 'user_confirmed',
            confidence: 1,
            lifecycleState: 'durable',
            memoryClass: 'work_note',
          });
      });
      return f;
    }
    async function effects(f: MissingProducerOwnerContractFixture) {
      const [row] = await database.db<
        {
          memories: number;
          revisions: number;
          audits: number;
          operations: number;
        }[]
      >`
      select (select count(*)::int from allrice_memories where owner_id=${f.scope.ownerId}) memories,
        (select count(*)::int from allrice_memory_revisions r join allrice_memories m on m.id=r.memory_id where m.owner_id=${f.scope.ownerId}) revisions,
        (select count(*)::int from allrice_audit_events where actor_id=${f.scope.ownerId} and action='memory.create') audits,
        (select count(*)::int from allrice_employee_memory_operations where owner_id=${f.scope.ownerId}) operations`;
      return row;
    }
    async function mutation(
      f: MissingProducerOwnerContractFixture,
      id: string,
    ) {
      const detail = await f.port.detail(
        f.context,
        {
          workspaceId: f.scope.workspaceId,
          instanceId: f.scope.instanceId,
          memoryId: id,
        },
        live(),
      );
      return {
        target: { workspaceId: f.scope.workspaceId, memoryId: id },
        body: {
          instanceId: f.scope.instanceId,
          expectedRevision: detail.memory.revision,
          pairDigest: detail.memory.pairDigest,
          idempotencyKey: randomUUID(),
        },
      };
    }
    async function hold(work: (tx: TransactionSql) => Promise<unknown>) {
      const entered = gate<number>(),
        releaseGate = gate();
      releases.push(() => releaseGate.resolve());
      const holding = track(
        database.db.begin(async (tx) => {
          const [identity] = await tx<
            { pid: number }[]
          >`select pg_backend_pid() pid`;
          await work(tx);
          entered.resolve(identity!.pid);
          await releaseGate.promise;
        }),
      );
      return {
        pid: await entered.promise,
        release: () => releaseGate.resolve(),
        done: holding,
      };
    }
    async function blockedBy(blocker: number) {
      let ids: number[] = [];
      await expect
        .poll(async () => {
          const rows = await database.db<
            { pid: number }[]
          >`select pid from pg_stat_activity
        where datname=current_database() and pid<>pg_backend_pid() and ${blocker}=any(pg_blocking_pids(pid)) order by pid`;
          ids = rows.map((row) => row.pid);
          return ids;
        })
        .toHaveLength(1);
      return ids[0]!;
    }

    it.each([0, 100, 101])(
      'issues the COMPLETE ordinary active set at %i without truncation or a 2048-token cap',
      async (count) => {
        const f = await setup(
          Array.from({ length: count }, (_, i) => ({
            summary: `${String(i).padStart(3, '0')}${'😀'.repeat(37)}`,
            details: i % 2 ? null : '完整说明',
          })),
        );
        if (count > 100) {
          await expect(f.issue()).rejects.toMatchObject({
            code: 'MEMORY_CONTEXT_UNAVAILABLE',
          });
          expect(await f.state()).toBeNull();
          return;
        }
        const text = await f.issue(),
          saved = (await f.state())!;
        expect(saved.state.pins).toHaveLength(count);
        expect(saved.state.initial.bytes).toBe(Buffer.byteLength(text, 'utf8'));
        if (count === 100)
          expect(saved.state.initial.bytes).toBeGreaterThan(15_000);
        expect(saved.state.spentBytes).toBe(saved.state.initial.bytes);
        expect(await f.issue()).toBe(text);
        expect((await f.state())!.id).toBe(saved.id);
        const [runs] =
          await database.db`select count(*)::int n from allrice_employee_runs where owner_id=${f.scope.ownerId}`;
        expect(runs!.n).toBe(0);
      },
    );

    it('persists one pending pair/revision/audit/receipt for concurrent same-call retries, and conflicts on changed payload', async () => {
      const f = await setup(
        Array.from({ length: 100 }, (_, i) => ({
          summary: `active${i}`,
          details: null,
        })),
      );
      const before = (await effects(f))!;
      const input = {
        summary: ' 同一\n候选 ',
        details: '完整\n条件😀',
        memoryClass: 'user_preference',
      };
      const results = await Promise.all([
        f.remember(input),
        f.remember(input),
        f.remember(input),
      ]);
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
      expect(results[0]).toMatchObject({
        summary: '同一 候选',
        state: 'pending',
        requiresConfirmation: true,
      });
      await f.change({ config_ref: 'fixture-config-2' });
      expect(await f.remember(input)).toEqual(results[0]);
      expect(await effects(f)).toEqual({
        memories: before.memories + 1,
        revisions: before.revisions + 1,
        audits: before.audits + 1,
        operations: before.operations + 1,
      });
      await expect(
        f.remember({ ...input, details: '不同完整内容' }),
      ).rejects.toMatchObject({ details: { reason: 'idempotency_conflict' } });
      const list = await f.port.list(
        f.context,
        { workspaceId: f.scope.workspaceId, instanceId: f.scope.instanceId },
        live(),
      );
      expect(list.counts).toEqual({ active: 100, pending: 1, maxActive: 100 });
      const [row] = await database.db<
        { source_type: string; source_id: string | null; metadata: unknown }[]
      >`
      select source_type,source_id,metadata from allrice_memories where id=${results[0]!.id}`;
      expect(row).toMatchObject({ source_type: 'message', source_id: null });
      const metadata = nativeMemorySource(row!.metadata)!;
      expect(metadata.nativeCall.callRef).toBe(
        f.observations[f.rememberRequest]!.binding.nativeCall!.callRef,
      );
      expect(metadata.b).toBe(f.root.binding.b);
      expect(metadata).not.toHaveProperty('accessRevisionRef');
      expect(await f.reconcile()).toMatchObject({
        status: 'recorded',
        id: results[0]!.id,
        originalReceiptCurrent: true,
      });
    });

    it.each(['confirm', 'correct', 'withdraw'] as const)(
      'uses original %s semantics, keeps native metadata and invalidates the old candidate receipt',
      async (action) => {
        const f = await setup(),
          receipt = await f.remember();
        const expected = await mutation(f, receipt.id);
        await f.change({ execution_live: false });
        if (action === 'correct')
          await f.port.correct(
            f.context,
            {
              ...expected,
              body: {
                ...expected.body,
                summary: '本人更正后的摘要',
                details: '完整更正',
                reason: 'owner correction',
              },
            },
            live(),
          );
        else await f.port[action](f.context, expected, live());
        const current = await f.reconcile();
        expect(current).toMatchObject({
          id: receipt.id,
          revision: receipt.revision + 1,
          state: action === 'withdraw' ? 'withdrawn' : 'active',
          originalReceiptCurrent: false,
        });
        expect(current).not.toHaveProperty('summary');
        await f.change({ execution_live: true });
        await expect(f.remember()).rejects.toMatchObject({
          details: { reason: 'idempotency_conflict' },
        });
        const [row] = await database.db<
          { metadata: unknown }[]
        >`select metadata from allrice_memories where id=${receipt.id}`;
        expect(nativeMemorySource(row!.metadata)).not.toBeNull();
      },
    );

    it('requires real current source for pending transitions, while message/null without controlled native metadata stays denied', async () => {
      const f = await setup(),
        receipt = await f.remember(),
        expected = await mutation(f, receipt.id);
      await f.change({ execution_live: false, source_allowed: false });
      await expect(f.port.confirm(f.context, expected, live())).rejects.toThrow(
        'fixture_actual_human_source_denied',
      );
      await expect(
        f.port.correct(
          f.context,
          {
            ...expected,
            body: {
              ...expected.body,
              summary: '更正',
              details: null,
              reason: 'owner correction',
            },
          },
          live(),
        ),
      ).rejects.toThrow('fixture_actual_human_source_denied');
      await f.change({ source_allowed: true });
      let legacy!: Awaited<ReturnType<typeof insertEmployeeMemoryPair>>;
      await database.db.begin(async (tx) => {
        legacy = await insertEmployeeMemoryPair(
          tx,
          f.context,
          f.scope,
          { summary: '没有受管来源', details: null },
          {
            sourceType: 'message',
            sourceId: null,
            sourceLabel: 'unqualified fixture',
            trust: 'derived',
            confidence: 0.8,
            lifecycleState: 'candidate',
            memoryClass: 'work_note',
          },
        );
      });
      await expect(
        f.port.confirm(f.context, await mutation(f, legacy.id), live()),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(
        (
          await f.port.detail(
            f.context,
            {
              workspaceId: f.scope.workspaceId,
              instanceId: f.scope.instanceId,
              memoryId: receipt.id,
            },
            live(),
          )
        ).memory.state,
      ).toBe('pending');
      // No original execution is required for the actual stored-source branch.
      await f.port.confirm(f.context, expected, live());
      expect((await f.reconcile()).state).toBe('active');
    });

    it('rechecks ALL issued pins: withdrawing one source prevents disclosing the other ordinal without spending budget', async () => {
      const f = await setup(),
        a = await f.remember(),
        otherRequest = await f.secondCall(),
        b = await f.remember(
          { summary: '另一条候选', details: '另一条完整说明' },
          live(),
          otherRequest,
        );
      await f.port.confirm(f.context, await mutation(f, a.id), live());
      await f.port.confirm(f.context, await mutation(f, b.id), live());
      await f.issue();
      const before = (await f.state())!,
        aPin = before.state.pins.find((pin) => pin.id === a.id)!,
        bPin = before.state.pins.find((pin) => pin.id === b.id)!;
      expect(aPin.number).not.toBe(bPin.number);
      await f.change({
        revoked_sources: [
          `fixture-human:${f.observations[f.rememberRequest]!.binding.nativeCall!.callRef}`,
        ],
      });
      await expect(f.read(bPin.number)).rejects.toThrow(
        'fixture_current_source_revoked',
      );
      expect((await f.state())!.state).toEqual(before.state);
    });

    it('restores old B/pins and consumed UTF-8 budget across fresh dedicated sessions/config/edit, and never repairs a missing restore collection', async () => {
      const original = { summary: '原摘要😀', details: '原完整条件😀' },
        f = await setup([original]);
      const document = await f.issue(),
        initial = (await f.state())!;
      expect(await f.read(1)).toBe(renderMemoryDetailV2(1, original));
      const spent = (await f.state())!;
      const id = initial.state.pins[0]!.id,
        expected = await mutation(f, id);
      await f.port.correct(
        f.context,
        {
          ...expected,
          body: {
            ...expected.body,
            summary: '当前更正摘要',
            details: '当前更正说明',
            reason: 'current edit',
          },
        },
        live(),
      );
      await f.port.create(
        f.context,
        {
          workspaceId: f.scope.workspaceId,
          instanceId: f.scope.instanceId,
          idempotencyKey: randomUUID(),
          summary: '后来新增',
          details: null,
        },
        live(),
      );
      await f.change({
        config_ref: 'fixture-config-2',
        restore_expected: true,
      });
      expect(await f.issue()).toBe(document);
      expect((await f.state())!.state).toEqual(spent.state);
      expect((await f.state())!.module_config_revision_ref).toBe(
        'fixture-config-1',
      );
      expect(await f.read(1, live(), f.childRequest)).toBe(
        renderMemoryDetailV2(1, original),
      );
      expect((await f.state())!.state.spentBytes).toBe(
        spent.state.spentBytes +
          Buffer.byteLength(renderMemoryDetailV2(1, original), 'utf8'),
      );
      await database.db`delete from allrice_employee_memory_contexts where id=${initial.id}`;
      await expect(f.read(1)).rejects.toThrow(
        'fixture_restore_collection_incomplete',
      );
      await expect(f.issue()).rejects.toThrow(
        'fixture_restore_collection_incomplete',
      );
      expect(await f.state()).toBeNull();
    });

    it('shares root/child allowance, charges complete repeated reads and refuses the thirteenth without reset', async () => {
      const pair = { summary: '重复读取', details: '完整说明😀' },
        f = await setup([pair]);
      await f.issue();
      await expect(
        f.port.issueContext(f.context, f.target(f.childRequest), live()),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const text = renderMemoryDetailV2(1, pair),
        initial = (await f.state())!.state.initial.bytes;
      for (let i = 0; i < 12; i++)
        expect(
          await f.read(1, live(), i % 2 ? f.childRequest : f.readRequest),
        ).toBe(text);
      const state = (await f.state())!.state;
      expect(state.toolReads).toBe(12);
      expect(state.spentBytes).toBe(
        initial + 12 * Buffer.byteLength(text, 'utf8'),
      );
      await expect(f.read(1)).rejects.toMatchObject({
        code: 'MEMORY_CONTEXT_BUDGET_EXHAUSTED',
      });
      await f.issue();
      expect((await f.state())!.state).toEqual(state);
    });

    it('rolls back the actual pair/revision/audit when original receipt insertion fails, preserving the SQL diagnosis', async () => {
      const f = await setup(),
        before = await effects(f);
      await f.change({ reject_receipt: true });
      await expect(f.remember()).rejects.toMatchObject({
        code: 'P0001',
        message: 'fixture_receipt_rejected',
      });
      expect(await effects(f)).toEqual(before);
      await expect(f.reconcile()).rejects.toMatchObject({
        code: 'MEMORY_CONTEXT_UNAVAILABLE',
      });
      await f.change({ reject_receipt: false });
      const original = await f.remember();
      expect((await f.reconcile()).id).toBe(original.id);
      expect(await effects(f)).toMatchObject({
        memories: 1,
        revisions: 1,
        audits: 1,
        operations: 1,
      });
    });

    it('serializes original-call reconciliation behind the real in-flight memory transaction, rather than reporting temporary absence as zero effect', async () => {
      const f = await setup(),
        key = `fixture-native-receipt-gate:${randomUUID()}`;
      await f.change({ receipt_gate: key });
      const fixtureLock = await hold(
        (tx) => tx`select pg_advisory_xact_lock(hashtextextended(${key},0))`,
      );
      const remembering = track(f.remember());
      const nativePid = await blockedBy(fixtureLock.pid);
      // The actual writer has already inserted pair/revision/audit, and holds
      // original memory-order/operation locks while its real receipt SQL blocks.
      const reconciling = track(f.reconcile());
      expect(await blockedBy(nativePid)).toBeGreaterThan(0);
      fixtureLock.release();
      await fixtureLock.done;
      const receipt = await remembering;
      expect(await reconciling).toMatchObject({
        id: receipt.id,
        originalReceiptCurrent: true,
      });
      expect(await f.reconcile()).toMatchObject({
        id: receipt.id,
        originalReceiptCurrent: true,
      });
      expect((await effects(f))!.memories).toBe(1);
    });

    it('joins actual blocked SQL/rollback on abort and returns the original cancellation only after no candidate effect remains', async () => {
      const f = await setup(),
        controller = new AbortController(),
        reason = new Error('original native cancel');
      const barrier = await hold(
        (tx) =>
          tx`select pg_advisory_xact_lock(hashtextextended(${`memory-order:${f.scope.organizationId}:${f.scope.ownerId}:${f.scope.instanceId}`},0))`,
      );
      let settled = false;
      const operation = track(
        f.remember(undefined, controller.signal).finally(() => {
          settled = true;
        }),
      );
      await blockedBy(barrier.pid);
      controller.abort(reason);
      await turn();
      expect(settled).toBe(false);
      barrier.release();
      await barrier.done;
      await expect(operation).rejects.toBe(reason);
      expect(await effects(f)).toMatchObject({
        memories: 0,
        revisions: 0,
        audits: 0,
        operations: 0,
      });
    });

    it('suppresses delivery after cancellation DURING actual PG commit, retains the committed receipt and reconciles the original call', async () => {
      const f = await setup(),
        key = `fixture-real-commit:${randomUUID()}`;
      await f.change({ commit_gate: key });
      const barrier = await hold(
        (tx) => tx`select pg_advisory_xact_lock(hashtextextended(${key},0))`,
      );
      const controller = new AbortController(),
        reason = new Error('native cancellation during actual commit');
      let settled = false;
      const operation = track(
        f.remember(undefined, controller.signal).finally(() => {
          settled = true;
        }),
      );
      const pid = await blockedBy(barrier.pid);
      const [query] = await database.db<
        { query: string }[]
      >`select query from pg_stat_activity where pid=${pid}`;
      expect(query!.query).toBe('commit');
      controller.abort(reason);
      await turn();
      expect(settled).toBe(false);
      barrier.release();
      await barrier.done;
      await expect(operation).rejects.toMatchObject({
        name: 'EmployeeMemoryWriteOutcomeUnknown',
        cause: reason,
      });
      const result = await operation.catch((error: unknown) => error);
      expect(result).toBeInstanceOf(EmployeeMemoryWriteOutcomeUnknown);
      expect((result as EmployeeMemoryWriteOutcomeUnknown).cause).toBe(reason);
      expect(await effects(f)).toMatchObject({
        memories: 1,
        revisions: 1,
        audits: 1,
        operations: 1,
      });
      await f.change({ execution_live: false });
      expect(await f.reconcile()).toMatchObject({
        status: 'recorded',
        originalReceiptCurrent: true,
      });
      await expect
        .poll(
          () => database.db`select pid from pg_stat_activity where pid=${pid}`,
        )
        .toEqual([]);
    });

    it('retains a lost real-commit ACK diagnosis without replay and finds the persisted original-call effect', async () => {
      const f = await setup(),
        ackLost = new Error('fixture lost ACK after actual PG commit');
      const createDedicated = client.createDedicatedDatabase;
      // Test-only fault at the transport-result boundary AFTER real PG commit.
      // The real client/transaction/end implementation still runs unchanged.
      vi.spyOn(client, 'createDedicatedDatabase').mockImplementationOnce(
        (db) => {
          const dedicated = createDedicated(db);
          return new Proxy(dedicated, {
            get(target, key, receiver) {
              if (key !== 'reserve') return Reflect.get(target, key, receiver);
              return async () => {
                const session = await dedicated.reserve();
                return new Proxy(session, {
                  apply(targetSession, receiverSession, args) {
                    const query: unknown = Reflect.apply(
                      targetSession,
                      receiverSession,
                      args,
                    );
                    if (
                      Array.isArray(args[0]) &&
                      args[0].join('').trim() === 'commit'
                    )
                      return Promise.resolve(query).then(() => {
                        throw ackLost;
                      });
                    return query;
                  },
                });
              };
            },
          });
        },
      );
      await expect(f.remember()).rejects.toBe(ackLost);
      expect(await effects(f)).toMatchObject({
        memories: 1,
        revisions: 1,
        audits: 1,
        operations: 1,
      });
      const pid = f.pids[0]!;
      await expect
        .poll(
          () => database.db`select pid from pg_stat_activity where pid=${pid}`,
        )
        .toEqual([]);
      await f.change({ execution_live: false });
      expect(await f.reconcile()).toMatchObject({
        status: 'recorded',
        originalReceiptCurrent: true,
      });
      expect((await effects(f))!.memories).toBe(1);
    }, 30000);

    it('keeps module/source revocation blocked by the actual same-session fixture fence until disclosure SQL and commit settle', async () => {
      const f = await setup([{ summary: '同事务资格', details: '完整条件' }]);
      await f.issue();
      const state = (await f.state())!;
      const barrier = await hold(
        (tx) =>
          tx`select id from allrice_employee_memory_contexts where id=${state.id} for update`,
      );
      const reader = track(f.read(1)),
        nativePid = await blockedBy(barrier.pid);
      const revoke = track(f.change({ allowed: false, source_allowed: false }));
      expect(await blockedBy(nativePid)).toBeGreaterThan(0);
      barrier.release();
      await barrier.done;
      expect(await reader).toBe(
        renderMemoryDetailV2(1, { summary: '同事务资格', details: '完整条件' }),
      );
      await revoke;
      expect((await f.state())!.state.toolReads).toBe(1);
      const dedicated = vi.spyOn(client, 'createDedicatedDatabase');
      await expect(f.read(1)).rejects.toThrow('fixture_current_module_denied');
      expect(dedicated).not.toHaveBeenCalled();
    });

    it('holds the separate current HUMAN SOURCE fence after all-pin validation through the actual spend commit', async () => {
      const f = await setup(),
        receipt = await f.remember();
      await f.port.confirm(f.context, await mutation(f, receipt.id), live());
      await f.issue();
      const key = `fixture-context-spend:${randomUUID()}`;
      await f.change({ context_gate: key });
      const barrier = await hold(
        (tx) => tx`select pg_advisory_xact_lock(hashtextextended(${key},0))`,
      );
      const reader = track(f.read(1)),
        nativePid = await blockedBy(barrier.pid);
      const revokeSource = track(f.change({ source_allowed: false }));
      expect(await blockedBy(nativePid)).toBeGreaterThan(0);
      barrier.release();
      await barrier.done;
      expect(await reader).toBe(
        renderMemoryDetailV2(1, {
          summary: '原始候选',
          details: '原始完整说明',
        }),
      );
      await revokeSource;
      const spent = (await f.state())!.state;
      expect(spent.toolReads).toBe(1);
      await expect(f.read(1)).rejects.toThrow(
        'fixture_actual_human_source_denied',
      );
      expect((await f.state())!.state).toEqual(spent);
    });

    it('orders the REAL management withdraw before a waiting native read, preserving budget and refusing every stale pin', async () => {
      const f = await setup([{ summary: '撤回先行', details: '不得再披露' }]);
      await f.issue();
      const before = (await f.state())!,
        id = before.state.pins[0]!.id,
        expected = await mutation(f, id);
      const barrier = await hold(
        (tx) => tx`select id from allrice_memories where id=${id} for update`,
      );
      const withdrawing = track(f.port.withdraw(f.context, expected, live())),
        writerPid = await blockedBy(barrier.pid);
      const reader = track(f.read(1));
      expect(await blockedBy(writerPid)).toBeGreaterThan(0);
      barrier.release();
      await barrier.done;
      await withdrawing;
      await expect(reader).rejects.toMatchObject({
        code: 'MEMORY_CONTEXT_UNAVAILABLE',
      });
      expect((await f.state())!.state).toEqual(before.state);
    });

    it('orders a native read before the REAL management withdraw and charges its committed complete text exactly once', async () => {
      const pair = { summary: '披露先行', details: '当时有权完整条件' },
        f = await setup([pair]);
      await f.issue();
      const before = (await f.state())!,
        id = before.state.pins[0]!.id,
        expected = await mutation(f, id);
      const barrier = await hold(
        (tx) =>
          tx`select id from allrice_employee_memory_contexts where id=${before.id} for update`,
      );
      const reader = track(f.read(1)),
        nativePid = await blockedBy(barrier.pid);
      const withdrawing = track(f.port.withdraw(f.context, expected, live()));
      expect(await blockedBy(nativePid)).toBeGreaterThan(0);
      barrier.release();
      await barrier.done;
      expect(await reader).toBe(renderMemoryDetailV2(1, pair));
      await withdrawing;
      const after = (await f.state())!.state;
      expect(after.toolReads).toBe(1);
      expect(after.spentBytes).toBe(
        before.state.spentBytes +
          Buffer.byteLength(renderMemoryDetailV2(1, pair), 'utf8'),
      );
      await expect(f.read(1)).rejects.toMatchObject({
        code: 'MEMORY_CONTEXT_UNAVAILABLE',
      });
      expect((await f.state())!.state).toEqual(after);
    });
  },
);
