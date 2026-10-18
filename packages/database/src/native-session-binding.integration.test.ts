import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from './assistant-authority.fixture.ts';
import { createEmployeeAdministrationFixture } from './employee-administration.fixture.ts';
import { ensureBootstrapPortalPrincipal } from './identity.ts';
import {
  bindJobNativeSession,
  prepareJobNativeSession,
} from './execution/queue.ts';
import { acquireConversationRuntime } from './conversation/conversation-runtime.ts';
import type { NativeSessionLeaseInput } from './conversation/native-session-binding.ts';
import { nativeBindingDescriptor } from './native-session-binding.fixture.ts';
import {
  queuePlatformEmployeeTestRun,
  claimNextPlatformEmployeeTestRun,
  completePlatformEmployeeTestRun,
} from './employees/platform-employees.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET192 immutable native reader binding: real Job leases, CAS and finalizers',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      // A test-only advisory barrier at the real INSERT, after Job/conversation
      // locks and the initial deadline check. No replacement product algorithm.
      await fixture.db
        .unsafe(`create function native_binding_test_gate() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(hashtextextended(new.native_session_id,9187)); return new; end $$;
      create trigger native_binding_test_gate before insert on allrice_native_session_bindings
        for each row execute function native_binding_test_gate()`);
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    });
    async function chat() {
      const f = await createAssistantAuthorityFixture(fixture.db, {
        configure: false,
      });
      await fixture.db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
      const [r] =
        await fixture.db`select * from allrice_conversation_runtimes where session_id=${f.session}`;
      const input: NativeSessionLeaseInput = {
        workerId: f.worker.workerId,
        jobId: f.worker.jobId,
        leaseToken: f.worker.leaseToken,
        attempt: 1,
        subject: {
          kind: 'chat',
          id: f.session,
          configChecksum: r!.config_checksum,
          generation: r!.thread_generation,
          expectedThreadId: r!.thread_id,
        },
        descriptor: nativeBindingDescriptor({
          organizationId: f.org,
          workspaceId: f.workspace,
          ownerId: f.user,
          contextKey: f.session,
        }),
      };
      return { ...f, input };
    }
    async function heldGate(id: string) {
      const connection = await fixture.db.reserve();
      const [r] =
        await connection`select pg_backend_pid() pid,pg_advisory_lock(hashtextextended(${id},9187))`;
      let released = false;
      return {
        pid: r!.pid as number,
        release: async () => {
          if (released) return;
          released = true;
          await connection`select pg_advisory_unlock(hashtextextended(${id},9187))`;
          connection.release();
        },
      };
    }
    it('prepares only an existing pin under the real lease and leaves provisional absence unbound', async () => {
      const f = await chat();
      const request = {
        workerId: f.input.workerId,
        jobId: f.input.jobId,
        leaseToken: f.input.leaseToken,
        attempt: f.input.attempt,
        subject: f.input.subject,
        nativeSessionId: f.input.descriptor.nativeSessionId,
        storageContextKey: f.input.descriptor.storageContextKey,
      };
      expect(await prepareJobNativeSession(request)).toMatchObject({
        binding: null,
        requiresRecovery: false,
      });
      expect(
        await fixture.db`select native_session_id from allrice_native_session_bindings where native_session_id=${request.nativeSessionId}`,
      ).toHaveLength(0);
      const bound = await bindJobNativeSession(f.input);
      const prepared = await prepareJobNativeSession(request);
      expect(prepared).toEqual({ ...bound, requiresRecovery: true });
      await fixture.db`update allrice_jobs set cancel_requested_at=clock_timestamp(),cancel_reason='user_request' where id=${f.input.jobId}`;
      await expect(prepareJobNativeSession(request)).rejects.toMatchObject({
        code: 'NATIVE_SESSION_ADMISSION_DENIED',
      });
      expect(
        (
          await fixture.db`select first_job_id from allrice_native_session_bindings where native_session_id=${request.nativeSessionId}`
        )[0]!.first_job_id,
      ).toBe(f.input.jobId);
    });
    it('requires recovery for an unpinned durable thread and retry without manufacturing a new binding', async () => {
      const f = await chat();
      const request = {
        workerId: f.input.workerId,
        jobId: f.input.jobId,
        leaseToken: f.input.leaseToken,
        attempt: f.input.attempt,
        subject: f.input.subject,
        nativeSessionId: f.input.descriptor.nativeSessionId,
        storageContextKey: f.input.descriptor.storageContextKey,
      };
      await fixture.db`update allrice_conversation_runtimes set thread_id=${request.nativeSessionId} where session_id=${f.session}`;
      expect(await prepareJobNativeSession(request)).toMatchObject({
        binding: null,
        requiresRecovery: true,
      });
      await fixture.db`update allrice_conversation_runtimes set thread_id=null where session_id=${f.session}`;
      await fixture.db`update allrice_jobs set attempt=2 where id=${f.worker.jobId}`;
      expect(
        await prepareJobNativeSession({ ...request, attempt: 2 }),
      ).toMatchObject({ binding: null, requiresRecovery: true });
      expect(
        await fixture.db`select native_session_id from allrice_native_session_bindings where native_session_id=${request.nativeSessionId}`,
      ).toHaveLength(0);
    });
    it('does not return another owner or subject pin to a valid but unrelated Job', async () => {
      const first = await chat(),
        other = await chat();
      await bindJobNativeSession(first.input);
      await expect(
        prepareJobNativeSession({
          workerId: other.input.workerId,
          jobId: other.input.jobId,
          leaseToken: other.input.leaseToken,
          attempt: other.input.attempt,
          subject: other.input.subject,
          nativeSessionId: first.input.descriptor.nativeSessionId,
          storageContextKey: first.input.descriptor.storageContextKey,
        }),
      ).rejects.toMatchObject({ code: 'NATIVE_SESSION_ADMISSION_DENIED' });
    });
    async function blockedBy(pid: number) {
      const end = Date.now() + 4000;
      while (Date.now() < end) {
        const [v] =
          await fixture.db`select pid from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid)) limit 1`;
        if (v) return v.pid as number;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error('Expected real PostgreSQL lock wait did not occur');
    }
    async function preview() {
      const account = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'allrice-platform',
        organizationName: 'Internal',
        workspaceSlug: 'control-plane',
        workspaceName: 'Control',
        email: 'native-binding-admin@example.test',
        displayName: 'Admin',
        role: 'member',
      });
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', account.user.email);
      const employee = await createEmployeeAdministrationFixture(fixture.db);
      const queued = await queuePlatformEmployeeTestRun(
        employee.employeeId,
        { prompt: 'Synthetic native binding only' },
        account.user.id,
      );
      expect(queued.queued).toBe(true);
      const workerId = randomUUID(),
        test = (await claimNextPlatformEmployeeTestRun(workerId))!;
      expect(test.id).toBe(queued.testRun!.id);
      const input: NativeSessionLeaseInput = {
        workerId,
        jobId: test.previewExecution.jobId,
        leaseToken: test.previewExecution.leaseToken,
        attempt: test.previewExecution.jobAttempt,
        subject: { kind: 'platform_employee_test', id: test.id },
        descriptor: nativeBindingDescriptor(test.previewContext),
      };
      return { test, input };
    }
    const finish = (id: string) =>
      completePlatformEmployeeTestRun(id, {
        answer: 'Synthetic',
        provider: 'openai-codex',
        model: 'synthetic',
        threadId: null,
        usage: null,
        events: [],
        error: null,
      });

    it('commits concurrent first binding once; same-ID admission preserves turn, usage and first source', async () => {
      const f = await chat();
      const [a, b] = await Promise.all([
        bindJobNativeSession(f.input),
        bindJobNativeSession(f.input),
      ]);
      expect(a.binding).toEqual(b.binding);
      expect(a.conversation?.generation).toBe(
        f.input.subject.kind === 'chat' ? f.input.subject.generation + 1 : 0,
      );
      await fixture.db`update allrice_conversation_runtimes set active_turn_id='turn-kept',last_input_tokens=123 where session_id=${f.session}`;
      const c = await bindJobNativeSession(f.input);
      expect(c.binding).toEqual(a.binding);
      expect(c.conversation).toMatchObject({
        activeTurnId: 'turn-kept',
        lastInputTokens: 123,
        generation: a.conversation!.generation,
      });
      expect(
        await fixture.db`select native_session_id from allrice_native_session_bindings where native_session_id=${a.binding.nativeSessionId}`,
      ).toHaveLength(1);
      await expect(
        fixture.db`update allrice_native_session_bindings set first_attempt=9 where native_session_id=${a.binding.nativeSessionId}`,
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('keeps the first source when a later real leased Run adopts the same chat root', async () => {
      const f = await chat(),
        first = await bindJobNativeSession(f.input);
      const runId = randomUUID(),
        jobId = randomUUID(),
        workerId = randomUUID(),
        leaseToken = randomUUID(),
        um = randomUUID(),
        am = randomUUID();
      await fixture.db.begin(async (tx) => {
        // Arrange a later running turn in this isolated fixture. Queue transition
        // correctness is covered by the unchanged queue regressions separately.
        await tx`update allrice_runs set state='succeeded' where id=${f.rootRunId}`;
        await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
        values(${runId},${f.org},${f.workspace},${f.user},'running','{}','{}')`;
        await tx`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,attempt,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at)
        values(${jobId},${f.org},${f.workspace},${f.user},${runId},'running',${randomUUID()},1,clock_timestamp()+interval '10 minutes',
          '{"schemaVersion":1,"type":"allrice.employee.run","input":{}}',${workerId},${leaseToken},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '10 minutes')`;
        await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
        values(${um},${f.org},${f.workspace},${f.session},${f.user},'user','{}'),(${am},${f.org},${f.workspace},${f.session},${f.user},'assistant','{}')`;
        await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,native_skills,execution_snapshot)
        select ${runId},organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,${um},${am},provider_snapshot,prompt_snapshot,native_skills,execution_snapshot
        from allrice_employee_runs where run_id=${f.rootRunId}`;
      });
      const current = await acquireConversationRuntime({
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        sessionId: f.session,
        runId,
        workerId,
        configChecksum: first.conversation!.configChecksum,
        compactThresholdTokens: 4096,
      });
      const later = await bindJobNativeSession({
        workerId,
        jobId,
        leaseToken,
        attempt: 1,
        descriptor: f.input.descriptor,
        subject: {
          kind: 'chat',
          id: f.session,
          configChecksum: current.configChecksum,
          generation: current.generation,
          expectedThreadId: current.threadId,
        },
      });
      expect(later.binding).toEqual(first.binding);
      expect(later.conversation!.generation).toBe(
        first.conversation!.generation,
      );
      await expect(bindJobNativeSession(f.input)).rejects.toBeDefined();
    });

    it('rolls back pointer changes on an immutable artifact conflict, including after configuration cleared the thread', async () => {
      const f = await chat(),
        first = await bindJobNativeSession(f.input);
      await fixture.db`update allrice_conversation_runtimes set thread_id=null,thread_generation=thread_generation+1 where session_id=${f.session}`;
      const [before] =
        await fixture.db`select * from allrice_conversation_runtimes where session_id=${f.session}`;
      const changed = {
        ...f.input,
        subject: {
          ...f.input.subject,
          generation: before!.thread_generation,
          expectedThreadId: null,
        },
        descriptor: {
          ...f.input.descriptor,
          artifactId: 'sha256:' + 'b'.repeat(64),
          artifactManifestDigest: 'sha256:' + 'b'.repeat(64),
        },
      };
      await expect(bindJobNativeSession(changed)).rejects.toMatchObject({
        code: 'NATIVE_SESSION_BINDING_CONFLICT',
      });
      expect(
        (
          await fixture.db`select * from allrice_conversation_runtimes where session_id=${f.session}`
        )[0],
      ).toEqual(before);
      expect(
        (
          await bindJobNativeSession({
            ...changed,
            descriptor: f.input.descriptor,
          })
        ).binding,
      ).toEqual(first.binding);
    });

    it.each([
      'token',
      'worker',
      'attempt',
      'cancel',
      'drain',
      'lease',
      'timeout',
      'root_cancel',
      'archived',
      'membership',
    ] as const)(
      'denies %s without a pin or a conversation mutation',
      async (mode) => {
        const f = await chat();
        const input = { ...f.input };
        if (mode === 'token') input.leaseToken = randomUUID();
        if (mode === 'worker') input.workerId = randomUUID();
        if (mode === 'attempt') input.attempt++;
        if (mode === 'cancel')
          await fixture.db`update allrice_jobs set cancel_requested_at=clock_timestamp(),cancel_reason='user_request' where id=${input.jobId}`;
        if (mode === 'drain')
          await fixture.db`update allrice_jobs set drain_reason='cancel',drain_deadline_at=clock_timestamp()+interval '30 seconds' where id=${input.jobId}`;
        if (mode === 'lease')
          await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${input.jobId}`;
        if (mode === 'timeout')
          await fixture.db`update allrice_jobs set created_at=clock_timestamp()-interval '2 minutes',timeout_at=clock_timestamp()-interval '1 second' where id=${input.jobId}`;
        if (mode === 'root_cancel')
          await fixture.db`update allrice_runtime_roots set cancel_requested_at=clock_timestamp(),cancel_request_id=${randomUUID()},cancel_reason='user_request' where root_run_id=${f.rootRunId}`;
        if (mode === 'archived')
          await fixture.db`update allrice_organizations set archived_at=clock_timestamp() where id=${f.org}`;
        if (mode === 'membership')
          await fixture.db`update allrice_memberships set active=false where id=${f.membership}`;
        const [before] =
          await fixture.db`select * from allrice_conversation_runtimes where session_id=${f.session}`;
        await expect(bindJobNativeSession(input)).rejects.toBeDefined();
        expect(
          await fixture.db`select native_session_id from allrice_native_session_bindings where native_session_id=${input.descriptor.nativeSessionId}`,
        ).toHaveLength(0);
        expect(
          (
            await fixture.db`select * from allrice_conversation_runtimes where session_id=${f.session}`
          )[0],
        ).toEqual(before);
      },
    );

    it('checks the database clock after a real binding INSERT wait and rolls back its pointer', async () => {
      const f = await chat(),
        gate = await heldGate(f.input.descriptor.nativeSessionId);
      await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '1200 milliseconds' where id=${f.input.jobId}`;
      const operation = bindJobNativeSession(f.input).then(
        (v) => ({ value: v }),
        (error) => ({ error }),
      );
      try {
        await blockedBy(gate.pid);
        for (let i = 0; i < 150; i++) {
          const [r] =
            await fixture.db`select lease_expires_at<clock_timestamp() expired from allrice_jobs where id=${f.input.jobId}`;
          if (r!.expired) break;
          if (i === 149)
            throw Error('database clock did not reach arranged lease deadline');
          await new Promise((r) => setTimeout(r, 20));
        }
      } finally {
        await gate.release();
      }
      expect(await operation).toHaveProperty('error');
      expect(
        await fixture.db`select native_session_id from allrice_native_session_bindings where native_session_id=${f.input.descriptor.nativeSessionId}`,
      ).toHaveLength(0);
      expect(
        (
          await fixture.db`select thread_id from allrice_conversation_runtimes where session_id=${f.session}`
        )[0]!.thread_id,
      ).toBeNull();
    }, 15000);

    it('rechecks expiry after an actual unique-index conflict wait, preserving the existing identity fact', async () => {
      const f = await chat(),
        d = f.input.descriptor;
      await fixture.db.unsafe(
        'alter table allrice_native_session_bindings disable trigger native_binding_test_gate',
      );
      const connection = await fixture.db.reserve();
      const [pid] = await connection`select pg_backend_pid() pid`;
      let operation: Promise<unknown> | undefined;
      try {
        await connection.unsafe('begin');
        // An uncommitted isolated pin supplies the real PostgreSQL unique-index
        // barrier. It is fixture arrangement, not a claimed production binding.
        await connection`insert into allrice_native_session_bindings(native_session_id,organization_id,workspace_id,owner_id,context_kind,context_id,
        storage_context_key,storage_namespace,artifact_id,artifact_manifest_digest,distribution_generation,profile_id,first_run_id,first_job_id,first_attempt,binding_basis)
        values(${d.nativeSessionId},${f.org},${f.workspace},${f.user},'chat',${f.session},${d.storageContextKey},${d.storageNamespace},
          ${d.artifactId},${d.artifactManifestDigest},${d.distributionGeneration},${d.profileId},${f.rootRunId},${f.worker.jobId},1,'approved_compatibility_reader')`;
        await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '1200 milliseconds' where id=${f.input.jobId}`;
        operation = bindJobNativeSession(f.input).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        const binderPid = await blockedBy(pid!.pid);
        const [waiting] =
          await fixture.db`select wait_event from pg_stat_activity where pid=${binderPid}`;
        expect(waiting!.wait_event).toBe('transactionid');
        for (let n = 0; n < 150; n++) {
          const [r] =
            await fixture.db`select lease_expires_at<clock_timestamp() expired from allrice_jobs where id=${f.input.jobId}`;
          if (r!.expired) break;
          if (n === 149) throw Error('database expiry not observed');
          await new Promise((r) => setTimeout(r, 20));
        }
      } finally {
        await connection.unsafe('commit');
        connection.release();
        await fixture.db.unsafe(
          'alter table allrice_native_session_bindings enable trigger native_binding_test_gate',
        );
      }
      expect(await operation).toHaveProperty('error');
      expect(
        (
          await fixture.db`select thread_id from allrice_conversation_runtimes where session_id=${f.session}`
        )[0]!.thread_id,
      ).toBeNull();
      expect(
        (
          await fixture.db`select first_job_id from allrice_native_session_bindings where native_session_id=${d.nativeSessionId}`
        )[0]!.first_job_id,
      ).toBe(f.worker.jobId);
    }, 15000);

    it('does not use a committed pin as permission after cancellation or soft archive', async () => {
      const f = await chat(),
        first = await bindJobNativeSession(f.input);
      await fixture.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${f.session}`;
      await expect(bindJobNativeSession(f.input)).rejects.toMatchObject({
        code: 'NATIVE_SESSION_ADMISSION_DENIED',
      });
      expect(
        (
          await fixture.db`select first_job_id from allrice_native_session_bindings where native_session_id=${first.binding.nativeSessionId}`
        )[0]!.first_job_id,
      ).toBe(f.input.jobId);
      const g = await chat();
      await bindJobNativeSession(g.input);
      await fixture.db`update allrice_jobs set cancel_requested_at=clock_timestamp(),cancel_reason='user_request' where id=${g.input.jobId}`;
      await expect(bindJobNativeSession(g.input)).rejects.toMatchObject({
        code: 'NATIVE_SESSION_ADMISSION_DENIED',
      });
    });

    it('binds a real ordinary preview without chat rows and rejects a swapped test/Run/revision identity', async () => {
      const before = await fixture.db`select id from allrice_chat_sessions`;
      const { test, input } = await preview();
      const first = await bindJobNativeSession(input);
      expect(first.binding.contextKind).toBe('platform_employee_test');
      expect(first.conversation).toBeUndefined();
      expect(await fixture.db`select id from allrice_chat_sessions`).toEqual(
        before,
      );
      await expect(
        bindJobNativeSession({
          ...input,
          subject: { kind: 'platform_employee_test', id: randomUUID() },
        }),
      ).rejects.toBeDefined();
      const [r] =
        await fixture.db`select execution_spec from allrice_runs where id=${test.previewExecution.runId}`;
      await fixture.db`update allrice_runs set execution_spec=execution_spec||${fixture.db.json({ employeeRevisionId: randomUUID() })} where id=${test.previewExecution.runId}`;
      await expect(bindJobNativeSession(input)).rejects.toMatchObject({
        code: 'NATIVE_SESSION_ADMISSION_DENIED',
      });
      await fixture.db`update allrice_runs set execution_spec=${fixture.db.json(r!.execution_spec)} where id=${test.previewExecution.runId}`;
      await finish(test.id);
      await expect(bindJobNativeSession(input)).rejects.toBeDefined();
    });

    it('finishes the actual preview finalizer waiting behind binding, then denies post-initialize readmission', async () => {
      const { test, input } = await preview(),
        gate = await heldGate(input.descriptor.nativeSessionId);
      const binding = bindJobNativeSession(input).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let ending: Promise<unknown> | undefined;
      try {
        const binderPid = await blockedBy(gate.pid);
        ending = finish(test.id);
        await blockedBy(binderPid);
      } finally {
        await gate.release();
      }
      const bound = await binding;
      expect(bound).toHaveProperty('value');
      await ending;
      await expect(bindJobNativeSession(input)).rejects.toBeDefined();
      expect(
        (
          await fixture.db`select first_job_id from allrice_native_session_bindings where native_session_id=${input.descriptor.nativeSessionId}`
        )[0]!.first_job_id,
      ).toBe(input.jobId);
    }, 15000);

    it('keeps the immutable source after ordinary preview Run/Job/test cleanup, without short-lived FKs', async () => {
      const { test, input } = await preview();
      const first = await bindJobNativeSession(input);
      await finish(test.id);
      await fixture.db`delete from allrice_run_events where run_id=${test.previewExecution.runId}`;
      await fixture.db`delete from allrice_jobs where id=${input.jobId}`;
      await fixture.db`delete from allrice_runs where id=${test.previewExecution.runId}`;
      await fixture.db`delete from allrice_platform_employee_test_runs where id=${test.id}`;
      const [row] =
        await fixture.db`select first_run_id,first_job_id,first_attempt from allrice_native_session_bindings where native_session_id=${first.binding.nativeSessionId}`;
      expect(row).toEqual({
        first_run_id: first.binding.firstRunId,
        first_job_id: first.binding.firstJobId,
        first_attempt: first.binding.firstAttempt,
      });
      const fks =
        await fixture.db`select confrelid::regclass::text target from pg_constraint
      where conrelid='allrice_native_session_bindings'::regclass and contype='f'`;
      expect(fks.every((r) => !/(?:runs|jobs|test_runs)$/.test(r.target))).toBe(
        true,
      );
      await expect(bindJobNativeSession(input)).rejects.toBeDefined();
    });
  },
);
