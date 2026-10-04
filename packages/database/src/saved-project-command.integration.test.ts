/** Real isolated PostgreSQL authority/lease/receipt checks. No VM or model is
 * represented as executed by these tests; native execution has separate evidence. */
import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import {
  ProjectVersionRefSchema,
  managedPythonPayloadForPlatform,
  localCommandToolchainImageV1,
  RuntimeLocalCommandSchema,
} from '@allrice/contracts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from './assistant-runtime.fixture.ts';
import { createAssistantLocalCommandFixture } from './local-command-assistant.fixture.ts';
import { executeProjectWorkspace } from './project-workspace.ts';
import {
  createLocalCommandOperation,
  listLocalCommandOperations,
} from './local-command-service.ts';
import { publishLocalProjectArtifacts } from './project-delivery.ts';
import { selectProjectExecution } from './project-execution.ts';
import { listWorkbenchArtifacts } from './artifact-review.ts';
import { reportLocalCommandProfile } from './local-command-profile.ts';
import { reportLocalPythonProfile } from './local-python-execution.ts';
import { readManagedRuntimeGrant } from './managed-runtime-grant.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET166 PR3b exact saved-source local command — real PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    for (const key of [
      'ASSISTANTS',
      'WORKBENCH',
      'RUNTIME_POLICY',
      'BRIDGE_OPERATION_LEDGER',
      'LOCAL_COMMAND',
    ])
      vi.stubEnv(`ALLRICE_${key}_ENABLED`, '1');
    database = await createAssistantFixtureDatabase();
  }, 120000);
  afterAll(async () => {
    await database?.close();
    vi.unstubAllEnvs();
  });
  async function setup(withOutput = false) {
    const f = await createAssistantLocalCommandFixture(
      database.db,
      'allow',
      false,
      { skipChild: true, projectWorkspace: true },
    );
    const storage = assistantFixtureStorage(f.db),
      [job] = await f.db<
        { attempt: number }[]
      >`select attempt from allrice_jobs where id=${f.context.jobId}`;
    const worker = { attempt: job!.attempt, leaseToken: f.worker.leaseToken };
    const files = [
      { path: 'main.cjs', text: "console.log('saved-project:42')\n" },
      {
        path: 'package.json',
        text: '{"name":"saved-project","version":"1.0.0","packageManager":"pnpm@10.33.3"}',
      },
      {
        path: 'pnpm-lock.yaml',
        text: "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n",
      },
    ];
    const opened = (await executeProjectWorkspace(
      {
        context: f.context,
        sessionId: f.task.chatSessionId!,
        worker,
        callId: randomUUID(),
        arguments: { action: 'open', files },
      },
      storage,
      f.db,
    )) as { project: unknown; sourceDigest: string };
    const project = ProjectVersionRefSchema.parse(opened.project);
    await reportLocalCommandProfile(
      f.device,
      {
        contractVersion: 1,
        backend: 'local-vm-container-v1',
        imageDigest: localCommandToolchainImageV1,
        architecture: 'amd64',
        available: true,
        features: ['project_preparation', 'saved_project_source'],
        projectPreparation: {
          version: 1,
          available: true,
          nodeImage: localCommandToolchainImageV1,
          pythonImage: managedPythonPayloadForPlatform('macos-x64')!.imageId,
          pnpmVersion: '10.33.3',
          uvVersion: '0.8.22',
        },
      },
      f.db,
    );
    await f.db`update allrice_bridge_folder_grants set revoked_at=clock_timestamp() where device_id=${f.device.id}`;
    const args = {
      executable: '/usr/local/bin/node',
      args: ['main.cjs'],
      path: '.',
      project,
      ...(withOutput
        ? {
            outputs: [
              {
                path: 'dist/index.html',
                fileName: 'index.html',
                format: 'html',
              },
            ],
          }
        : {}),
      limits: {
        timeoutMs: 10000,
        outputBytes: 16384,
        memoryMiB: 256,
        cpuMillis: 1000,
        pids: 64,
      },
      projectPreparation: {
        version: 1,
        projectId: project.projectId,
        sourceDigest: opened.sourceDigest,
        lockChecksum: `sha256:${createHash('sha256').update(files[2]!.text).digest('hex')}`,
        manager: 'pnpm',
        managerVersion: '10.33.3',
        lockPath: 'pnpm-lock.yaml',
        offline: true,
        scripts: 'disabled',
        packages: [],
      },
    };
    const callId = randomUUID();
    if (withOutput)
      await f.db`update allrice_execution_targets set metadata=jsonb_set(metadata,'{environment}',${f.db.json(
        {
          version: 1,
          clientVersion: '0.6.0-dev.31',
          browser: 'unavailable',
          sandbox: 'ready',
          preview: 'unavailable',
          paused: false,
          readiness: [
            {
              capability: 'local.process',
              state: 'ready',
              reason: 'synthetic_ready',
              missing: [],
              versions: {},
              observedAt: new Date().toISOString(),
            },
          ],
        },
      )}) where target_key=${'bridge.' + f.device.id}`;
    const projectSelection = withOutput
      ? await selectProjectExecution(
          {
            context: f.context,
            callId,
            arguments: { action: 'execute', ...args },
            worker,
            cloudReady: false,
          },
          f.db,
        )
      : undefined;
    const create = async (override: Record<string, unknown> = {}) => {
      const op = await createLocalCommandOperation(
        {
          context: f.context,
          arguments: args,
          worker,
          storage,
          callId,
          ...(projectSelection ? { projectSelection } : {}),
          ...override,
        },
        f.db,
      );
      const [approval] =
        await f.db`select runtime_response from allrice_approval_requests where resource_id=${op.snapshot.binding.attempt.operationId} and resource_type='runtime_operation'`;
      if (
        op.snapshot.status === 'waiting_user' &&
        approval?.runtime_response === null
      )
        await f.approve(
          await f.approvalFor(op.snapshot.binding.attempt.operationId),
        );
      return op;
    };
    return { ...f, storage, worker, project, args, create };
  }
  it('admits an exact private version without any live folder grant; idempotent read strips bytes and provenance', async () => {
    const f = await setup(),
      grant = await readManagedRuntimeGrant(f.device, f.db),
      op = await f.create();
    expect(op.snapshot.binding.execution.grantId).toBe(grant!.id);
    expect(op.snapshot.binding.task.scope.projectId).toBeNull();
    expect((await f.create()).snapshot.binding.attempt.operationId).toBe(
      op.snapshot.binding.attempt.operationId,
    );
    const publicRows = await listLocalCommandOperations(
      f.requestContext,
      f.rootRunId,
      f.db,
    );
    expect(publicRows[0]?.command?.project).toEqual(f.project);
    expect(JSON.stringify(publicRows)).not.toContain('contentBase64');
    expect(JSON.stringify(publicRows)).not.toContain('leaseTokenDigest');
    const [stored] =
      await f.db`select bridge_payload from allrice_runtime_operations where id=${op.snapshot.binding.attempt.operationId}`;
    const payload = RuntimeLocalCommandSchema.parse(stored!.bridge_payload);
    expect(payload.arguments.projectSource?.snapshot.files).toHaveLength(3);
    expect(payload.arguments.projectSource?.origin.attempt).toBe(
      f.worker.attempt,
    );
    expect(payload.arguments.projectSource?.origin.leaseTokenDigest).toBe(
      createHash('sha256').update(f.worker.leaseToken).digest('hex'),
    );
  });
  it('older claims cannot receive a saved-source operation; declared support uses the same ledger', async () => {
    const f = await setup(),
      op = await f.create(),
      ledger = f.freshLedger();
    const options = {
      scope: f.task.scope,
      deviceId: f.device.id,
      leaseOwner: randomUUID(),
      leaseMs: 30000,
      supportsLocalCommand: true,
      supportsProjectPreparation: true,
    };
    expect(await ledger.claimNextBridgeOperation(options)).toBeNull();
    const claimed = await ledger.claimNextBridgeOperation({
      ...options,
      supportsSavedProjectSource: true,
    });
    expect(claimed?.snapshot.binding.attempt.operationId).toBe(
      op.snapshot.binding.attempt.operationId,
    );
  });
  it('rechecks the exact Worker token after an idempotent replay waits for the existing root', async () => {
    const f = await setup(),
      op = await f.create();
    await f.freshLedger().dispatch({
      scope: f.task.scope,
      operationId: op.snapshot.binding.attempt.operationId,
      leaseOwner: randomUUID(),
      leaseMs: 30000,
    });
    let release!: () => void, locked!: (pid: number) => void;
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockedGate = new Promise<number>((resolve) => {
      locked = resolve;
    });
    const blocker = f.db.begin(async (tx) => {
      await tx`select root_run_id from allrice_runtime_roots where root_run_id=${f.rootRunId} for update`;
      locked(Number((await tx`select pg_backend_pid() as pid`)[0]!.pid));
      await releaseGate;
    });
    const pid = await lockedGate;
    const retry = f.create();
    void retry.catch(() => {});
    try {
      await expect
        .poll(async () => {
          const [row] =
            await f.db`select count(*)::int as n from pg_stat_activity
          where ${pid}::int=any(pg_blocking_pids(pid)) and query like '%allrice_runtime_roots%'`;
          return row!.n;
        })
        .toBe(1);
      await f.db`update allrice_jobs set lease_token=${randomUUID()} where id=${f.context.jobId}`;
    } finally {
      release();
      await blocker;
    }
    await expect(retry).rejects.toThrow('bridge_authority_changed');
    const [count] =
      await f.db`select count(*)::int as n from allrice_runtime_operations where root_run_id=${f.rootRunId}`;
    expect(count!.n).toBe(1);
  });
  it.each(['command', 'python'] as const)(
    '%s profile reporting waits for the grant before locking its profile',
    async (kind) => {
      const f = await setup(),
        grant = await readManagedRuntimeGrant(f.device, f.db);
      const release = managedPythonPayloadForPlatform('macos-x64')!;
      const python = {
        contractVersion: 1,
        profileVersion: 1,
        backend: 'local-vm-container-v1',
        imageId: release.imageId,
        architecture: release.architecture,
        pythonVersion: release.pythonVersion,
        packagesChecksum: release.packagesChecksum,
        officeCheckerChecksum: release.officeChecker.sha256,
        pngCheckerChecksum: release.pngChecker.sha256,
        fontChecksum: release.font.sha256,
        available: true,
        purposes: ['office', 'python_charts'],
        officeGeneration: true,
        officeFormulaCalculation: false,
        officePreview: false,
        stopConfirmed: true,
      };
      if (kind === 'python')
        await reportLocalPythonProfile(f.device, python, f.db);
      const [command] =
        await f.db`select profile from allrice_bridge_runtime_profiles where device_id=${f.device.id}`;
      let readProfile!: () => void, locked!: (pid: number) => void;
      const readGate = new Promise<void>((r) => {
        readProfile = r;
      });
      const lockedGate = new Promise<number>((r) => {
        locked = r;
      });
      const reader = f.db.begin(async (tx) => {
        await tx`select id from allrice_bridge_managed_runtime_grants where id=${grant!.id} for share`;
        locked(Number((await tx`select pg_backend_pid() as pid`)[0]!.pid));
        await readGate;
        await tx`set local lock_timeout='500ms'`;
        if (kind === 'command')
          await tx`select device_id from allrice_bridge_runtime_profiles where device_id=${f.device.id} for share`;
        else
          await tx`select device_id from allrice_bridge_managed_python_profiles where device_id=${f.device.id} for share`;
      });
      void reader.catch(() => {});
      const pid = await lockedGate;
      const reporting =
        kind === 'command'
          ? reportLocalCommandProfile(f.device, command!.profile, f.db)
          : reportLocalPythonProfile(f.device, python, f.db);
      void reporting.catch(() => {});
      try {
        await expect
          .poll(async () => {
            const [row] =
              await f.db`select count(*)::int as n from pg_stat_activity
            where ${pid}::int=any(pg_blocking_pids(pid)) and query like '%insert into allrice_bridge_managed_runtime_grants%'`;
            return row!.n;
          })
          .toBe(1);
        readProfile();
        await reader;
      } finally {
        readProfile();
        await Promise.allSettled([reader, reporting]);
      }
      await reporting;
    },
  );
  it('revoked managed grants do not substitute a folder; host commands cannot use the managed grant', async () => {
    const f = await setup();
    const { project, ...host } = f.args;
    expect(project).toEqual(f.project);
    await expect(
      f.create({
        arguments: {
          ...host,
          files: [{ path: 'main.cjs', sha256: `sha256:${'a'.repeat(64)}` }],
        },
      }),
    ).rejects.toThrow('local_runner_unavailable');
    await f.db`update allrice_bridge_managed_runtime_grants set revoked_at=clock_timestamp() where device_id=${f.device.id}`;
    await expect(f.create()).rejects.toThrow('local_runner_unavailable');
  });
  it.each(['attempt', 'token'] as const)(
    'a reacquired Worker %s cannot revive source authority, including same-call replay',
    async (kind) => {
      const f = await setup();
      await f.create();
      if (kind === 'attempt')
        await f.db`update allrice_jobs set attempt=attempt+1 where id=${f.context.jobId}`;
      else
        await f.db`update allrice_jobs set lease_token=${randomUUID()} where id=${f.context.jobId}`;
      await expect(f.create()).rejects.toThrow('bridge_authority_changed');
    },
  );
  it('rejects foreign versions and revoked read permission before creating an operation', async () => {
    const f = await setup(),
      other = await setup();
    await expect(
      f.create({ arguments: { ...f.args, project: other.project } }),
    ).rejects.toThrow('bridge_authority_changed');
    const context = structuredClone(f.context);
    context.policySnapshot.grants = context.policySnapshot.grants.filter(
      (g) =>
        g.resourceType !== 'storage_object' || g.action !== 'resource:read',
    );
    await expect(f.create({ context })).rejects.toThrow(
      'bridge_authority_changed',
    );
    expect(
      await f.db`select id from allrice_runtime_operations where run_id=${f.rootRunId}`,
    ).toHaveLength(0);
  });
  it.each(['member', 'employee', 'source', 'lease'] as const)(
    'rechecks %s authority at dispatch after operation creation',
    async (kind) => {
      const f = await setup(),
        op = await f.create();
      if (kind === 'member')
        await f.db`update allrice_memberships set active=false where organization_id=${f.org} and user_id=${f.user}`;
      if (kind === 'employee')
        await f.db`update allrice_employee_assignments set active=false where user_id=${f.user} and workspace_id=${f.workspace}`;
      if (kind === 'source') {
        await f.db`update allrice_storage_objects set retention_until=clock_timestamp()+interval '150 milliseconds' where id in (select object_id from allrice_deliverable_versions where id=${f.project.snapshot.id})`;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (kind === 'lease')
        await f.db`update allrice_jobs set lease_token=${randomUUID()} where id=${f.context.jobId}`;
      await expect(
        f.freshLedger().dispatch({
          scope: f.task.scope,
          operationId: op.snapshot.binding.attempt.operationId,
          leaseOwner: randomUUID(),
          leaseMs: 30000,
        }),
      ).rejects.toThrow();
      const [row] =
        await f.db`select snapshot from allrice_runtime_operations where id=${op.snapshot.binding.attempt.operationId}`;
      expect(row?.snapshot.status).not.toBe('dispatched');
    },
  );

  it('publishes only an exact stopped receipt; raw bytes are private and revoked managed grants deny publication', async () => {
    const f = await setup(true),
      op = await f.create(),
      ledger = f.freshLedger(),
      operationId = op.snapshot.binding.attempt.operationId;
    const lease = await ledger.dispatch({
      scope: f.task.scope,
      operationId,
      leaseOwner: randomUUID(),
      leaseMs: 30000,
    });
    const identity = {
      scope: f.task.scope,
      operationId,
      attempt: lease.snapshot.binding.attempt,
      leaseToken: lease.leaseToken,
    };
    await ledger.startOperation({ ...identity, receiptId: randomUUID() });
    const [stored] =
      await f.db`select bridge_payload from allrice_runtime_operations where id=${operationId}`;
    const payload = RuntimeLocalCommandSchema.parse(stored!.bridge_payload),
      p = payload.arguments.projectPreparation!,
      s = payload.arguments.projectSource!;
    const proof = {
      version: 1,
      projectId: p.projectId,
      sourceDigest: p.sourceDigest,
      lockChecksum: p.lockChecksum,
      cacheKey: s.cacheKey,
      manager: p.manager,
      managerVersion: p.managerVersion,
      platform: 'linux-amd64',
      runtimeImage: payload.arguments.imageDigest,
      packageCount: 0,
      archiveHits: 0,
      downloadedArchives: 0,
      downloadedBytes: 0,
      installation: 'succeeded',
      cacheVolume: `allrice-project-cache-${s.cacheKey.slice(7)}`,
      sourceDirectoryModified: false,
      hostEnvironmentModified: false,
      savedSource: { project: s.project, restoredDigest: p.sourceDigest },
    };
    const output = {
      backend: 'local-vm-container-v1',
      containerId: 'a'.repeat(64),
      imageDigest: payload.arguments.imageDigest,
      stopped: true,
      exitCode: 0,
      reason: 'exited',
      stdout: 'synthetic receipt validation only',
      stderr: '',
      truncated: false,
      workCopy: 'local_isolated_copy',
      sourceDirectoryModified: false,
      projectPreparation: proof,
    };

    const bytes = Buffer.from(
      '<html>synthetic authority fixture, not native execution</html>',
    );
    const result = {
      ...output,
      artifacts: [
        {
          path: 'dist/index.html',
          checksum:
            'sha256:' + createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.length,
          contentBase64: bytes.toString('base64'),
        },
      ],
    };
    await expect(
      publishLocalProjectArtifacts(
        { context: f.context, operationId },
        f.storage,
        f.db,
      ),
    ).rejects.toThrow('result_unconfirmed');
    await ledger.recordReceipt({
      ...identity,
      receiptId: randomUUID(),
      signal: {
        type: 'operation.outcome',
        result: {
          status: 'succeeded',
          effects: 'none',
          evidence: {
            id: randomUUID(),
            recordedAt: new Date().toISOString(),
            digest: 'sha256:' + 'b'.repeat(64),
          },
        },
      },
      evidence: { output: result },
    });
    const published = await publishLocalProjectArtifacts(
      { context: f.context, operationId },
      f.storage,
      f.db,
    );
    expect(published).toHaveLength(1);
    expect(
      await publishLocalProjectArtifacts(
        { context: f.context, operationId },
        f.storage,
        f.db,
      ),
    ).toEqual(published);
    expect(
      JSON.stringify(
        await listLocalCommandOperations(f.requestContext, f.rootRunId, f.db),
      ),
    ).not.toContain('contentBase64');
    expect(
      (
        await listWorkbenchArtifacts(
          f.requestContext,
          f.task.chatSessionId!,
          undefined,
          f.db,
        )
      ).artifacts,
    ).toHaveLength(1);
    await f.db`update allrice_bridge_managed_runtime_grants set revoked_at=clock_timestamp() where device_id=${f.device.id}`;
    await expect(
      publishLocalProjectArtifacts(
        { context: f.context, operationId },
        f.storage,
        f.db,
      ),
    ).rejects.toThrow();
  });
  it('requires exact source/architecture/no-effects receipts and reconciles stopped facts after the Worker lease is revoked', async () => {
    const f = await setup(),
      op = await f.create(),
      ledger = f.freshLedger(),
      operationId = op.snapshot.binding.attempt.operationId;
    const lease = await ledger.dispatch({
      scope: f.task.scope,
      operationId,
      leaseOwner: randomUUID(),
      leaseMs: 30000,
    });
    const identity = {
      scope: f.task.scope,
      operationId,
      attempt: lease.snapshot.binding.attempt,
      leaseToken: lease.leaseToken,
    };
    await ledger.startOperation({ ...identity, receiptId: randomUUID() });
    const [stored] =
      await f.db`select bridge_payload from allrice_runtime_operations where id=${operationId}`;
    const payload = RuntimeLocalCommandSchema.parse(stored!.bridge_payload),
      p = payload.arguments.projectPreparation!,
      s = payload.arguments.projectSource!;
    const proof = {
      version: 1,
      projectId: p.projectId,
      sourceDigest: p.sourceDigest,
      lockChecksum: p.lockChecksum,
      cacheKey: s.cacheKey,
      manager: p.manager,
      managerVersion: p.managerVersion,
      platform: 'linux-amd64',
      runtimeImage: payload.arguments.imageDigest,
      packageCount: 0,
      archiveHits: 0,
      downloadedArchives: 0,
      downloadedBytes: 0,
      installation: 'succeeded',
      cacheVolume: `allrice-project-cache-${s.cacheKey.slice(7)}`,
      sourceDirectoryModified: false,
      hostEnvironmentModified: false,
      savedSource: { project: s.project, restoredDigest: p.sourceDigest },
    };
    const output = {
      backend: 'local-vm-container-v1',
      containerId: 'a'.repeat(64),
      imageDigest: payload.arguments.imageDigest,
      stopped: true,
      exitCode: 0,
      reason: 'exited',
      stdout: 'synthetic receipt validation only',
      stderr: '',
      truncated: false,
      workCopy: 'local_isolated_copy',
      sourceDirectoryModified: false,
      projectPreparation: proof,
    };
    const receipt = {
      ...identity,
      receiptId: randomUUID(),
      signal: {
        type: 'operation.outcome' as const,
        result: {
          status: 'succeeded' as const,
          effects: 'none' as const,
          evidence: {
            id: randomUUID(),
            recordedAt: new Date().toISOString(),
            digest: `sha256:${'b'.repeat(64)}`,
          },
        },
      },
      evidence: { output },
    };
    for (const changed of [
      { platform: 'linux-arm64' },
      { cacheKey: `sha256:${'c'.repeat(64)}` },
      { savedSource: { project: s.project, restoredDigest: null } },
    ])
      await expect(
        ledger.recordReceipt({
          ...receipt,
          receiptId: randomUUID(),
          evidence: {
            output: { ...output, projectPreparation: { ...proof, ...changed } },
          },
        }),
      ).rejects.toThrow('invalid_state');
    await expect(
      ledger.recordReceipt({
        ...receipt,
        receiptId: randomUUID(),
        signal: {
          ...receipt.signal,
          result: { ...receipt.signal.result, effects: 'applied' },
        },
      }),
    ).rejects.toThrow('invalid_state');
    await f.db`update allrice_jobs set lease_token=${randomUUID()} where id=${f.context.jobId}`;
    await expect(
      ledger.heartbeat({ ...identity, leaseMs: 30000 }),
    ).rejects.toThrow();
    const stopped = {
      ...identity,
      receiptId: randomUUID(),
      signal: {
        type: 'operation.stopped' as const,
        effects: 'none' as const,
        evidence: receipt.signal.result.evidence,
      },
      evidence: {
        output: {
          ...output,
          exitCode: 137,
          reason: 'lease_lost',
          projectPreparation: {
            ...proof,
            installation: 'interrupted',
            savedSource: { project: s.project, restoredDigest: null },
          },
        },
      },
    };
    expect((await ledger.recordReceipt(stopped)).disposition).toBe('applied');
    expect((await ledger.recordReceipt(stopped)).disposition).toBe('duplicate');
  });
});
