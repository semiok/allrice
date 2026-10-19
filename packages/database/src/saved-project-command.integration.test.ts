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
import {
  listWorkbenchArtifacts,
  readArtifactBytes,
} from './artifact-review.ts';
import { getToolBrokerFile } from './execution/tool-broker.ts';
import { zipSync } from 'fflate';
import {
  seedProjectOutputParent,
  raceProjectPublications,
} from './project-output-parent.fixture.ts';
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
  async function setup(withOutput = false, revisionKind?: 'document' | 'file') {
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

    let parentZip: { objectId: string; versionId: string } | undefined;
    if (revisionKind) {
      const delivery = (await executeProjectWorkspace(
        {
          context: f.context,
          sessionId: f.task.chatSessionId!,
          worker,
          callId: randomUUID(),
          arguments: { action: 'deliver', project },
        },
        storage,
        f.db,
      )) as {
        artifacts: { fileName: string; objectId: string; versionId: string }[];
      };
      parentZip = delivery.artifacts.find(
        (a) => a.fileName === 'project-source.zip',
      )!;
      // Model an already-delivered cloud file parent in this isolated fixture;
      // the cloud test separately exercises actual file-kind registration.
      if (revisionKind === 'file') {
        const file = await getToolBrokerFile(
          f.context,
          parentZip.objectId,
          f.db,
        );
        parentZip = await seedProjectOutputParent({
          db: f.db,
          storage,
          context: f.context,
          sessionId: f.task.chatSessionId!,
          bytes: await readArtifactBytes(storage, file.object),
          kind: 'file',
        });
      }
    }

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
            outputs: parentZip
              ? [
                  {
                    path: 'project.zip',
                    fileName: 'project-v2.zip',
                    format: 'zip',
                    parentObjectId: parentZip.objectId,
                  },
                ]
              : [
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
          arguments: {
            ...args,
            ...(args.outputs
              ? {
                  outputs: args.outputs.map(({ path, fileName, format }) => ({
                    path,
                    fileName,
                    format,
                  })),
                }
              : {}),
          },
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
    return {
      ...f,
      storage,
      worker,
      project,
      args,
      create,
      parentZip,
      projectSelection,
    };
  }

  async function stoppedZip(
    f: Awaited<ReturnType<typeof setup>>,
    op: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['create']>>,
    bytes: Buffer,
  ) {
    const ledger = f.freshLedger();
    const operationId = op.snapshot.binding.attempt.operationId;
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
    const payload = RuntimeLocalCommandSchema.parse(stored!.bridge_payload);
    const p = payload.arguments.projectPreparation!,
      source = payload.arguments.projectSource!;
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
      evidence: {
        output: {
          backend: 'local-vm-container-v1',
          containerId: 'a'.repeat(64),
          imageDigest: payload.arguments.imageDigest,
          stopped: true,
          exitCode: 0,
          reason: 'exited',
          stdout: 'synthetic stopped receipt only',
          stderr: '',
          truncated: false,
          workCopy: 'local_isolated_copy',
          sourceDirectoryModified: false,
          projectPreparation: {
            version: 1,
            projectId: p.projectId,
            sourceDigest: p.sourceDigest,
            lockChecksum: p.lockChecksum,
            cacheKey: source.cacheKey,
            manager: p.manager,
            managerVersion: p.managerVersion,
            platform: 'linux-amd64',
            runtimeImage: payload.arguments.imageDigest,
            packageCount: 0,
            archiveHits: 0,
            downloadedArchives: 0,
            downloadedBytes: 0,
            installation: 'succeeded',
            cacheVolume: 'allrice-project-cache-' + source.cacheKey.slice(7),
            sourceDirectoryModified: false,
            hostEnvironmentModified: false,
            savedSource: {
              project: source.project,
              restoredDigest: p.sourceDigest,
            },
          },
          artifacts: [
            {
              path: 'project.zip',
              contentBase64: bytes.toString('base64'),
              sizeBytes: bytes.length,
              checksum:
                'sha256:' + createHash('sha256').update(bytes).digest('hex'),
            },
          ],
        },
      },
    });
    return { operationId, payload };
  }
  it.each(['document', 'file'] as const)(
    'continues a stopped local ZIP output from a %s parent and checks authority before cached replay',
    async (kind) => {
      const f = await setup(true, kind),
        old = f.parentZip!;
      const oldFile = await getToolBrokerFile(f.context, old.objectId, f.db);
      const oldBytes = await readArtifactBytes(f.storage, oldFile.object);
      const bytes = Buffer.from(
        zipSync({ 'main.cjs': Buffer.from('revised\n') }),
      );
      const { operationId, payload } = await stoppedZip(
        f,
        await f.create(),
        bytes,
      );
      expect(payload.arguments.outputs?.[0]).not.toHaveProperty(
        'parentObjectId',
      );
      expect(f.projectSelection?.originalArguments).toMatchObject({
        outputs: [{ parentObjectId: old.objectId }],
      });
      const publish = () =>
        publishLocalProjectArtifacts(
          { context: f.context, operationId },
          f.storage,
          f.db,
        );
      const raced = await raceProjectPublications({
        db: f.db,
        storage: f.storage,
        organizationId: f.org,
        workspaceId: f.workspace,
        first: publish,
        second: publish,
      });
      expect(raced.blocked.holder).not.toBe(raced.blocked.waiter);
      if (
        raced.results[0]!.status !== 'fulfilled' ||
        raced.results[1]!.status !== 'fulfilled'
      )
        throw Error('Exact operation replay rejected');
      const result = raced.results[0]!.value,
        next = result[0]!;
      expect(raced.results[1]!.value).toEqual(result);
      expect(await publish()).toEqual(result);
      const rows =
        await f.db`select v.id,v.series_id,v.version,v.parent_version_id,v.format,v.file_name,a.kind
        from allrice_deliverable_versions v join allrice_workbench_artifacts a on a.version_id=v.id
        where v.object_id=any(${[old.objectId, next.objectId]}::uuid[]) order by v.version`;
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        series_id: rows[0]!.series_id,
        version: 2,
        parent_version_id: rows[0]!.id,
        format: 'zip',
        file_name: 'project-v2.zip',
        kind,
      });
      const nextFile = await getToolBrokerFile(f.context, next.objectId, f.db);
      expect(nextFile.object).toMatchObject({
        mediaType: 'application/zip',
        immutable: true,
      });
      expect(await readArtifactBytes(f.storage, nextFile.object)).toEqual(
        bytes,
      );
      expect(await readArtifactBytes(f.storage, oldFile.object)).toEqual(
        oldBytes,
      );

      const alternative = (await executeProjectWorkspace(
        {
          context: f.context,
          sessionId: f.task.chatSessionId!,
          worker: f.worker,
          callId: randomUUID(),
          arguments: { action: 'deliver', project: f.project },
        },
        f.storage,
        f.db,
      )) as { artifacts: { fileName: string; objectId: string }[] };
      const changed = structuredClone(payload);
      changed.arguments.outputs![0]!.parentObjectId =
        alternative.artifacts.find(
          (a) => a.fileName === 'project-source.zip',
        )!.objectId;
      await expect(
        f.db`update allrice_runtime_operations set bridge_payload=${f.db.json(changed)}
          where id=${operationId}`,
      ).rejects.toThrow(
        'runtime operation identity and dispatch inputs are immutable',
      );
      const [unchanged] =
        await f.db`select bridge_payload from allrice_runtime_operations where id=${operationId}`;
      expect(unchanged!.bridge_payload).toEqual(payload);
      expect(await publish()).toEqual(result);
      await f.db`update allrice_storage_objects set retention_until=created_at+interval '1 microsecond'
        where id=${old.objectId}`;
      await expect(publish()).rejects.toThrow();
      await f.db`update allrice_storage_objects set retention_until=null where id=${old.objectId}`;
      await f.db`update allrice_jobs set cancel_requested_at=clock_timestamp()
        where id=${f.context.jobId}`;
      await expect(publish()).rejects.toThrow();
    },
  );

  it('rejects a second distinct local operation that races the same latest parent', async () => {
    const f = await setup(true, 'file');
    const parent = f.parentZip!;
    const operations: Awaited<ReturnType<typeof stoppedZip>>[] = [];
    for (let i = 0; i < 2; i++) {
      const callId = randomUUID();
      const projectSelection = await selectProjectExecution(
        {
          context: f.context,
          callId,
          arguments: { action: 'execute', ...f.args },
          worker: f.worker,
          cloudReady: false,
        },
        f.db,
      );
      const op = await f.create({ callId, projectSelection });
      operations.push(
        await stoppedZip(
          f,
          op,
          Buffer.from(zipSync({ 'main.cjs': Buffer.from('race ' + i) })),
        ),
      );
    }
    const publish = (index: number) =>
      publishLocalProjectArtifacts(
        { context: f.context, operationId: operations[index]!.operationId },
        f.storage,
        f.db,
      );
    const raced = await raceProjectPublications({
      db: f.db,
      storage: f.storage,
      organizationId: f.org,
      workspaceId: f.workspace,
      first: () => publish(0),
      second: () => publish(1),
    });
    expect(raced.blocked.holder).not.toBe(raced.blocked.waiter);
    expect(raced.results.filter((r) => r.status === 'fulfilled')).toHaveLength(
      1,
    );
    const failed = raced.results.find((r) => r.status === 'rejected');
    expect(failed?.status === 'rejected' && String(failed.reason)).toContain(
      'project_output_parent_stale',
    );
    const versions =
      await f.db`select version from allrice_deliverable_versions where series_id=(select series_id from allrice_deliverable_versions where id=${parent.versionId}) order by version`;
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });
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
