import { createHash, randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type postgres from 'postgres';
import * as client from '../core/client.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { employeeManifest } from '../employees/employee-config.ts';
import {
  reserveDshRuntimeOwner,
  recordDshRuntimeCloseObservation,
  readDshRuntimeCloseCoverage,
  assertDshCloseArtifactCoverage,
  type DshRuntimeOwnedObservation,
  type DshRuntimeCloseObservation,
} from './dsh-runtime-close-observations.ts';
import {
  previewNativeTestChatRetirement,
  applyNativeTestChatRetirement,
  type NativeTestChatRetirementScope,
} from '../conversation/native-context-retirement.ts';
import { nativeRootDigest } from '../conversation/current-execution-binding.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const digest = (value: string) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
const artifact = digest('C2 SQL-only uninstalled artifact');

suite(
  'C2 durable close observations: real PostgreSQL, no Native or model',
  () => {
    let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let port: typeof fixture.db;
    beforeAll(async () => {
      // The original fixture validates the exact approved local/CI URL pair.
      // Its database name is not fixed to the developer's local test database.
      const fixtureUrl = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
      fixture = await createRuntimeFixtureDatabase();
      const [where] =
        await fixture.db`select current_database() db,current_schema() schema`;
      if (!where) throw Error('Private fixture database identity missing');
      expect(where.db).toBe(decodeURIComponent(fixtureUrl.pathname.slice(1)));
      expect(where.schema).toMatch(/^p25_[a-f0-9]{32}$/);
      port = fixture.db;
      vi.spyOn(client, 'getDatabase').mockImplementation(() => port);
    }, 120000);
    beforeEach(() => {
      port = fixture.db;
    });
    afterAll(async () => {
      vi.restoreAllMocks();
      const proof = await fixture?.close();
      if (proof) {
        expect(
          proof.schemaRemoved &&
            proof.storageRemoved &&
            proof.databaseClosed &&
            proof.adminClosed,
        ).toBe(true);
        console.info('c2_sql_cleanup', JSON.stringify(proof));
      }
    }, 30000);

    function owner(): DshRuntimeOwnedObservation {
      return {
        version: 1,
        kind: 'owned',
        runtimeId: randomUUID(),
        workerBootId: randomUUID(),
        workerId: randomUUID(),
        serviceManifestDigest: digest('C2 SQL-only build'),
        artifactId: artifact,
        profileId: 'restricted',
        context: { kind: 'provider', purpose: 'codex_search' },
        observedAt: new Date().toISOString(),
      };
    }
    function observation(
      o: DshRuntimeOwnedObservation,
      kind: 'close_started',
    ): DshRuntimeCloseObservation;
    function observation(
      o: DshRuntimeOwnedObservation,
      kind: 'process_closed',
    ): DshRuntimeCloseObservation;
    function observation(
      o: DshRuntimeOwnedObservation,
      kind: 'close_started' | 'process_closed',
    ): DshRuntimeCloseObservation {
      const base = {
        version: 1 as const,
        runtimeId: o.runtimeId,
        workerBootId: o.workerBootId,
        ownerDigest: nativeRootDigest(o),
        observedAt: new Date().toISOString(),
      };
      return kind === 'close_started'
        ? { ...base, kind }
        : {
            ...base,
            kind,
            fact: {
              source: 'child_close',
              stdioClosed: true,
              exitCode: 1,
              signal: null,
              terminationAttempted: null,
            },
          };
    }
    async function directInsert(
      payload: DshRuntimeOwnedObservation | DshRuntimeCloseObservation,
      ownerDigest: string,
    ) {
      return fixture.db`insert into allrice_dsh_runtime_close_observations
      (runtime_id,worker_boot_id,observation_kind,owner_digest,payload_digest,payload)
      values(${payload.runtimeId},${payload.workerBootId},${payload.kind},${ownerDigest},${nativeRootDigest(payload)},${fixture.db.json(payload as postgres.JSONValue)})`;
    }
    function loseOneReceipt(mode: 'before_commit' | 'after_commit') {
      let used = false;
      return new Proxy(fixture.db, {
        get(target, property, receiver) {
          if (property !== 'begin')
            return Reflect.get(target, property, receiver);
          return async (...args: unknown[]) => {
            if (used || args[0] === 'read only')
              return Reflect.apply(target.begin, target, args);
            used = true;
            if (mode === 'after_commit') {
              await Reflect.apply(target.begin, target, args);
              throw Error(
                'C2 test: real COMMIT completed but caller lost receipt',
              );
            }
            const callback = args.at(-1) as (
              tx: postgres.TransactionSql,
            ) => Promise<unknown>;
            return Reflect.apply(target.begin, target, [
              ...args.slice(0, -1),
              async (tx: postgres.TransactionSql) => {
                await callback(tx);
                throw Error(
                  'C2 test: write completed inside transaction but COMMIT never happened',
                );
              },
            ]);
          };
        },
      });
    }
    async function chat() {
      const o = owner(),
        organizationId = randomUUID(),
        workspaceId = randomUUID(),
        ownerId = randomUUID(),
        employeeId = randomUUID(),
        versionId = randomUUID(),
        assignmentId = randomUUID(),
        contextId = randomUUID();
      await fixture.db`insert into allrice_users(id,email,display_name,password_hash) values(${ownerId},${ownerId + '@example.test'},'C2 private SQL history','not-a-login')`;
      await fixture.db`insert into allrice_organizations(id,slug,name) values(${organizationId},${'c2-' + organizationId},'C2 private SQL history')`;
      await fixture.db`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspaceId},${organizationId},'c2','C2 private SQL history')`;
      await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${organizationId},${workspaceId},${ownerId},'admin')`;
      // Terminal history still requires a real tenant-owned employee version.
      // Keep its native origin NULL instead of fabricating a current executor.
      const manifest = employeeManifest({
        key: 'c2-sql-history',
        name: 'C2 private SQL history',
        description: 'Synthetic SQL-only history; no native process',
        toolNames: [],
      });
      await fixture.db`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name) values(${employeeId},${organizationId},${workspaceId},'c2-sql-history','C2 private SQL history')`;
      await fixture.db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot) values(${versionId},${organizationId},${workspaceId},${employeeId},1,'C2 private SQL history',${manifest.provider.model},${manifest.systemPrompt},${fixture.db.json(manifest.capabilities)},${digest('C2 SQL-only employee definition')},${fixture.db.json(manifest)},${fixture.db.json(manifest.provider)})`;
      await fixture.db`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id) values(${assignmentId},${organizationId},${workspaceId},${employeeId},${versionId},${ownerId})`;
      await fixture.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id) values(${contextId},${organizationId},${workspaceId},${ownerId},'C2 synthetic terminal context',${assignmentId},${versionId})`;
      const scope: NativeTestChatRetirementScope = {
        contextKind: 'chat',
        contextId,
        organizationId,
        workspaceId,
        ownerId,
      };
      o.context = { kind: 'context', ...scope };
      const plan = await previewNativeTestChatRetirement({
        requestId: randomUUID(),
        authorizationEvidenceDigest: digest(
          'C2 explicit disposable test scope',
        ),
        scopes: [scope],
      });
      return { o, scope, plan };
    }
    async function sessionFence(contextId: string) {
      const connection = await fixture.db.reserve();
      await connection`begin`;
      const [backend] = await connection<
        { pid: number }[]
      >`select pg_backend_pid() pid`;
      await connection`select id from allrice_chat_sessions where id=${contextId} for update`;
      let released = false;
      return {
        pid: backend!.pid,
        async release() {
          if (released) return;
          released = true;
          try {
            await connection`commit`;
          } finally {
            connection.release();
          }
        },
      };
    }
    async function blockedCount(pid: number, expected: number) {
      const until = Date.now() + 350;
      while (Date.now() < until) {
        const [row] = await fixture.db<
          { n: number }[]
        >`select count(*)::int n from pg_stat_activity a
        where ${pid}=any(pg_blocking_pids(a.pid)) or exists (
          select 1 from unnest(pg_blocking_pids(a.pid)) as b(pid)
          where ${pid}=any(pg_blocking_pids(b.pid)))`;
        if (row!.n >= expected) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw Error(
        'C2 private SQL row-lock waiter was not observed before production lock deadline',
      );
    }
    const settled = <T>(p: Promise<T>) =>
      p.then(
        (value) => ({ value, error: undefined as Error | undefined }),
        (error: unknown) => ({
          value: undefined,
          error: error instanceof Error ? error : Error(String(error)),
        }),
      );

    it('self-reference admits an owner; close facts require that exact original owner digest and boot', async () => {
      const o = owner(),
        started = observation(o, 'close_started');
      await expect(
        directInsert(started, nativeRootDigest(o)),
      ).rejects.toMatchObject({ code: '23503' });
      await directInsert(o, nativeRootDigest(o));
      await expect(
        directInsert(
          { ...started, ownerDigest: digest('other owner') },
          digest('other owner'),
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        directInsert(
          { ...started, workerBootId: randomUUID() },
          nativeRootDigest(o),
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await directInsert(started, nativeRootDigest(o));
      expect(
        await readDshRuntimeCloseCoverage(fixture.db, {
          workerBootId: o.workerBootId,
        }),
      ).toHaveLength(1);
    });
    it('same-key writes are idempotent, conflicting bytes and all UPDATE/DELETE attempts retain the original row', async () => {
      const o = owner(),
        receipt = await reserveDshRuntimeOwner(o);
      expect(await reserveDshRuntimeOwner(structuredClone(o))).toEqual(receipt);
      const before =
        await fixture.db`select * from allrice_dsh_runtime_close_observations where runtime_id=${o.runtimeId}`;
      await expect(
        reserveDshRuntimeOwner({ ...o, artifactId: digest('changed') }),
      ).rejects.toThrow('DSH_CLOSE_EVIDENCE_CONFLICT');
      await expect(
        fixture.db`update allrice_dsh_runtime_close_observations set payload=payload where runtime_id=${o.runtimeId}`,
      ).rejects.toThrow('DSH_CLOSE_EVIDENCE_IMMUTABLE');
      await expect(
        fixture.db`delete from allrice_dsh_runtime_close_observations where runtime_id=${o.runtimeId}`,
      ).rejects.toThrow('DSH_CLOSE_EVIDENCE_IMMUTABLE');
      expect(
        await fixture.db`select * from allrice_dsh_runtime_close_observations where runtime_id=${o.runtimeId}`,
      ).toEqual(before);
    });
    it('a genuinely committed owner with lost acknowledgement is recovered by exact independent readback', async () => {
      const o = owner();
      port = loseOneReceipt('after_commit');
      const receipt = await reserveDshRuntimeOwner(o);
      expect(receipt.ownerDigest).toBe(nativeRootDigest(o));
      expect(
        await fixture.db`select 1 from allrice_dsh_runtime_close_observations where runtime_id=${o.runtimeId}`,
      ).toHaveLength(1);
    });
    it('a real rolled-back owner cannot acquire a receipt through readback', async () => {
      const o = owner();
      port = loseOneReceipt('before_commit');
      await expect(reserveDshRuntimeOwner(o)).rejects.toThrow(
        'DSH_CLOSE_EVIDENCE_WRITE_UNCONFIRMED',
      );
      expect(
        await fixture.db`select 1 from allrice_dsh_runtime_close_observations where runtime_id=${o.runtimeId}`,
      ).toHaveLength(0);
    });
    it('a genuinely committed close fact survives acknowledgement loss without replacing its first bytes', async () => {
      const o = owner(),
        receipt = await reserveDshRuntimeOwner(o),
        close = observation(o, 'process_closed');
      port = loseOneReceipt('after_commit');
      await recordDshRuntimeCloseObservation(receipt, close);
      const result = await readDshRuntimeCloseCoverage(fixture.db, {
        workerBootId: o.workerBootId,
      });
      expect(result[0]).toMatchObject({
        physical: 'exited',
        publicClose: 'unconfirmed',
      });
      await expect(
        recordDshRuntimeCloseObservation(receipt, {
          ...close,
          observedAt: new Date(Date.now() + 1000).toISOString(),
        }),
      ).rejects.toThrow('DSH_CLOSE_EVIDENCE_CONFLICT');
    });
    it('SQL filtering leaves approved active processes unconfirmed while excluding them from removal coverage', async () => {
      const o = owner();
      await reserveDshRuntimeOwner(o);
      const all = await readDshRuntimeCloseCoverage(fixture.db, {
        workerBootId: o.workerBootId,
      });
      expect(all[0]).toMatchObject({
        physical: 'unknown',
        publicClose: 'unconfirmed',
      });
      const outside = await readDshRuntimeCloseCoverage(fixture.db, {
        outsideApprovedArtifacts: [artifact],
        workerBootId: o.workerBootId,
      });
      expect(outside).toEqual([]);
      expect(
        assertDshCloseArtifactCoverage(outside, [artifact], []),
      ).toMatchObject({
        observedRuntimes: 0,
        uncoveredHistory: 'legacy_unknown_not_backfilled',
      });
    });
    it('a provider physical failure cannot borrow chat retirement authorization', async () => {
      const f = await chat(),
        o = owner(),
        receipt = await reserveDshRuntimeOwner(o);
      await recordDshRuntimeCloseObservation(
        receipt,
        observation(o, 'process_closed'),
      );
      await applyNativeTestChatRetirement(f.plan);
      const coverage = await readDshRuntimeCloseCoverage(fixture.db, {
        workerBootId: o.workerBootId,
      });
      expect(() =>
        assertDshCloseArtifactCoverage(coverage, [digest('new')], [f.scope]),
      ).toThrow('DSH_NATIVE_ARTIFACT_CLOSE_UNCONFIRMED');
    });
    it('an exact disposable chat may retire only after physical exit, retaining failed semantic evidence', async () => {
      const f = await chat(),
        receipt = await reserveDshRuntimeOwner(f.o);
      await expect(applyNativeTestChatRetirement(f.plan)).rejects.toThrow(
        'NATIVE_RETIREMENT_CLOSE_OBSERVATION_UNCONFIRMED',
      );
      await recordDshRuntimeCloseObservation(
        receipt,
        observation(f.o, 'process_closed'),
      );
      await applyNativeTestChatRetirement(f.plan);
      const coverage = await readDshRuntimeCloseCoverage(fixture.db, {
        workerBootId: f.o.workerBootId,
      });
      expect(coverage[0]).toMatchObject({
        physical: 'exited',
        publicClose: 'unconfirmed',
      });
      expect(() =>
        assertDshCloseArtifactCoverage(
          coverage,
          [digest('new')],
          [{ ...f.scope, contextId: randomUUID() }],
        ),
      ).toThrow('DSH_NATIVE_ARTIFACT_CLOSE_UNCONFIRMED');
      expect(() =>
        assertDshCloseArtifactCoverage(coverage, [digest('new')], [f.scope]),
      ).not.toThrow();
    });
    it.each(['owner_first', 'retirement_first'] as const)(
      '%s serializes through the same Session row without retiring an unclosed registered owner',
      async (order) => {
        const f = await chat(),
          fence = await sessionFence(f.scope.contextId);
        let registration: ReturnType<typeof settled> | undefined;
        let retirement: ReturnType<typeof settled> | undefined;
        try {
          if (order === 'owner_first')
            registration = settled(reserveDshRuntimeOwner(f.o));
          else retirement = settled(applyNativeTestChatRetirement(f.plan));
          await blockedCount(fence.pid, 1);
          if (order === 'owner_first')
            retirement = settled(applyNativeTestChatRetirement(f.plan));
          else registration = settled(reserveDshRuntimeOwner(f.o));
          await blockedCount(fence.pid, 2);
        } finally {
          await fence.release();
          const [ownerResult, retirementResult] = await Promise.all([
            registration,
            retirement,
          ]);
          if (ownerResult && retirementResult) {
            if (order === 'owner_first') {
              expect(ownerResult.error).toBeUndefined();
              expect(retirementResult.error?.message).toBe(
                'NATIVE_RETIREMENT_CLOSE_OBSERVATION_UNCONFIRMED',
              );
            } else {
              expect(retirementResult.error).toBeUndefined();
              expect(ownerResult.error?.message).toBe(
                'NATIVE_CONTEXT_EXECUTION_RETIRED',
              );
            }
          }
        }
      },
    );
  },
);
