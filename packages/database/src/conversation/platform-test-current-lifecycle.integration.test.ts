const oldGeneration = 'dsh-0.1.5-rc.3-a4c74a9' as const;
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from '../core/client.ts';
import { createAssistantFixtureDatabase } from '../assistant-runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import {
  queuePlatformEmployeeTestRun,
  claimNextPlatformEmployeeTestRun,
  completePlatformEmployeeTestRun,
} from '../employees/platform-employees.ts';
import {
  prepareJobNativeSession,
  bindJobNativeSession,
} from '../execution/queue.ts';
import { nativeBindingDescriptor } from '../native-session-binding.fixture.ts';
import { newNativeGeneration } from './current-execution-binding.ts';
import { newEmployeeNativeRootOrigin } from './native-root-origin.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'current platform test first INSERT, real claim and leased binding',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    const approved = 'sha256:' + 'a'.repeat(64);
    // MET-221: the release primary is the only birth input; the retired
    // new-root ID is neither read nor required.
    const restoreApproval = () => {
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', approved);
    };
    beforeAll(async () => {
      f = await createAssistantFixtureDatabase();
      const [where] =
        await f.db`select current_database() db,current_schema() schema`;
      expect(where!.db).toBe(
        new URL(process.env.ALLRICE_TEST_DATABASE_URL!).pathname.slice(1),
      );
      expect(where!.schema).toMatch(/^p25_[a-f0-9]{32}$/);
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        Error('No provider/network in SQL fixture'),
      );
      restoreApproval();
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      console.log(
        JSON.stringify({
          kind: 'b2a-current-lifecycle-fixture-cleanup',
          proof: await f?.close(),
        }),
      );
    }, 30000);
    async function queue() {
      const employee = await createEmployeeAdministrationFixture(f.db);
      restoreApproval();
      const q = await queuePlatformEmployeeTestRun(employee.employeeId, {
        environment: 'company',
        workspaceId: employee.workspaceId,
        ownerId: employee.ownerId,
        prompt: 'Synthetic SQL-only task',
      });
      expect(q.queued).toBe(true);
      const id = q.testRun!.id;
      const [row] =
        await f.db`select * from allrice_platform_employee_test_runs where id=${id}`;
      return { employee, id, row: row! };
    }
    async function claim(q: Awaited<ReturnType<typeof queue>>) {
      const workerId = randomUUID(),
        claimed = await claimNextPlatformEmployeeTestRun(workerId);
      expect(claimed?.id).toBe(q.id);
      if (!claimed) throw Error('fixture claim');
      const descriptor = nativeBindingDescriptor({
        organizationId: q.employee.organizationId,
        workspaceId: q.employee.workspaceId,
        ownerId: q.employee.ownerId,
        contextKey: q.id,
        distributionGeneration: newNativeGeneration,
      });
      const lease = {
        workerId,
        jobId: claimed.previewExecution.jobId,
        leaseToken: claimed.previewExecution.leaseToken,
        attempt: claimed.previewExecution.jobAttempt,
        subject: { kind: 'platform_employee_test' as const, id: q.id },
      };
      return {
        claimed,
        descriptor,
        lease,
        preparation: {
          ...lease,
          nativeSessionId: descriptor.nativeSessionId,
          storageContextKey: q.id,
        },
      };
    }
    async function finish(id: string) {
      await completePlatformEmployeeTestRun(id, {
        answer: null,
        provider: null,
        model: null,
        threadId: null,
        usage: null,
        events: [],
        error: {
          code: 'SYNTHETIC_NO_MODEL_DONE',
          message: 'SQL-only fixture completed',
        },
      });
    }
    async function runCount(id: string) {
      return (
        await f.db`select count(*)::integer n from allrice_runs where execution_spec->>'platformEmployeeTestRunId'=${id}`
      )[0]!.n;
    }
    it('freezes original source plus current executor at queue time without fabricating a Run or lease', async () => {
      const q = await queue();
      expect(q.row.native_root_origin).toMatchObject({
        schemaVersion: 2,
        contextKind: 'platform_employee_test',
        contextId: q.id,
        artifactId: approved,
      });
      expect(q.row.native_execution_binding).toMatchObject({
        scope: { testId: q.id, ownerId: q.employee.ownerId },
        source: {
          platformRevisionId: q.row.revision_id,
          packageChecksum: q.row.frozen_package_checksum,
        },
        execution: { artifactId: approved },
      });
      expect(await runCount(q.id)).toBe(0);
      const c = await claim(q);
      expect(await runCount(q.id)).toBe(1);
      expect(c.claimed.previewExecution.jobId).toMatch(/^[a-f0-9-]{36}$/);
      await finish(q.id);
    });
    it('missing current approval rejects first INSERT without a test, Run or Job', async () => {
      const e = await createEmployeeAdministrationFixture(f.db);
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', undefined);
      await expect(
        queuePlatformEmployeeTestRun(e.employeeId, {
          environment: 'company',
          workspaceId: e.workspaceId,
          ownerId: e.ownerId,
          prompt: 'No approval',
        }),
      ).rejects.toThrow();
      expect(
        await f.db`select id from allrice_platform_employee_test_runs where employee_id=${e.employeeId}`,
      ).toHaveLength(0);
      expect(
        await f.db`select id from allrice_runs where organization_id=${e.organizationId}`,
      ).toHaveLength(0);
      expect(
        await f.db`select id from allrice_jobs where organization_id=${e.organizationId}`,
      ).toHaveLength(0);
      restoreApproval();
    });
    it('claim and cold preparation retain the stored executor across later deployment changes, with exact live lease checks', async () => {
      const q = await queue(),
        original = q.row.native_execution_binding;
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'b'.repeat(64));
      const c = await claim(q);
      const prepared = await prepareJobNativeSession(c.preparation);
      expect(prepared.executionBinding).toEqual({
        kind: 'current_platform_test_run_execution',
        test: original,
        runId: c.claimed.previewExecution.runId,
        jobId: c.lease.jobId,
        attempt: c.lease.attempt,
      });
      expect(prepared.binding).toBeNull();
      await expect(
        prepareJobNativeSession({ ...c.preparation, leaseToken: randomUUID() }),
      ).rejects.toThrow();
      await expect(
        prepareJobNativeSession({ ...c.preparation, workerId: randomUUID() }),
      ).rejects.toThrow();
      const bound = await bindJobNativeSession({
        ...c.lease,
        descriptor: c.descriptor,
      });
      expect(bound.binding.artifactId).toBe(approved);
      const cold = await prepareJobNativeSession(c.preparation);
      expect(cold.executionBinding).toEqual(prepared.executionBinding);
      expect(cold.requiresRecovery).toBe(true);
      expect(cold.binding?.nativeSessionId).toBe(c.descriptor.nativeSessionId);
      // MET-221: a later same-generation primary continues the pin, which keeps
      // its first writer's artifact as provenance; another generation cannot.
      const continued = await bindJobNativeSession({
        ...c.lease,
        descriptor: {
          ...c.descriptor,
          artifactId: 'sha256:' + 'b'.repeat(64),
          artifactManifestDigest: 'sha256:' + 'b'.repeat(64),
        },
      });
      expect(continued.binding).toEqual(bound.binding);
      await expect(
        bindJobNativeSession({
          ...c.lease,
          descriptor: {
            ...c.descriptor,
            distributionGeneration:
              oldGeneration as typeof c.descriptor.distributionGeneration,
          },
        }),
      ).rejects.toThrow();
      await finish(q.id);
      restoreApproval();
    });
    it('membership revoked after queue stops claim before creating any Run', async () => {
      const q = await queue();
      await f.db`update allrice_memberships set active=false where user_id=${q.employee.ownerId}`;
      expect(await claimNextPlatformEmployeeTestRun(randomUUID())).toBeNull();
      const [row] =
        await f.db`select status,output from allrice_platform_employee_test_runs where id=${q.id}`;
      expect(row!.status).toBe('failed');
      expect(row!.output.error.code).toBe('TEST_ENVIRONMENT_UNAVAILABLE');
      expect(await runCount(q.id)).toBe(0);
    });
    it('membership revoked after claim blocks both prepare and final bind', async () => {
      const q = await queue(),
        c = await claim(q);
      await f.db`update allrice_memberships set active=false where user_id=${q.employee.ownerId}`;
      await expect(prepareJobNativeSession(c.preparation)).rejects.toThrow();
      await expect(
        bindJobNativeSession({ ...c.lease, descriptor: c.descriptor }),
      ).rejects.toThrow();
      expect(
        await f.db`select 1 from allrice_native_session_bindings where context_id=${q.id}`,
      ).toHaveLength(0);
      await finish(q.id);
    });
    it('a malformed queued input is finalized once without creating a Run or poisoning the queue', async () => {
      const q = await queue(),
        db = f.db;
      // Replace only this owned, unclaimed fixture INSERT. The actual migration
      // trigger stays enabled; no production immutability guard is bypassed.
      await db`delete from allrice_platform_employee_test_runs where id=${q.id} and status='queued'`;
      const malformed = { ...q.row.input };
      delete malformed.prompt;
      await db`insert into allrice_platform_employee_test_runs(id,employee_id,revision_id,requested_by_label,status,input,purpose,frozen_runtime_profile,frozen_definition,frozen_native_skills,frozen_package_checksum,native_root_origin,native_execution_binding)
      values(${q.id},${q.row.employee_id},${q.row.revision_id},${q.row.requested_by_label},'queued',${db.json(malformed)},${q.row.purpose},${db.json(q.row.frozen_runtime_profile)},${db.json(q.row.frozen_definition)},${db.json(q.row.frozen_native_skills)},${q.row.frozen_package_checksum},${db.json(q.row.native_root_origin)},${db.json(q.row.native_execution_binding)})`;
      expect(await claimNextPlatformEmployeeTestRun(randomUUID())).toBeNull();
      const [row] =
        await db`select status,output from allrice_platform_employee_test_runs where id=${q.id}`;
      expect(row!.status).toBe('failed');
      expect(row!.output.error.code).toBe('TEST_SNAPSHOT_INVALID');
      expect(await runCount(q.id)).toBe(0);
      expect(
        await db`select id from allrice_jobs where organization_id=${q.employee.organizationId}`,
      ).toHaveLength(0);
      expect(await claimNextPlatformEmployeeTestRun(randomUUID())).toBeNull();
    });
    async function replaceOwnedQueued(
      q: Awaited<ReturnType<typeof queue>>,
      origin: unknown,
      binding: unknown,
    ) {
      const db = f.db;
      await db`delete from allrice_platform_employee_test_runs where id=${q.id} and status='queued'`;
      await db`insert into allrice_platform_employee_test_runs(id,employee_id,revision_id,requested_by_label,status,input,purpose,frozen_runtime_profile,frozen_definition,frozen_native_skills,frozen_package_checksum,native_root_origin,native_execution_binding)
      values(${q.id},${q.row.employee_id},${q.row.revision_id},${q.row.requested_by_label},'queued',${db.json(q.row.input)},${q.row.purpose},${db.json(q.row.frozen_runtime_profile)},${db.json(q.row.frozen_definition)},${db.json(q.row.frozen_native_skills)},${q.row.frozen_package_checksum},${origin == null ? null : db.json(origin as never)},${binding == null ? null : db.json(binding as never)})`;
    }
    it('historical V1 claim and preparation preserve the original target without synthesizing a V2 binding', async () => {
      const q = await queue();
      const origin = newEmployeeNativeRootOrigin(
        'platform_employee_test',
        q.id,
        q.row.frozen_runtime_profile.runtimePackage,
      );
      expect(origin?.schemaVersion).toBe(1);
      await replaceOwnedQueued(q, origin, null);
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'b'.repeat(64));
      const c = await claim(q),
        prepared = await prepareJobNativeSession(c.preparation);
      expect(prepared.executionBinding).toBeNull();
      expect(prepared.origin).toEqual(origin);
      const bound = await bindJobNativeSession({
        ...c.lease,
        descriptor: c.descriptor,
      });
      expect(bound.binding.artifactId).toBe(approved);
      const [after] =
        await f.db`select native_root_origin,native_execution_binding,frozen_runtime_profile from allrice_platform_employee_test_runs where id=${q.id}`;
      expect(after!.native_root_origin).toEqual(origin);
      expect(after!.native_execution_binding).toBeNull();
      expect(after!.frozen_runtime_profile).toEqual(
        q.row.frozen_runtime_profile,
      );
      await finish(q.id);
      restoreApproval();
    });
    it.each(['digest', 'frozenSnapshotDigest'] as const)(
      'a corrupt %s first INSERT is failed before Run/Job creation and kept unchanged',
      async (field) => {
        const q = await queue(),
          altered = structuredClone(q.row.native_execution_binding);
        altered[field] = 'sha256:' + '0'.repeat(64);
        await replaceOwnedQueued(q, q.row.native_root_origin, altered);
        expect(await claimNextPlatformEmployeeTestRun(randomUUID())).toBeNull();
        const [after] =
          await f.db`select status,output,native_root_origin,native_execution_binding from allrice_platform_employee_test_runs where id=${q.id}`;
        expect(after!.status).toBe('failed');
        expect(after!.output.error.code).toBe('TEST_EXECUTION_BINDING_INVALID');
        expect(after!.native_execution_binding).toEqual(altered);
        expect(after!.native_root_origin).toEqual(q.row.native_root_origin);
        expect(await runCount(q.id)).toBe(0);
        expect(
          await f.db`select id from allrice_jobs where organization_id=${q.employee.organizationId}`,
        ).toHaveLength(0);
        expect(await claimNextPlatformEmployeeTestRun(randomUUID())).toBeNull();
      },
    );
  },
);
