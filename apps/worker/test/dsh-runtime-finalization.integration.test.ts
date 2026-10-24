import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import * as client from '../../../packages/database/src/core/client.ts';
import { createAssistantFixtureDatabase } from '../../../packages/database/src/assistant-runtime.fixture.ts';
import { assertRuntimeFixtureDatabase } from '../../../packages/database/src/runtime-fixture-database.ts';
import {
  readDshRuntimeCloseCoverage as barrelReadCoverage,
  finalizeWorkerDshRuntimeInventory as barrelFinalizeInventory,
} from '@allrice/database';
import { employeeManifest } from '../../../packages/database/src/employees/employee-config.ts';
import {
  reserveDshRuntimeOwner,
  recordDshRuntimeCloseObservation,
  readDshRuntimeCloseCoverage,
} from '../../../packages/database/src/providers/dsh-runtime-close-observations.ts';
import { finalizeWorkerDshRuntimeInventory } from '../../../packages/database/src/providers/dsh-runtime-registry.ts';
import {
  verifyWorkerDshRuntimeClosure,
  DshWorkerCloseError,
} from '../src/harness/dsh-worker-close.ts';
import type {
  HarnessRuntimeProcessSnapshot,
  HarnessRuntimeClosureSnapshot,
} from '../src/harness/adapter.js';

const digest = (v: string) =>
  'sha256:' + createHash('sha256').update(v).digest('hex');
const artifact = digest(
  'C3 synthetic uninstalled artifact; no process ever started',
);
const manifestDigest = digest('C3 synthetic service only');
const stamp = () => new Date().toISOString();
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'C3 real SQL final registry and same-boot durable closure; all close evidence synthetic',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    const report: Record<string, unknown> = {
      kind: 'c3-actual-sql-boundary',
      database: null,
      nativeProcessStarted: false,
      modelCalls: 0,
      allCloseEvidenceSynthetic: true,
      devTouched: false,
    };
    beforeAll(async () => {
      // The original fixture enforces the exact approved local/CI pair before
      // it creates any schema. Never use DATABASE_URL or an application fallback.
      const fixtureUrl = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
      assertRuntimeFixtureDatabase(fixtureUrl);
      // The verifier and these fixtures must execute the same source functions.
      expect(barrelReadCoverage).toBe(readDshRuntimeCloseCoverage);
      expect(barrelFinalizeInventory).toBe(finalizeWorkerDshRuntimeInventory);
      f = await createAssistantFixtureDatabase({ ownSchemaOnly: true });
      const [where] =
        await f.db`select current_database() db,current_schema() schema`;
      if (!where) throw Error('Private fixture database identity missing');
      expect(where.db).toBe(decodeURIComponent(fixtureUrl.pathname.slice(1)));
      report.database = where.db;
      expect(where.schema).toMatch(/^p25_[a-f0-9]{32}$/);
      report.schema = where.schema;
      // CI db:setup has a fully migrated public schema. A temporary private
      // relation rename must fail, never resolve to public or cache its OID.
      const [scope] =
        await f.db`select current_database() db,current_schemas(false) schemas`;
      expect(scope?.db).toBe(where.db);
      expect(scope?.schemas).toEqual([where.schema]);
      report.querySearchPath = scope?.schemas;
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        Error('No HTTP/provider allowed'),
      );
    }, 120_000);
    afterAll(async () => {
      try {
        if (f) report.cleanup = await f.close();
      } finally {
        report.completedAt = stamp();
        console.info('C3_SQL_FIXTURE_CLEANUP', JSON.stringify(report));
        vi.restoreAllMocks();
      }
    }, 30_000);
    const identity = () => ({
      workerId: randomUUID(),
      workerBootId: randomUUID(),
      serviceManifestDigest: manifestDigest,
    });
    async function context() {
      const organizationId = randomUUID(),
        workspaceId = randomUUID(),
        ownerId = randomUUID(),
        contextId = randomUUID(),
        employeeId = randomUUID(),
        versionId = randomUUID(),
        assignmentId = randomUUID();
      await f.db`insert into allrice_users(id,email,display_name,password_hash) values(${ownerId},${ownerId + '@example.test'},'C3 private SQL','not-a-login')`;
      await f.db`insert into allrice_organizations(id,slug,name) values(${organizationId},${'c3-' + organizationId},'C3 private SQL')`;
      await f.db`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspaceId},${organizationId},'c3','C3 private SQL')`;
      await f.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${organizationId},${workspaceId},${ownerId},'admin')`;
      const m = employeeManifest({
        key: 'c3-history',
        name: 'C3 history',
        description: 'Synthetic records; no native or model',
        toolNames: [],
      });
      await f.db`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name) values(${employeeId},${organizationId},${workspaceId},'c3-history','C3 history')`;
      await f.db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot) values(${versionId},${organizationId},${workspaceId},${employeeId},1,'C3 history',${m.provider.model},${m.systemPrompt},${f.db.json(m.capabilities)},${digest('C3 definition')},${f.db.json(m)},${f.db.json(m.provider)})`;
      await f.db`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id) values(${assignmentId},${organizationId},${workspaceId},${employeeId},${versionId},${ownerId})`;
      await f.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id) values(${contextId},${organizationId},${workspaceId},${ownerId},'C3 synthetic original history',${assignmentId},${versionId})`;
      return {
        kind: 'context' as const,
        contextKind: 'chat' as const,
        contextId,
        organizationId,
        workspaceId,
        ownerId,
      };
    }
    async function runtime(
      i = identity(),
      options: {
        legacy?: boolean;
        registeredContext?: Awaited<ReturnType<typeof context>>;
      } = {},
    ) {
      const c = await context(),
        id = randomUUID(),
        time = stamp();
      const owner = {
        version: 1 as const,
        kind: 'owned' as const,
        ...i,
        runtimeId: id,
        artifactId: artifact,
        profileId: 'restricted' as const,
        context: c,
        observedAt: time,
      };
      const receipt = options.legacy
        ? null
        : await reserveDshRuntimeOwner(owner);
      const scope = options.registeredContext ?? c;
      const live = {
        id,
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        sessionId: scope.contextId,
        ownerId: scope.ownerId,
        threadId: 'c3-' + id,
        providerRoute: 'openai-codex',
        model: 'SQL-only',
        reasoningEffort: 'low',
        profileFingerprint: 'a'.repeat(64),
        nativeTools: [],
        startedAt: time,
        lastActivityAt: time,
      };
      await f.db`insert into allrice_dsh_runtime_instances(id,worker_id,organization_id,workspace_id,session_id,owner_id,thread_id,provider_route,model,reasoning_effort,profile_fingerprint,native_tools,status,started_at,last_activity_at,last_seen_at) values(${id},${i.workerId},${live.organizationId},${live.workspaceId},${live.sessionId},${live.ownerId},${live.threadId},${live.providerRoute},${live.model},${live.reasoningEffort},${live.profileFingerprint},'[]','live',${time},${time},${options.legacy ? '2026-01-01T00:00:00Z' : time})`;
      return { owner, receipt, live };
    }
    async function close(
      x: Awaited<ReturnType<typeof runtime>>,
      mode: 'normal' | 'nonzero' | 'noack' = 'normal',
    ) {
      const base = {
        version: 1 as const,
        runtimeId: x.owner.runtimeId,
        workerBootId: x.owner.workerBootId,
        ownerDigest: x.receipt!.ownerDigest,
        observedAt: stamp(),
      };
      await recordDshRuntimeCloseObservation(x.receipt!, {
        ...base,
        kind: 'close_started',
      });
      if (mode !== 'noack')
        await recordDshRuntimeCloseObservation(x.receipt!, {
          ...base,
          kind: 'close_request',
          acknowledged: true,
          wrapper: {
            version: 1,
            sdkShutdown: true,
            rootDisposed: true,
            priorFramesFlushed: true,
          },
        });
      await recordDshRuntimeCloseObservation(x.receipt!, {
        ...base,
        kind: 'process_closed',
        fact: {
          source: 'child_close',
          stdioClosed: true,
          exitCode: mode === 'nonzero' ? 2 : 0,
          signal: null,
          terminationAttempted: null,
        },
      });
    }
    const closure = (
      x: Awaited<ReturnType<typeof runtime>>,
      state: 'exited' | 'running' | 'unknown' = 'exited',
    ) => ({
      id: x.owner.runtimeId,
      threadId: x.live.threadId,
      nativeArtifactId: artifact,
      state: 'unconfirmed' as const,
      processState: state,
      stdioClosed: state === 'exited',
      exitCode: state === 'exited' ? 0 : null,
      signal: null,
      shutdownAcknowledged: false,
      wrapperCleanupConfirmed: false,
      terminationAttempted: null,
    });
    const row = async (id: string) =>
      (
        await f.db`select * from allrice_dsh_runtime_instances where id=${id}`
      )[0];
    const evidence = async () =>
      await f.db`select * from allrice_dsh_runtime_close_observations order by runtime_id,worker_boot_id,observation_kind`;
    const verify = (
      i: ReturnType<typeof identity>,
      live: readonly HarnessRuntimeProcessSnapshot[] = [],
      closed: readonly HarnessRuntimeClosureSnapshot[] = [],
    ) =>
      verifyWorkerDshRuntimeClosure({
        ...i,
        runtimeInventory: () => live,
        closureInventory: () => closed,
      });
    it('uses the same source functions and own-only connection for a confirmed current-boot close', async () => {
      const i = identity(),
        x = await runtime(i);
      await close(x);
      const before = await evidence();
      await expect(verify(i)).resolves.toMatchObject({
        workerId: i.workerId,
        workerBootId: i.workerBootId,
        observedRuntimes: 1,
        physicalExited: [x.owner.runtimeId],
        liveOrUnknown: [],
        unconfirmed: [],
        readbackConfirmed: true,
        physicalRegistryUpdated: true,
      });
      expect(await row(x.owner.runtimeId)).toMatchObject({
        worker_id: i.workerId,
        status: 'offline',
      });
      expect(await evidence()).toEqual(before);
    });
    it('only current-boot witnessed exits become offline; other boot/worker/tenant and legacy unknown remain byte-identical', async () => {
      const i = identity(),
        a = await runtime(i);
      await close(a);
      const old = await runtime({ ...i, workerBootId: randomUUID() });
      await close(old);
      const foreign = await runtime(),
        unknown = await runtime(i),
        legacy = await runtime(i, { legacy: true });
      const untouched = [old, foreign, unknown, legacy];
      const before = await Promise.all(
        untouched.map((x) => row(x.owner.runtimeId)),
      );
      const observations = await evidence();
      await expect(verify(i)).rejects.toMatchObject({
        summary: {
          physicalExited: [a.owner.runtimeId],
          liveOrUnknown: [unknown.owner.runtimeId],
          unconfirmed: [unknown.owner.runtimeId],
        },
      });
      expect((await row(a.owner.runtimeId))?.status).toBe('offline');
      expect(
        await Promise.all(untouched.map((x) => row(x.owner.runtimeId))),
      ).toEqual(before);
      expect(await evidence()).toEqual(observations);
    });
    it.each(['nonzero', 'noack'] as const)(
      'physically exited %s remains semantically unconfirmed and append-only evidence stays unchanged',
      async (mode) => {
        const i = identity(),
          x = await runtime(i);
        await close(x, mode);
        const before = await evidence();
        const err = await verify(i).catch((e) => e);
        expect(err).toBeInstanceOf(DshWorkerCloseError);
        expect(err.summary).toMatchObject({
          physicalExited: [x.owner.runtimeId],
          liveOrUnknown: [],
          unconfirmed: [x.owner.runtimeId],
        });
        expect((await row(x.owner.runtimeId))?.status).toBe('offline');
        expect(await evidence()).toEqual(before);
        const c = await readDshRuntimeCloseCoverage(undefined, {
          workerBootId: i.workerBootId,
        });
        expect(c[0]).toMatchObject({
          physical: 'exited',
          publicClose: 'unconfirmed',
        });
      },
    );
    it('running inventory contradicts durable exit without deleting observations or making the row offline', async () => {
      const i = identity(),
        x = await runtime(i);
      await close(x);
      const before = await evidence();
      await expect(
        verify(i, [x.live], [closure(x, 'running')]),
      ).rejects.toMatchObject({
        summary: { physicalExited: [], liveOrUnknown: [x.owner.runtimeId] },
      });
      expect((await row(x.owner.runtimeId))?.status).toBe('live');
      expect(await evidence()).toEqual(before);
    });
    it('a stale closure from another boot cannot offline that old row', async () => {
      const i = identity(),
        old = await runtime({ ...i, workerBootId: randomUUID() });
      await close(old);
      const before = await row(old.owner.runtimeId);
      await expect(verify(i, [], [closure(old)])).rejects.toBeInstanceOf(
        DshWorkerCloseError,
      );
      expect(await row(old.owner.runtimeId)).toEqual(before);
    });
    it('wrong artifact in a closure observation is contradictory and cannot offline the row', async () => {
      const i = identity(),
        x = await runtime(i);
      await close(x);
      const before = await row(x.owner.runtimeId),
        c = { ...closure(x), nativeArtifactId: digest('contradiction') };
      await expect(verify(i, [], [c])).rejects.toBeInstanceOf(
        DshWorkerCloseError,
      );
      expect(await row(x.owner.runtimeId)).toEqual(before);
    });
    it('durable owner scope cannot offline a registry row belonging to another tenant', async () => {
      const i = identity(),
        other = await context(),
        x = await runtime(i, { registeredContext: other });
      await close(x);
      const before = await row(x.owner.runtimeId);
      await expect(verify(i)).rejects.toBeInstanceOf(DshWorkerCloseError);
      expect(await row(x.owner.runtimeId)).toEqual(before);
    });
    it('actual PostgreSQL observation read failure leaves all registry rows unchanged', async () => {
      const i = identity(),
        x = await runtime(i);
      await close(x);
      const other = await runtime(i, { legacy: true });
      const before = await Promise.all(
        [x, other].map((x) => row(x.owner.runtimeId)),
      );
      // Real relation absence in this disposable schema, not a mocked SQL result.
      await f.db`alter table allrice_dsh_runtime_close_observations rename to c3_read_failure_hold`;
      try {
        const failure = await verify(i, [], [closure(x)]).catch((e) => e);
        expect(failure).toBeInstanceOf(DshWorkerCloseError);
        expect(failure.summary).toMatchObject({
          physicalExited: [x.owner.runtimeId],
          physicalRegistryUpdated: false,
          readbackConfirmed: false,
          liveOrUnknown: [],
        });
        await expect(
          finalizeWorkerDshRuntimeInventory({
            ...i,
            runtimes: [],
            exitedRuntimeIds: [x.owner.runtimeId],
          }),
        ).rejects.toThrow();
        expect(
          await Promise.all([x, other].map((x) => row(x.owner.runtimeId))),
        ).toEqual(before);
      } finally {
        await f.db`alter table c3_read_failure_hold rename to allrice_dsh_runtime_close_observations`;
      }
    });
    it('finalizer refuses an explicitly supplied other-boot exit and rolls back without partial offlining', async () => {
      const i = identity(),
        own = await runtime(i),
        old = await runtime({ ...i, workerBootId: randomUUID() });
      await close(own);
      await close(old);
      const before = await Promise.all(
        [own, old].map((x) => row(x.owner.runtimeId)),
      );
      await expect(
        finalizeWorkerDshRuntimeInventory({
          ...i,
          runtimes: [],
          exitedRuntimeIds: [own.owner.runtimeId, old.owner.runtimeId],
        }),
      ).rejects.toThrow();
      expect(
        await Promise.all([own, old].map((x) => row(x.owner.runtimeId))),
      ).toEqual(before);
    });
    it('a live snapshot cannot take over another worker thread or tenant through final upsert', async () => {
      const i = identity(),
        foreign = await runtime(),
        x = await runtime(i);
      // Model the legitimate interval before this runtime's first heartbeat.
      await f.db`delete from allrice_dsh_runtime_instances where id=${x.owner.runtimeId}`;
      const before = await row(foreign.owner.runtimeId);
      const bad = { ...x.live, threadId: foreign.live.threadId };
      await expect(verify(i, [bad], [])).rejects.toBeInstanceOf(
        DshWorkerCloseError,
      );
      expect(await row(foreign.owner.runtimeId)).toEqual(before);
      expect(await row(x.owner.runtimeId)).toBeUndefined();
    });
    it('keeps a witnessed live current owner live even before its first heartbeat, without rewriting unknown history', async () => {
      const i = identity(),
        x = await runtime(i),
        old = await runtime(i, { legacy: true });
      await f.db`delete from allrice_dsh_runtime_instances where id=${x.owner.runtimeId}`;
      const before = await row(old.owner.runtimeId);
      const error = await verify(i, [x.live], [closure(x, 'running')]).catch(
        (e) => e,
      );
      expect(error).toBeInstanceOf(DshWorkerCloseError);
      expect(error.summary).toMatchObject({
        physicalExited: [],
        liveOrUnknown: [x.owner.runtimeId],
        physicalRegistryUpdated: true,
      });
      expect(await row(x.owner.runtimeId)).toMatchObject({
        id: x.owner.runtimeId,
        worker_id: i.workerId,
        organization_id: x.live.organizationId,
        workspace_id: x.live.workspaceId,
        session_id: x.live.sessionId,
        owner_id: x.live.ownerId,
        status: 'live',
        ended_at: null,
      });
      expect(await row(old.owner.runtimeId)).toEqual(before);
    });
    it('the actual append-only SQL constraint retains the original observation on update, delete, and contradictory replay', async () => {
      const i = identity(),
        x = await runtime(i);
      await close(x, 'noack');
      const before = await evidence();
      await expect(
        f.db`update allrice_dsh_runtime_close_observations set payload=payload where runtime_id=${x.owner.runtimeId}`,
      ).rejects.toThrow('DSH_CLOSE_EVIDENCE_IMMUTABLE');
      await expect(
        f.db`delete from allrice_dsh_runtime_close_observations where runtime_id=${x.owner.runtimeId}`,
      ).rejects.toThrow('DSH_CLOSE_EVIDENCE_IMMUTABLE');
      await expect(
        recordDshRuntimeCloseObservation(x.receipt!, {
          version: 1,
          kind: 'process_closed',
          runtimeId: x.owner.runtimeId,
          workerBootId: i.workerBootId,
          ownerDigest: x.receipt!.ownerDigest,
          observedAt: stamp(),
          fact: {
            source: 'child_close',
            stdioClosed: true,
            exitCode: 9,
            signal: null,
            terminationAttempted: null,
          },
        }),
      ).rejects.toThrow('DSH_CLOSE_EVIDENCE_CONFLICT');
      expect(await evidence()).toEqual(before);
      const c = await readDshRuntimeCloseCoverage(undefined, {
        workerBootId: i.workerBootId,
      });
      expect(c[0]).toMatchObject({
        physical: 'exited',
        publicClose: 'unconfirmed',
      });
    });
  },
);
