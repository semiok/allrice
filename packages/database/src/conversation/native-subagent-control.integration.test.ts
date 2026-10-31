import { createHash, randomUUID } from 'node:crypto';
import { LocalStorageAdapter } from '@allrice/storage';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TransactionSql } from 'postgres';
import {
  ExecutionContextSchema,
  NativeSubagentControlResultSchema,
  cloudPlatform,
  cloudToolchainImageV1,
  type EmployeeRuntimePackage,
  type NativeSubagentControlInput,
  type NativeSubagentControlWire,
} from '@allrice/contracts';
import * as client from '../core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../runtime.fixture.ts';
import { publishWorkbenchArtifact } from '../artifact-review.ts';
import {
  createCloudCommandOperation,
  createCloudOperationLedger,
} from '../cloud-execution.ts';
import { createRunAuthorityFixture } from '../run-authority.fixture.ts';
import { assertNativeRunAuthority } from '../run-delivery-authority.ts';
import {
  decideRuntimeActionApproval,
  getRuntimeActionApproval,
} from '../runtime-policy.ts';
import { updateWorkAutomation } from '../work-automation.ts';
import { resolveTaskRuntimePolicy } from '../task-runtime-policy.ts';
import { nativeBindingDescriptor } from '../native-session-binding.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import { buildEmployeeRuntimePackage } from '../platform-employees/runtime-package.ts';
import { authenticateSession, createSession } from '../identity.ts';
import { bindJobNativeSession } from '../execution/queue.ts';
import { linkFileToSession, sendChatMessage } from '../workspace/service.ts';
import { createStorageMetadata, markStorageReady } from '../data.ts';
import { pollNativeSubagentControl } from '../../../../apps/worker/src/conversation/native-subagent-control.ts';
import type { HarnessAdapter } from '../../../../apps/worker/src/harness/adapter.ts';
import { newNativeGeneration } from './native-root-origin.ts';
import { readSessionNativeSubagentTarget } from './native-subagent-query.ts';
import { releaseConversationRuntime } from './conversation-runtime.ts';
import {
  claimConversationSteer,
  consumeConversationSteer,
  deferConversationSteer,
  rejectConversationSteer,
} from './conversation-input.ts';
import {
  enqueueNativeSubagentControl,
  authorizeNativeSubagentControlImages,
  claimNativeSubagentControl,
  getNativeSubagentControl,
  recordNativeSubagentControlResult,
} from './native-subagent-control.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET-230 C1 durable child-control ledger (no native dispatch)', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let runtimePackage: EmployeeRuntimePackage;
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'c'.repeat(64));
    fixture = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    const employee = await createEmployeeAdministrationFixture(fixture.db);
    runtimePackage = buildEmployeeRuntimePackage({
      revision: 1,
      definition: {
        ...employee.definition,
        capabilities: {
          ...employee.definition.capabilities,
          nativeSkillIds: [],
          toolNames: [
            ...employee.definition.capabilities.toolNames,
            'workspace.export.create',
            'cloud.process.execute',
          ],
        },
      },
      skills: [],
    });
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  });
  async function chat(nativeRootSuffix?: string) {
    const f = await createRunAuthorityFixture(fixture.db, {
      configure: false,
      memberRole: 'member',
      runtimePackage,
      allowedTools: runtimePackage.runtimeManifest.toolNames,
      runtimePolicy: {
        harness: 'dsh',
        provider: runtimePackage.runtimeManifest.provider,
        model: runtimePackage.runtimeManifest.model,
        reasoningEffort: 'xhigh',
        timeoutMs: 300000,
        fallbackModels: [],
        credentialReference: 'deployment:synthetic-never-resolved',
        baseUrl: null,
      },
      businessCreationOrigin: true,
    });
    expect(f.manifest.securityPolicy.deniedCapabilities).toEqual(
      runtimePackage.runtimeManifest.deniedCapabilities,
    );
    await fixture.db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
    const [runtime] =
      await fixture.db`select * from allrice_conversation_runtimes where session_id=${f.session}`;
    const descriptor = nativeBindingDescriptor({
      organizationId: f.org,
      workspaceId: f.workspace,
      ownerId: f.user,
      contextKey: f.session,
      distributionGeneration: newNativeGeneration,
    });
    if (nativeRootSuffix) descriptor.nativeSessionId += '-' + nativeRootSuffix;
    const bound = await bindJobNativeSession({
      workerId: f.worker.workerId,
      jobId: f.worker.jobId,
      leaseToken: f.worker.leaseToken,
      attempt: 1,
      subject: {
        kind: 'chat',
        id: f.session,
        configChecksum: runtime!.config_checksum,
        generation: runtime!.thread_generation,
        expectedThreadId: runtime!.thread_id,
      },
      descriptor,
    });
    if (!bound.conversation) throw Error('fixture chat binding missing');
    // First binding advances generation. Exercise the same returned identity
    // that the real Worker carries forward, not the pre-bind fixture value.
    expect(bound.conversation).toMatchObject({
      state: 'running',
      activeRunId: f.rootRunId,
      workerId: f.worker.workerId,
      threadId: descriptor.nativeSessionId,
      generation: runtime!.thread_generation + 1,
    });
    const worker = {
      ...f.worker,
      generation: bound.conversation.generation,
      attempt: 1,
    };
    const login = await createSession(f.user);
    const context = await authenticateSession(login.token, {
      organizationId: f.org,
      workspaceId: f.workspace,
    });
    if (!context) throw Error('fixture authentication failed');
    const authority = { ...f.base, worker };
    // Validate the complete immutable package/manifest, policy and lease gates
    // before individual scenarios change authority or exercise the ledger.
    expect(await assertNativeRunAuthority(authority)).toMatchObject({
      ownerId: f.user,
      nativeSessionId: descriptor.nativeSessionId,
    });
    const pin = await readSessionNativeSubagentTarget(fixture.db, {
      organizationId: f.org,
      workspaceId: f.workspace,
      ownerId: f.user,
      sessionId: f.session,
    });
    expect(pin.descriptor).toEqual(descriptor);
    return {
      ...f,
      worker,
      context,
      descriptor,
      authority,
      pin,
    };
  }
  type Chat = Awaited<ReturnType<typeof chat>>;
  const prompt = (f: Chat): NativeSubagentControlInput => ({
    kind: 'prompt',
    requestId: randomUUID(),
    parentSessionId: f.descriptor.nativeSessionId,
    childSessionId: `synthetic-child-${randomUUID()}`,
    mode: 'continuable',
    delivery: 'queue',
    content: [{ type: 'text', text: 'Use corrected numbers.' }],
    clientTimeZone: 'Asia/Shanghai',
  });
  const expected = (f: Chat, input: NativeSubagentControlInput) => ({
    rootRunId: f.rootRunId,
    generation: f.worker.generation,
    input,
  });
  const enqueue = (f: Chat, input: NativeSubagentControlInput) =>
    enqueueNativeSubagentControl(f.context, f.session, expected(f, input));
  const read = (f: Chat, id: string) =>
    getNativeSubagentControl(f.context, f.session, id);
  async function cloud(f: Chat) {
    const db = fixture.db,
      target = randomUUID();
    await db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities)
      values(${target},${f.org},${f.workspace},'control-lock-test','cloud_sandbox','Synthetic cloud','online','["process.execute"]')`;
    await db`insert into allrice_cloud_execution_grants(id,organization_id,workspace_id,owner_id,target_id,version,profile,enabled)
      values(${randomUUID()},${f.org},${f.workspace},${f.user},${target},1,${db.json(
        {
          backend: 'cloud-gvisor-v1',
          imageDigest: cloudToolchainImageV1,
          architecture: cloudPlatform.architecture,
          runtime: 'runsc',
          runtimeVersion: 'release-20260831.0',
          runtimeChecksum: cloudPlatform.runtimeChecksum,
          network: 'none',
          maximumConcurrency: 2,
        },
      )},true)`;
    await f.setControls({
      version: 1,
      enabled: true,
      mode: 'execute',
      rules: [{ action: 'cloud.process.execute', effect: 'allow' }],
    });
    const [policy] =
      await db`select payload,issued_at,expires_at from allrice_policy_snapshots where id=${f.policy}`;
    const context = ExecutionContextSchema.parse({
      executionId: randomUUID(),
      runId: f.rootRunId,
      jobId: f.worker.jobId,
      worker: { type: 'worker', id: f.worker.workerId },
      delegatedBy: { type: 'user', id: f.user },
      organizationId: f.org,
      workspaceId: f.workspace,
      policySnapshot: {
        id: f.policy,
        organizationId: f.org,
        subjectId: f.user,
        version: 1,
        issuedAt: policy!.issued_at.toISOString(),
        expiresAt: policy!.expires_at.toISOString(),
        ...policy!.payload,
      },
      startedAt: new Date().toISOString(),
    });
    const create = (database = db) =>
      createCloudCommandOperation(
        {
          context,
          callId: randomUUID(),
          arguments: {
            script: "console.log('cloud work continues')",
            inputs: [],
            outputs: [],
          },
        },
        database,
      );
    const created = await create();
    expect(created.snapshot.status).toBe('ready');
    const scope = created.snapshot.binding.task.scope;
    const operationId = created.snapshot.binding.attempt.operationId;
    const dispatch = (ledger = created.ledger) =>
      ledger.dispatch({
        scope,
        operationId,
        leaseOwner: f.worker.workerId,
        leaseMs: 60000,
      });
    const lease = await dispatch();
    const identity = { scope, operationId, leaseToken: lease.leaseToken };
    const start = (ledger = created.ledger) =>
      ledger.startOperation({
        ...identity,
        attempt: lease.snapshot.binding.attempt,
        receiptId: randomUUID(),
      });
    return { create, created, dispatch, start, identity };
  }

  // Pause a real cloud admission after its policy UPDATE lock. Before the fix,
  // control holds Job UPDATE while waiting on this policy; resuming cloud then
  // reaches the production inputs JOIN jobs FOR SHARE and produces SQLSTATE 40P01.
  async function alongsideCloud<T>(
    f: Chat,
    operation: (db: typeof fixture.db) => Promise<unknown>,
    control: () => Promise<T>,
    pausePolicyTransaction = 1,
  ) {
    let release!: () => void,
      ready!: () => void,
      pid = 0;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let policyTransactions = 0;
    const database = new Proxy(fixture.db, {
      get(target, key) {
        if (key !== 'begin') return Reflect.get(target, key, target);
        return (body: (tx: TransactionSql) => Promise<unknown>) =>
          target.begin(async (tx) => {
            await tx`set local statement_timeout='8s'`;
            pid = (await tx`select pg_backend_pid() pid`)[0]!.pid;
            let paused = false;
            return body(
              new Proxy(tx, {
                apply(query, receiver, args) {
                  const pending = Reflect.apply(query, receiver, args);
                  const sql = Array.isArray(args[0]) ? args[0].join(' ') : '';
                  if (
                    !paused &&
                    sql.includes('from allrice_runtime_policy_controls')
                  ) {
                    paused = true;
                    // Ledger create and approval creation are distinct real
                    // transactions; count each only once, even with rechecks.
                    if (++policyTransactions !== pausePolicyTransaction)
                      return pending;
                    return (async () => {
                      const rows = await pending;
                      ready();
                      await resume;
                      return rows;
                    })();
                  }
                  return pending;
                },
              }),
            );
          });
      },
    });
    const admission = operation(database);
    void admission.catch(() => {});
    let pending: Promise<T> | undefined;
    try {
      await Promise.race([
        held,
        admission.then(() => {
          throw Error('cloud missed policy barrier');
        }),
      ]);
      pending = control();
      void pending.catch(() => {});
      await expect
        .poll(
          async () => {
            const rows = await fixture.db`select pid from pg_stat_activity
          where datname=current_database() and ${pid}=any(pg_blocking_pids(pid)) and wait_event_type='Lock'`;
            return rows.length;
          },
          { timeout: 2000, interval: 10 },
        )
        .toBe(1);
    } finally {
      release();
      await Promise.allSettled([admission, pending]);
    }
    // Await original promises so neither PostgreSQL errors nor safety refusals
    // can be swallowed by the cleanup above.
    await admission;
    const result = await pending!;
    expect(
      (
        await fixture.db`select state from allrice_runs where id=${f.rootRunId}`
      )[0],
    ).toEqual({ state: 'running' });
    expect(
      (
        await fixture.db`select cancel_request_id from allrice_runtime_roots where root_run_id=${f.rootRunId}`
      )[0],
    ).toEqual({ cancel_request_id: null });
    expect(
      (
        await fixture.db`select status,cancel_requested_at from allrice_jobs where id=${f.worker.jobId}`
      )[0],
    ).toEqual({ status: 'running', cancel_requested_at: null });
    return result;
  }

  it.each([
    'create',
    'dispatch',
    'start',
    'heartbeat',
    'heartbeat with clock',
  ] as const)(
    '“只停止甲，乙继续云计算”：Stop claim and cloud %s both complete',
    async (phase) => {
      const f = await chat(),
        c = await cloud(f);
      const input: NativeSubagentControlInput = {
        kind: 'interrupt',
        requestId: randomUUID(),
        parentSessionId: f.descriptor.nativeSessionId,
        childSessionId: 'synthetic-child-a',
        mode: 'continuable',
      };
      await enqueue(f, input);
      if (phase === 'heartbeat with clock')
        await fixture.db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy)
          values(${f.rootRunId},${f.org},${f.workspace},${fixture.db.json({ ...resolveTaskRuntimePolicy([]) })})`;
      if (phase.startsWith('heartbeat')) await c.start();
      const result = await alongsideCloud(
        f,
        async (db) => {
          if (phase === 'create') return c.create(db);
          const ledger = createCloudOperationLedger(c.created.principal, db);
          if (phase === 'dispatch') {
            const second = await c.create();
            return ledger.dispatch({
              scope: c.identity.scope,
              operationId: second.snapshot.binding.attempt.operationId,
              leaseOwner: f.worker.workerId,
              leaseMs: 60000,
            });
          }
          if (phase === 'start') return c.start(ledger);
          return ledger.heartbeat({ ...c.identity, leaseMs: 60000 });
        },
        () => claimNativeSubagentControl(f.authority),
      );
      expect(result?.input).toEqual(input);
      expect(
        (
          await fixture.db`select state,delivery_attempts from allrice_conversation_commands where id=${input.requestId}`
        )[0],
      ).toEqual({ state: 'claimed', delivery_attempts: 1 });
    },
    15000,
  );

  it.each(['request', 'approved decision'] as const)(
    'cloud approval %s and Stop claim both complete without canceling the root',
    async (phase) => {
      const f = await chat(),
        c = await cloud(f);
      // A rule alone is insufficient: the normal member preference can allow
      // cloud work. Use the public setting to create a real confirmation flow.
      await updateWorkAutomation(
        f.context,
        f.workspace,
        { expectedRevision: 0, capability: 'cloud', enabled: false },
        fixture.db,
      );
      await f.setControls({
        version: 1,
        enabled: true,
        mode: 'execute',
        rules: [{ action: 'cloud.process.execute', effect: 'ask' }],
      });
      const input: NativeSubagentControlInput = {
        kind: 'interrupt',
        requestId: randomUUID(),
        parentSessionId: f.descriptor.nativeSessionId,
        childSessionId: 'synthetic-child-awaiting-cloud-approval',
        mode: 'continuable',
      };
      await enqueue(f, input);
      const approvalFor = async (
        waiting: Awaited<ReturnType<typeof c.create>>,
      ) => {
        expect(waiting.snapshot.status).toBe('waiting_user');
        const [row] = await fixture.db`select id from allrice_approval_requests
          where resource_id=${waiting.snapshot.binding.attempt.operationId} and resource_type='runtime_operation'`;
        return getRuntimeActionApproval(f.context, row!.id, fixture.db);
      };
      const registered =
        phase === 'approved decision'
          ? await approvalFor(await c.create())
          : null;
      let approvalId: string | undefined;
      const result = await alongsideCloud(
        f,
        async (db) => {
          if (!registered) {
            const { request } = await approvalFor(await c.create(db));
            approvalId = request.approvalId;
            return;
          }
          const { request } = registered;
          approvalId = request.approvalId;
          await decideRuntimeActionApproval(
            f.context,
            request.approvalId,
            {
              contractVersion: 1,
              direction: 'response',
              kind: 'action_approval',
              requestId: request.requestId,
              version: request.version,
              requestDigest: request.requestDigest,
              task: request.task,
              responseId: randomUUID(),
              respondedBy: f.user,
              respondedAt: new Date().toISOString(),
              approvalId: request.approvalId,
              decision: 'approved',
            },
            db,
          );
        },
        () => claimNativeSubagentControl(f.authority),
        // A new cloud create commits ledger admission before requesting
        // approval. Only pause that second policy transaction in this case.
        phase === 'request' ? 2 : 1,
      );
      expect(result?.input).toEqual(input);
      expect(
        (
          await fixture.db`select state,delivery_attempts from allrice_conversation_commands where id=${input.requestId}`
        )[0],
      ).toEqual({ state: 'claimed', delivery_attempts: 1 });
      expect(
        (
          await fixture.db`select status,runtime_consumed_at from allrice_approval_requests where id=${approvalId!}`
        )[0],
      ).toEqual({
        status: registered ? 'approved' : 'pending',
        runtime_consumed_at: null,
      });
    },
    15000,
  );

  it.each(['submit', 'empty poll'] as const)(
    '“甲按修正数值继续，乙继续云计算”：%s and cloud heartbeat both complete',
    async (operation) => {
      const f = await chat(),
        c = await cloud(f),
        input = prompt(f);
      await c.start();
      const result = await alongsideCloud<
        | Awaited<ReturnType<typeof enqueue>>
        | Awaited<ReturnType<typeof claimNativeSubagentControl>>
      >(
        f,
        (db) =>
          createCloudOperationLedger(c.created.principal, db).heartbeat({
            ...c.identity,
            leaseMs: 60000,
          }),
        () =>
          operation === 'submit'
            ? enqueue(f, input)
            : claimNativeSubagentControl(f.authority),
      );
      if (operation === 'empty poll') expect(result).toBeNull();
      else {
        expect(result).toMatchObject({
          requestId: input.requestId,
          result: { status: 'recorded' },
        });
        expect((await claimNativeSubagentControl(f.authority))?.input).toEqual(
          input,
        );
      }
    },
    15000,
  );

  it.each(['policy', 'membership', 'lease', 'tenant'] as const)(
    'control and cloud admission preserve the %s refusal after a root-lock wait',
    async (revoked) => {
      const f = await chat(),
        c = await cloud(f),
        input = prompt(f);
      await c.start();
      await enqueue(f, input);
      const [before] =
        await fixture.db`select lease_expires_at from allrice_runtime_operations where id=${c.identity.operationId}`;
      const scope =
        revoked === 'tenant'
          ? { ...f.authority.scope, organizationId: randomUUID() }
          : f.authority.scope;
      let pending: ReturnType<typeof claimNativeSubagentControl> | undefined;
      try {
        await fixture.db.begin(async (tx) => {
          const [holder] =
            await tx`select pg_backend_pid() pid,root_run_id from allrice_runtime_roots
            where root_run_id=${f.rootRunId} for update`;
          pending = claimNativeSubagentControl({ ...f.authority, scope });
          void pending.catch(() => {});
          // Cross-tenant scope must fail without discovering or waiting on this root.
          if (revoked === 'tenant') return;
          await expect
            .poll(
              async () => {
                const rows = await fixture.db`select pid from pg_stat_activity
              where datname=current_database() and ${holder!.pid}=any(pg_blocking_pids(pid))`;
                return rows.length;
              },
              { timeout: 2000, interval: 10 },
            )
            .toBe(1);
          if (revoked === 'policy')
            await tx`update allrice_runtime_policy_controls set version=2,controls=${tx.json(
              {
                version: 2,
                enabled: false,
                mode: 'execute',
                rules: [],
              },
            )} where organization_id=${f.org} and workspace_id=${f.workspace}`;
          if (revoked === 'membership')
            await tx`update allrice_memberships set active=false where id=${f.membership}`;
          if (revoked === 'lease')
            await tx`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
        });
      } finally {
        await Promise.allSettled([pending]);
      }
      await expect(pending).rejects.toThrow();
      const ledger = createCloudOperationLedger(
        { ...c.created.principal, organizationId: scope.organizationId },
        fixture.db,
      );
      await expect(
        ledger.heartbeat({ ...c.identity, leaseMs: 60000 }),
      ).rejects.toThrow();
      expect(
        (
          await fixture.db`select state,delivery_attempts from allrice_conversation_commands where id=${input.requestId}`
        )[0],
      ).toEqual({ state: 'pending', delivery_attempts: 0 });
      expect(
        (
          await fixture.db`select lease_expires_at from allrice_runtime_operations where id=${c.identity.operationId}`
        )[0],
      ).toEqual(before);
    },
  );
  const close = (f: Chat) =>
    releaseConversationRuntime({
      organizationId: f.org,
      workspaceId: f.workspace,
      sessionId: f.session,
      runId: f.rootRunId,
      workerId: f.worker.workerId,
      outcome: 'idle',
    });
  async function executionCounts(f: Chat) {
    const [row] = await fixture.db`select
      (select count(*) from allrice_runs where organization_id=${f.org}) as runs,
      (select count(*) from allrice_jobs where organization_id=${f.org}) as jobs,
      (select count(*) from allrice_conversation_followups where session_id=${f.session}) as followups,
      (select count(*) from allrice_messages where session_id=${f.session}) as messages`;
    return row;
  }

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
    'base64',
  );
  async function upload(f: Chat) {
    const saved = await createStorageMetadata(f.context, {
      id: randomUUID(),
      workspaceId: f.workspace,
      category: 'uploads',
      mediaType: 'image/png',
      sizeBytes: png.length,
      checksum: `sha256:${createHash('sha256').update(png).digest('hex')}`,
      visibility: 'private',
      retentionUntil: null,
      immutable: false,
    });
    await runtimeFixtureStorage(fixture.db).put(
      saved.object,
      new Blob([png]).stream(),
    );
    await markStorageReady(f.context, saved.object.id);
    await linkFileToSession({
      context: f.context,
      workspaceId: f.workspace,
      sessionId: f.session,
      objectId: saved.object.id,
      fileName: '补充.png',
    });
    return saved.object.id;
  }
  it.each([false, true])(
    '“给这个子任务发图” freezes authorized objects and sends native bytes once (with text=%s)',
    async (withText) => {
      const f = await chat(),
        objectId = await upload(f);
      const input: NativeSubagentControlInput = {
        ...prompt(f),
        kind: 'prompt',
        delivery: 'queue',
        content: [
          ...(withText ? [{ type: 'text' as const, text: '请看图' }] : []),
          { type: 'image', objectId },
        ],
      };
      const ticket = await enqueue(f, input);
      expect(ticket.message).toMatchObject({
        content: input.content,
        images: [
          { id: objectId, fileName: '补充.png', mediaType: 'image/png' },
        ],
      });
      const native = vi.fn<
        (
          request: NativeSubagentControlWire,
        ) => Promise<{ kind: 'prompt'; messageId: string }>
      >(async () => ({
        kind: 'prompt' as const,
        messageId: 'native-image-message',
      }));
      vi.stubEnv('ALLRICE_STORAGE_ROOT', fixture.storageRoot);
      const poll = () =>
        pollNativeSubagentControl({
          authority: f.authority,
          ownerId: f.user,
          sessionId: f.session,
          adapter: {
            nativeSubagentControl: native,
          } as unknown as HarnessAdapter,
          open: () => true,
          revoke: () => {
            throw Error('unexpected revoke');
          },
        });
      expect(await poll()).toBe(true);
      await expect
        .poll(async () => (await read(f, input.requestId))?.result.status)
        .toBe('accepted');
      expect(native).toHaveBeenCalledTimes(1);
      expect(native.mock.calls[0]?.[0]).toMatchObject({
        input: {
          content: [
            ...(withText ? [{ type: 'text', text: '请看图' }] : []),
            {
              type: 'image',
              mediaType: 'image/png',
              data: png.toString('base64'),
              name: '补充.png',
            },
          ],
        },
      });
      expect(await poll()).toBe(false);
      expect((await enqueue(f, input)).result.status).toBe('accepted');
      const [row] =
        await fixture.db`select native_input,attempts from allrice_conversation_commands where id=${input.requestId}`;
      expect(row?.attempts).toBe(1);
      await authorizeNativeSubagentControlImages(
        f.context,
        f.session,
        row!.native_input,
      );
      await fixture.db`update allrice_storage_objects set checksum=${'sha256:' + 'f'.repeat(64)} where id=${objectId}`;
      await expect(
        authorizeNativeSubagentControlImages(
          f.context,
          f.session,
          row!.native_input,
        ),
      ).rejects.toThrow('CHILD_CONTROL_UNAVAILABLE');
      expect((await read(f, input.requestId))?.message).toEqual(ticket.message);
      const foreign = await chat();
      await expect(
        enqueue(foreign, {
          ...input,
          requestId: randomUUID(),
          parentSessionId: foreign.descriptor.nativeSessionId,
        }),
      ).rejects.toThrow('CHILD_CONTROL_UNAVAILABLE');
    },
  );
  it('“图片读取中已撤掉会话关联” rejects before native dispatch and retains the original request', async () => {
    const f = await chat(),
      objectId = await upload(f);
    const input: NativeSubagentControlInput = {
      ...prompt(f),
      kind: 'prompt',
      delivery: 'steer',
      content: [{ type: 'image', objectId }],
    };
    await enqueue(f, input);
    vi.stubEnv('ALLRICE_STORAGE_ROOT', fixture.storageRoot);
    const get = LocalStorageAdapter.prototype.get;
    const spy = vi
      .spyOn(LocalStorageAdapter.prototype, 'get')
      .mockImplementation(async function (this: LocalStorageAdapter, object) {
        const stream = await get.call(this, object);
        await fixture.db`delete from allrice_file_references where object_id=${objectId}`;
        return stream;
      });
    const native = vi.fn();
    try {
      await pollNativeSubagentControl({
        authority: f.authority,
        ownerId: f.user,
        sessionId: f.session,
        adapter: { nativeSubagentControl: native } as unknown as HarnessAdapter,
        open: () => true,
        revoke: () => {},
      });
      await expect
        .poll(async () => (await read(f, input.requestId))?.result)
        .toEqual({
          status: 'rejected',
          code: 'NATIVE_CONTROL_IMAGE_UNAVAILABLE',
        });
      expect(native).not.toHaveBeenCalled();
      expect((await read(f, input.requestId))?.message?.content).toEqual(
        input.content,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('records once through the real DB entry, freezes the server incarnation and creates no execution placeholders', async () => {
    const f = await chat(),
      input = prompt(f),
      before = await executionCounts(f);
    const tickets = await Promise.all([enqueue(f, input), enqueue(f, input)]);
    expect(tickets[0]).toEqual(tickets[1]);
    expect(tickets[0]).toMatchObject({
      requestId: input.requestId,
      result: { status: 'recorded' },
    });
    const saved = await read(f, input.requestId);
    expect(saved?.request.scope).toMatchObject({
      rootRunId: f.rootRunId,
      nativeRootId: f.descriptor.nativeSessionId,
      generation: f.worker.generation,
      jobId: f.worker.jobId,
      jobAttempt: 1,
      rootOriginDigest: f.pin.rootOriginDigest,
      storageNamespace: f.descriptor.storageNamespace,
    });
    expect(JSON.stringify(saved?.ticket)).not.toContain(
      f.descriptor.storageNamespace,
    );
    expect(await executionCounts(f)).toEqual(before);
    await expect(
      enqueue(f, { ...input, childSessionId: 'different' }),
    ).rejects.toThrow('CHILD_CONTROL_CONFLICT');
    await expect(
      enqueueNativeSubagentControl(f.context, f.session, {
        ...expected(f, input),
        generation: f.worker.generation + 1,
      }),
    ).rejects.toThrow('CHILD_CONTROL_CONFLICT');
    const [row] =
      await fixture.db`select followup_run_id,client_user_message_id,expected_turn_id,message,input_kind,delivery_attempts
      from allrice_conversation_commands where id=${input.requestId}`;
    expect(row).toEqual({
      followup_run_id: null,
      client_user_message_id: null,
      expected_turn_id: null,
      message: null,
      input_kind: null,
      delivery_attempts: 0,
    });
    await expect(
      fixture.db`update allrice_conversation_commands set native_input='{}' where id=${input.requestId}`,
    ).rejects.toThrow('immutable native child command');
  });

  it('freezes ordered native text parts and reuses only the same immutable content', async () => {
    const f = await chat();
    const input = {
      ...prompt(f),
      kind: 'prompt' as const,
      delivery: 'queue' as const,
      content: [
        { type: 'text' as const, text: '请按修正数值计算。' },
        { type: 'text' as const, text: '' },
        { type: 'text' as const, text: '第二项改为 500。' },
      ],
    };
    const original = structuredClone(input.content);
    const ticket = await enqueue(f, input);
    input.content[0]!.text = 'changed after enqueue';
    expect((await read(f, input.requestId))?.request.input).toMatchObject({
      content: original,
    });
    expect(await enqueue(f, { ...input, content: original })).toEqual(ticket);
    await expect(enqueue(f, input)).rejects.toThrow('CHILD_CONTROL_CONFLICT');
  });

  it('canonicalizes PG UUID identities on first uppercase submission and retries while retaining opaque native case', async () => {
    const f = await chat('MixedCase');
    const input = {
      ...prompt(f),
      requestId: 'A1000000-A001-4000-8000-000000000001',
      childSessionId: 'dsh-NativeChild-MixedCase',
    };
    const ticket = await enqueueNativeSubagentControl(f.context, f.session, {
      ...expected(f, input),
      rootRunId: f.rootRunId.toUpperCase(),
    });
    const canonical = input.requestId.toLowerCase();
    expect(ticket.requestId).toBe(canonical);
    expect(await enqueue(f, { ...input, requestId: canonical })).toEqual(
      ticket,
    );
    expect(await enqueue(f, input)).toEqual(ticket);
    for (const address of [
      { parentSessionId: input.parentSessionId.toLowerCase() },
      { childSessionId: input.childSessionId.toLowerCase() },
    ]) {
      await expect(enqueue(f, { ...input, ...address })).rejects.toThrow(
        'CHILD_CONTROL_CONFLICT',
      );
    }
    const request = await claimNativeSubagentControl({
      ...f.authority,
      rootRunId: f.rootRunId.toUpperCase(),
      worker: {
        ...f.authority.worker,
        jobId: f.worker.jobId.toUpperCase(),
      },
    });
    expect(request?.scope).toMatchObject({
      rootRunId: f.rootRunId,
      jobId: f.worker.jobId,
      nativeRootId: f.descriptor.nativeSessionId,
    });
    expect(request?.input).toMatchObject({
      requestId: canonical,
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
    });
    if (!request) throw Error('expected first claim');
    const upperRequest = {
      ...request,
      scope: {
        ...request.scope,
        rootRunId: f.rootRunId.toUpperCase(),
        jobId: f.worker.jobId.toUpperCase(),
      },
      input: { ...request.input, requestId: input.requestId },
    };
    const observation = {
      status: 'accepted' as const,
      acceptance: {
        kind: 'prompt' as const,
        messageId: 'NativeMessage-MixedCase',
      },
      source: { kind: 'user_rpc' as const, rpcId: canonical, sequence: 2 },
    };
    // RPC source is native evidence: only PG input identities canonicalize.
    await expect(
      recordNativeSubagentControlResult(f.context, f.session, upperRequest, {
        ...observation,
        source: { ...observation.source, rpcId: input.requestId },
      }),
    ).rejects.toThrow('CHILD_CONTROL_CONFLICT');
    const accepted = await recordNativeSubagentControlResult(
      f.context,
      f.session,
      upperRequest,
      observation,
    );
    expect(accepted.result).toEqual(observation);
    expect((await read(f, input.requestId))?.ticket).toEqual(accepted);
  });

  it('rejects foreign/currently revoked owners, stale roots and stale generations before storing a ticket', async () => {
    const f = await chat(),
      other = await chat(),
      input = prompt(f);
    await enqueue(f, input);
    await expect(
      getNativeSubagentControl(other.context, f.session, input.requestId),
    ).rejects.toThrow('artifact_not_found');
    await expect(
      enqueueNativeSubagentControl(
        other.context,
        f.session,
        expected(f, prompt(f)),
      ),
    ).rejects.toThrow('artifact_not_found');
    await expect(
      enqueueNativeSubagentControl(f.context, f.session, {
        ...expected(f, prompt(f)),
        rootRunId: other.rootRunId,
      }),
    ).rejects.toThrow('CHILD_CONTROL_UNAVAILABLE');
    await expect(
      enqueueNativeSubagentControl(f.context, f.session, {
        ...expected(f, prompt(f)),
        generation: f.worker.generation + 1,
      }),
    ).rejects.toThrow('CHILD_CONTROL_UNAVAILABLE');
    await fixture.db`update allrice_memberships set active=false where id=${f.membership}`;
    await expect(enqueue(f, prompt(f))).rejects.toThrow('identity_denied');
    await expect(claimNativeSubagentControl(f.authority)).rejects.toThrow();
    expect(
      (
        await fixture.db`select delivery_attempts from allrice_conversation_commands where id=${input.requestId}`
      )[0]!.delivery_attempts,
    ).toBe(0);
  });

  it('claims atomically once; stale time and every old steer mutator cannot replay or consume a child command', async () => {
    const f = await chat(),
      input = prompt(f);
    await enqueue(f, input);
    const claims = await Promise.all([
      claimNativeSubagentControl(f.authority),
      claimNativeSubagentControl(f.authority),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.input).toEqual(input);
    await fixture.db`update allrice_conversation_commands set claimed_at=clock_timestamp()-interval '2 minutes' where id=${input.requestId}`;
    const old = { commandId: input.requestId, workerId: f.worker.workerId };
    await deferConversationSteer(old);
    await rejectConversationSteer({ ...old, errorCode: 'OLD_STEER_REJECT' });
    await consumeConversationSteer(old);
    expect(await claimNativeSubagentControl(f.authority)).toBeNull();
    expect((await read(f, input.requestId))?.ticket.result).toEqual({
      status: 'unknown',
    });
    expect(
      (
        await fixture.db`select state,delivery_attempts,native_proof from allrice_conversation_commands where id=${input.requestId}`
      )[0],
    ).toEqual({ state: 'claimed', delivery_attempts: 1, native_proof: null });
  });

  for (const operation of ['submit', 'claim'] as const)
    it(`serializes child Stop ${operation} with ordinary publication before taking Job locks`, async () => {
      const f = await chat();
      const input: NativeSubagentControlInput = {
        kind: 'interrupt',
        requestId: randomUUID(),
        parentSessionId: f.descriptor.nativeSessionId,
        childSessionId: `synthetic-child-${randomUUID()}`,
        mode: 'continuable',
      };
      if (operation === 'claim') await enqueue(f, input);
      const [policy] =
        await fixture.db`select payload,issued_at,expires_at from allrice_policy_snapshots where id=${f.policy}`;
      const context = ExecutionContextSchema.parse({
        executionId: randomUUID(),
        runId: f.rootRunId,
        jobId: f.worker.jobId,
        worker: { type: 'worker', id: f.worker.workerId },
        delegatedBy: { type: 'user', id: f.user },
        organizationId: f.org,
        workspaceId: f.workspace,
        policySnapshot: {
          id: f.policy,
          organizationId: f.org,
          subjectId: f.user,
          version: 1,
          issuedAt: policy!.issued_at.toISOString(),
          expiresAt: policy!.expires_at.toISOString(),
          ...policy!.payload,
        },
        startedAt: new Date().toISOString(),
      });
      let release!: () => void;
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready!: () => void;
      const held = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let publisherPid = 0;
      const publicationDb = new Proxy(fixture.db, {
        get(target, key) {
          if (key !== 'begin') return Reflect.get(target, key, target);
          return (body: (tx: TransactionSql) => Promise<unknown>) =>
            target.begin(async (tx) => {
              await tx`set local statement_timeout='8s'`;
              publisherPid = (await tx`select pg_backend_pid() pid`)[0]!.pid;
              return body(
                new Proxy(tx, {
                  apply(query, receiver, args) {
                    const pending = Reflect.apply(query, receiver, args);
                    // Pause the real publisher after Session UPDATE, before its
                    // first Run/Job SHARE. A control must wait without holding Job.
                    if (String(args[1]).startsWith('artifact:'))
                      return (async () => {
                        await pending;
                        ready();
                        await resume;
                        return [];
                      })();
                    return pending;
                  },
                }),
              );
            });
        },
      });
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      const publication = publishWorkbenchArtifact(
        {
          context,
          sessionId: f.session,
          callId: randomUUID(),
          kind: 'document',
          fileName: 'while-stopping.txt',
          format: 'text',
          mediaType: 'text/plain',
          bytes: Buffer.from('Delivery survives a simultaneous child Stop.'),
        },
        runtimeFixtureStorage(fixture.db),
        publicationDb,
      );
      void publication.catch(() => {});
      let control: Promise<unknown> | undefined;
      try {
        await Promise.race([
          held,
          publication.then(() => {
            throw Error('publication missed its barrier');
          }),
        ]);
        control =
          operation === 'submit'
            ? enqueue(f, input)
            : claimNativeSubagentControl({
                ...f.authority,
                rootRunId: f.rootRunId.toUpperCase(),
              });
        void control.catch(() => {});
        let waitEvent: string | undefined;
        await expect
          .poll(
            async () => {
              const rows =
                await fixture.db`select wait_event from pg_stat_activity
            where ${publisherPid}=any(pg_blocking_pids(pid)) and wait_event_type='Lock'`;
              waitEvent = rows[0]?.wait_event;
              return rows.length;
            },
            { timeout: 2000, interval: 10 },
          )
          .toBe(1);
        expect(waitEvent).toBe('advisory');
      } finally {
        release();
        await Promise.allSettled([publication, control]);
      }
      expect((await publication).version.fileName).toBe('while-stopping.txt');
      await control;
      expect((await read(f, input.requestId))?.ticket.result.status).toBe(
        operation === 'submit' ? 'recorded' : 'unknown',
      );
      expect(
        (
          await fixture.db`select delivery_attempts from allrice_conversation_commands where id=${input.requestId}`
        )[0]!.delivery_attempts,
      ).toBe(operation === 'submit' ? 0 : 1);
    });

  for (const operation of ['submit', 'claim'] as const)
    it(`rechecks an expired lease after ${operation} waits on the publication mutex`, async () => {
      const f = await chat(),
        input = prompt(f);
      if (operation === 'claim') await enqueue(f, input);
      let pending: Promise<unknown> | undefined;
      await fixture.db.begin(async (tx) => {
        const [holder] =
          await tx`select pg_backend_pid() pid,pg_advisory_xact_lock(hashtextextended(${f.rootRunId},703))`;
        pending =
          operation === 'submit'
            ? enqueue(f, input)
            : claimNativeSubagentControl(f.authority);
        void pending.catch(() => {});
        await expect
          .poll(
            async () => {
              const rows =
                await fixture.db`select pid from pg_stat_activity where ${holder!.pid}=any(pg_blocking_pids(pid)) and wait_event='advisory'`;
              return rows.length;
            },
            { timeout: 2000, interval: 10 },
          )
          .toBe(1);
        await tx`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
      });
      await expect(pending).rejects.toThrow();
      const rows =
        await fixture.db`select state,delivery_attempts from allrice_conversation_commands where id=${input.requestId}`;
      expect(rows).toEqual(
        operation === 'submit'
          ? []
          : [{ state: 'pending', delivery_attempts: 0 }],
      );
    });

  it('never transfers a pending command to a later Job incarnation or an expired execution lease', async () => {
    const f = await chat(),
      input = prompt(f);
    await enqueue(f, input);
    await fixture.db`update allrice_jobs set attempt=2 where id=${f.worker.jobId}`;
    await expect(claimNativeSubagentControl(f.authority)).rejects.toThrow();
    expect(
      await claimNativeSubagentControl({
        ...f.authority,
        worker: { ...f.authority.worker, attempt: 2 },
      }),
    ).toBeNull();
    await fixture.db`update allrice_jobs set attempt=1,lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
    await expect(claimNativeSubagentControl(f.authority)).rejects.toThrow();
    expect(
      (
        await fixture.db`select delivery_attempts from allrice_conversation_commands where id=${input.requestId}`
      )[0]!.delivery_attempts,
    ).toBe(0);
  });

  it('preserves legacy NOT NULL semantics and the real steer defer/reclaim/consume path', async () => {
    const f = await chat(),
      turnId = `${f.descriptor.nativeSessionId}:turn:1`;
    await expect(fixture.db`insert into allrice_conversation_commands
      (organization_id,workspace_id,session_id,owner_id,command_type,expected_generation)
      values(${f.org},${f.workspace},${f.session},${f.user},'steer',${f.worker.generation})`).rejects.toMatchObject(
      { code: '23514' },
    );
    await fixture.db`update allrice_conversation_runtimes set active_turn_id=${turnId} where session_id=${f.session}`;
    await fixture.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
      values(${f.org},${f.workspace},${f.rootRunId},1,'turn.started',${fixture.db.json({ turnId, generation: f.worker.generation })})`;
    const sent = await sendChatMessage(f.context, f.workspace, f.session, {
      clientMessageId: randomUUID(),
      text: 'A legacy steer.',
      deliveryMode: 'steer',
      expectedTurnId: turnId,
      expectedGeneration: f.worker.generation,
    });
    expect(sent.delivery).toBe('steer_pending');
    const child = prompt(f);
    await enqueue(f, child);
    const oldInput = {
      organizationId: f.org,
      workspaceId: f.workspace,
      sessionId: f.session,
      workerId: f.worker.workerId,
      generation: f.worker.generation,
      turnId,
      runId: f.rootRunId,
      drain: true,
    };
    const old = await claimConversationSteer(oldInput);
    expect(old).not.toBeNull();
    expect(old!.id).not.toBe(child.requestId);
    await deferConversationSteer({
      commandId: old!.id,
      workerId: f.worker.workerId,
    });
    await claimConversationSteer(oldInput);
    await fixture.db`update allrice_conversation_commands set claimed_at=clock_timestamp()-interval '2 minutes' where id=${old!.id}`;
    expect((await claimConversationSteer(oldInput))?.id).toBe(old!.id);
    await consumeConversationSteer({
      commandId: old!.id,
      workerId: f.worker.workerId,
      proof: {
        status: 'adopted',
        inputId: old!.clientUserMessageId,
        messageId: randomUUID(),
        turnId,
        runId: f.rootRunId,
        sequence: 3,
        checkpoint: 'step_user_message',
      },
    });
    expect(
      (
        await fixture.db`select state,delivery_attempts from allrice_conversation_commands where id=${old!.id}`
      )[0],
    ).toEqual({ state: 'consumed', delivery_attempts: 3 });
    expect((await read(f, child.requestId))?.ticket.result).toEqual({
      status: 'recorded',
    });
  });

  it('closes unclaimed input definitively but preserves claimed unknown and only supplements positive original-request receipts', async () => {
    const f = await chat(),
      first = prompt(f),
      pending = prompt(f);
    const before = await executionCounts(f);
    await enqueue(f, first);
    const request = (await claimNativeSubagentControl(f.authority))!;
    await enqueue(f, pending);
    await close(f);
    expect((await read(f, first.requestId))?.ticket.result).toEqual({
      status: 'unknown',
    });
    expect((await read(f, pending.requestId))?.ticket.result).toEqual({
      status: 'rejected',
      code: 'TURN_CLOSED',
    });
    expect((await enqueue(f, first)).result).toEqual({ status: 'unknown' });
    await expect(enqueue(f, prompt(f))).rejects.toThrow(
      'CHILD_CONTROL_UNAVAILABLE',
    );
    await expect(claimNativeSubagentControl(f.authority)).rejects.toThrow();
    // Synthetic trusted-observer evidence: C3 must verify actual own-suffix
    // user/source.rpcId in the original namespace; this suite never opens DSH.
    const positive = {
      status: 'accepted' as const,
      acceptance: { kind: 'prompt' as const, messageId: 'native-message-17' },
      source: {
        kind: 'user_rpc' as const,
        rpcId: first.requestId,
        sequence: 17,
      },
    };
    await expect(
      recordNativeSubagentControlResult(f.context, f.session, request, {
        ...positive,
        source: { ...positive.source, rpcId: randomUUID() },
      }),
    ).rejects.toThrow('CHILD_CONTROL_CONFLICT');
    await expect(
      recordNativeSubagentControlResult(
        f.context,
        f.session,
        { ...request, scope: { ...request.scope, rootRunId: randomUUID() } },
        positive,
      ),
    ).rejects.toThrow('CHILD_CONTROL_CONFLICT');
    const accepted = await recordNativeSubagentControlResult(
      f.context,
      f.session,
      request,
      positive,
    );
    expect(accepted.result).toEqual(positive);
    expect(
      await recordNativeSubagentControlResult(f.context, f.session, request, {
        ...positive,
        source: { kind: 'native_ack' },
      }),
    ).toEqual(accepted);
    await expect(
      recordNativeSubagentControlResult(f.context, f.session, request, {
        ...positive,
        acceptance: { kind: 'prompt', messageId: 'ambiguous-other-message' },
      }),
    ).rejects.toThrow('CHILD_CONTROL_CONFLICT');
    expect(
      await recordNativeSubagentControlResult(f.context, f.session, request, {
        status: 'unknown',
      }),
    ).toEqual(accepted);
    const pendingRequest = (await read(f, pending.requestId))!.request;
    expect(
      (
        await recordNativeSubagentControlResult(
          f.context,
          f.session,
          pendingRequest,
          { ...positive, source: { kind: 'native_ack' } },
        )
      ).result,
    ).toEqual({ status: 'rejected', code: 'TURN_CLOSED' });
    expect(await executionCounts(f)).toEqual(before);
    expect(
      (
        await fixture.db`select delivery_attempts from allrice_conversation_commands where id=${first.requestId}`
      )[0]!.delivery_attempts,
    ).toBe(1);
  });

  it('records prompt unknown honestly and interrupt ACK as acceptance, never as stopped/completed', async () => {
    const f = await chat(),
      input = prompt(f);
    await enqueue(f, input);
    const request = (await claimNativeSubagentControl(f.authority))!;
    expect(
      (
        await recordNativeSubagentControlResult(f.context, f.session, request, {
          status: 'unknown',
        })
      ).result,
    ).toEqual({ status: 'unknown' });
    expect(await claimNativeSubagentControl(f.authority)).toBeNull();
    expect(
      NativeSubagentControlResultSchema.safeParse({
        status: 'rejected',
        code: 'INPUT_OUTCOME_UNKNOWN',
      }).success,
    ).toBe(false);
    const stop: NativeSubagentControlInput = {
      kind: 'interrupt',
      requestId: randomUUID(),
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      mode: 'continuable',
    };
    await enqueue(f, stop);
    const stopRequest = (await claimNativeSubagentControl(f.authority))!;
    const accepted = {
      status: 'accepted' as const,
      acceptance: { kind: 'interrupt' as const, accepted: true as const },
      source: { kind: 'native_ack' as const },
    };
    expect(
      (
        await recordNativeSubagentControlResult(
          f.context,
          f.session,
          stopRequest,
          accepted,
        )
      ).result,
    ).toEqual(accepted);
    expect((await read(f, stop.requestId))!.request.input).toEqual(stop);
  });
});
