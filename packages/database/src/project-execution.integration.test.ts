/** Real isolated PostgreSQL; physical runsc/Bridge evidence is collected separately. */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ProjectVersionRefSchema,
  CloudExecutionProfileSchema,
  cloudToolchainImageV1,
  RuntimeLocalCommandSchema,
  managedPythonPayloadForPlatform,
  type ProjectExecuteInput,
  type BridgeReadinessState,
} from '@allrice/contracts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from './assistant-runtime.fixture.ts';
import { createAssistantLocalCommandFixture } from './local-command-assistant.fixture.ts';
import { executeProjectWorkspace } from './project-workspace.ts';
import { reportLocalCommandProfile } from './local-command-profile.ts';
import { listCloudRuntimeOperations } from './cloud-operation-view.ts';
import { selectProjectExecution } from './project-execution.ts';
import { createLocalCommandOperation } from './local-command-service.ts';
import { createCloudProjectOperation } from './cloud-execution.ts';
import {
  CloudRunnerBackend,
  CloudProjectPreparationError,
} from '../../../apps/worker/src/cloud-runner/backend.js';
import {
  runCloudCommandOperation,
  recoverCloudCommandOperations,
} from '../../../apps/worker/src/cloud-runner/executor.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET166 PR3c canonical saved-project location and original Worker — real PostgreSQL',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      for (const key of [
        'ASSISTANTS',
        'WORKBENCH',
        'RUNTIME_POLICY',
        'BRIDGE_OPERATION_LEDGER',
        'LOCAL_COMMAND',
        'CLOUD_RUNNER',
      ])
        vi.stubEnv(`ALLRICE_${key}_ENABLED`, '1');
      database = await createAssistantFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      await database?.close();
      vi.unstubAllEnvs();
    });
    async function setup(cloud = true) {
      const f = await createAssistantLocalCommandFixture(
        database.db,
        'allow',
        false,
        { skipChild: true, projectWorkspace: true, projectCloud: cloud },
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
      const project = ProjectVersionRefSchema.parse(opened.project),
        target = randomUUID(),
        grant = randomUUID();
      const profile = CloudExecutionProfileSchema.parse({
        backend: 'cloud-gvisor-v1',
        runtime: 'runsc',
        architecture: 'amd64',
        imageDigest: cloudToolchainImageV1,
        network: 'none',
        maximumConcurrency: 2,
        runtimeVersion: 'release-20260831.0',
        runtimeChecksum:
          'sha256:1a4995a70b3c8b7d36f55d7d2dc6d15185ebe420de653b1a330b42d36c0e6b4a',
      });
      await f.db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities,metadata)
      values(${target},${f.org},${f.workspace},${'project-cloud-' + target},'cloud_sandbox','Synthetic isolated project cloud','online',${f.db.json(['process.execute'])},'{}')`;
      await f.db`insert into allrice_cloud_execution_grants(id,organization_id,workspace_id,owner_id,target_id,version,profile,enabled)
      values(${grant},${f.org},${f.workspace},${f.user},${target},1,${f.db.json(profile)},true)`;
      await reportLocalCommandProfile(
        f.device,
        {
          contractVersion: 1,
          backend: 'local-vm-container-v1',
          imageDigest: cloudToolchainImageV1,
          architecture: 'amd64',
          available: true,
          features: ['project_preparation', 'saved_project_source'],
          projectPreparation: {
            version: 1,
            available: true,
            nodeImage: cloudToolchainImageV1,
            pythonImage: managedPythonPayloadForPlatform('macos-x64')!.imageId,
            pnpmVersion: '10.33.3',
            uvVersion: '0.8.22',
          },
        },
        f.db,
      );
      const setState = async (state: BridgeReadinessState) => {
        const environment = {
          version: 1,
          clientVersion: '0.6.0-dev.30',
          browser: 'unavailable',
          sandbox: 'ready',
          preview: 'unavailable',
          paused: false,
          readiness: [
            {
              capability: 'local.process',
              state,
              reason: 'synthetic_' + state,
              missing: [],
              versions: {},
              observedAt: new Date().toISOString(),
            },
          ],
        };
        await f.db`update allrice_execution_targets set metadata=jsonb_set(metadata,'{environment}',${f.db.json(environment)}) where target_key=${'bridge.' + f.device.id}`;
        await f.db`update allrice_bridge_devices set last_seen_at=${state === 'offline' ? new Date(Date.now() - 120000) : new Date()} where id=${f.device.id}`;
      };
      await setState('ready');
      const args: ProjectExecuteInput = {
        action: 'execute',
        project,
        executable: '/usr/local/bin/node',
        args: ['main.cjs'],
        path: '.',
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
          lockChecksum:
            'sha256:' +
            createHash('sha256').update(files[2]!.text).digest('hex'),
          offline: true,
          manager: 'pnpm',
          managerVersion: '10.33.3',
          lockPath: 'pnpm-lock.yaml',
          scripts: 'disabled',
          packages: [],
        },
      };
      const callId = randomUUID();
      const select = (cloudReady = true, arguments_: unknown = args) =>
        selectProjectExecution(
          {
            context: f.context,
            callId,
            arguments: arguments_,
            worker,
            cloudReady,
          },
          f.db,
        );
      const countCloud = async () =>
        Number(
          (
            await f.db`select count(*) as n from allrice_cloud_execution_inputs where run_id=${f.rootRunId}`
          )[0]!.n,
        );
      const request = async (text: string) => {
        await f.db`update allrice_messages set content=${f.db.json({ text, citations: [] })} where id=(select user_message_id from allrice_employee_runs where run_id=${f.rootRunId})`;
      };
      return {
        ...f,
        storage,
        worker,
        args,
        callId,
        setState,
        select,
        countCloud,
        request,
        cloudTarget: target,
        cloudGrant: grant,
      };
    }
    it('chooses the ready local target, keeps original call/source/Worker, and creates one operation on replay', async () => {
      const f = await setup(),
        selection = await f.select();
      expect(selection.choice).toMatchObject({
        location: 'local',
        status: 'execute',
        reason: 'local_ready',
      });
      await f.db`update allrice_bridge_folder_grants set revoked_at=clock_timestamp() where device_id=${f.device.id}`;
      const arguments_ = {
        project: f.args.project,
        executable: f.args.executable,
        args: f.args.args,
        path: f.args.path,
        projectPreparation: f.args.projectPreparation,
        limits: f.args.limits,
      };
      const input = {
        context: f.context,
        arguments: arguments_,
        callId: f.callId,
        worker: f.worker,
        storage: f.storage,
        projectSelection: selection,
      };
      const op = await createLocalCommandOperation(input, f.db),
        replay = await createLocalCommandOperation(input, f.db);
      expect(replay.snapshot.binding.attempt.operationId).toBe(
        op.snapshot.binding.attempt.operationId,
      );
      expect(op.snapshot.binding.execution.deviceId).toBe(selection.deviceId);
      const [stored] =
        await f.db`select bridge_payload from allrice_runtime_operations where id=${op.snapshot.binding.attempt.operationId}`;
      const payload = RuntimeLocalCommandSchema.parse(stored!.bridge_payload);
      expect(payload.arguments.projectSource!.executionOrigin).toEqual({
        toolName: 'workspace.project',
        callId: f.callId,
        argumentsDigest: selection.argumentsDigest,
        selectionId: selection.selectionId,
      });
      expect(await f.countCloud()).toBe(0);
      await f.setState('offline');
      expect((await f.select()).choice).toMatchObject({
        location: 'local',
        status: 'unavailable',
      });
      expect(await f.countCloud()).toBe(0);
    });
    it.each(['busy', 'preparing'] as const)(
      'keeps %s local waits and never creates cloud input',
      async (state) => {
        const f = await setup();
        await f.setState(state);
        expect((await f.select()).choice).toMatchObject({
          location: 'local',
          status: 'wait',
        });
        expect(await f.countCloud()).toBe(0);
        await f.setState('offline');
        expect((await f.select()).choice).toMatchObject({
          location: 'local',
          status: 'unavailable',
        });
        expect(await f.countCloud()).toBe(0);
      },
    );
    it('allows offline supplementation, binds exact private transfer, and preserves one canonical operation', async () => {
      const f = await setup();
      await f.setState('offline');
      expect((await f.select(false)).choice.location).toBe('none');
      const selection = await f.select();
      expect(selection.choice).toMatchObject({
        location: 'cloud',
        status: 'execute',
      });
      const created = await createCloudProjectOperation(
        {
          context: f.context,
          callId: f.callId,
          projectSelection: selection,
          worker: f.worker,
          storage: f.storage,
        },
        f.db,
      );
      expect(created.payload.arguments.projectSource.project).toEqual(
        f.args.project,
      );
      expect(created.payload.arguments.projectSource.origin).toEqual(
        selection.workerOrigin,
      );
      expect(created.snapshot.binding.baseline).toEqual([
        f.args.project.snapshot,
      ]);
      expect(created.snapshot.binding.dataScope[0]).toMatchObject({
        destination: 'cloud_execution',
        content: f.args.project.snapshot,
      });
      const [view] = await listCloudRuntimeOperations(
        f.requestContext,
        f.rootRunId,
        f.db,
      );
      expect(view!.proposal).toMatchObject({
        kind: 'project',
        project: f.args.project,
        executable: f.args.executable,
        args: f.args.args,
        sourceDigest: f.args.projectPreparation.sourceDigest,
      });
      expect(JSON.stringify(view)).not.toContain('contentBase64');
      expect(JSON.stringify(view)).not.toContain('leaseTokenDigest');
      expect(JSON.stringify(view)).not.toContain('executionOrigin');
      await expect(
        listCloudRuntimeOperations(
          { ...f.requestContext, actor: { type: 'user', id: randomUUID() } },
          f.rootRunId,
          f.db,
        ),
      ).rejects.toThrow('run_not_owned');
      const replay = await createCloudProjectOperation(
        {
          context: f.context,
          callId: f.callId,
          projectSelection: selection,
          worker: f.worker,
          storage: f.storage,
        },
        f.db,
      );
      expect(replay.snapshot.binding.attempt.operationId).toBe(
        created.snapshot.binding.attempt.operationId,
      );
      expect(await f.countCloud()).toBe(1);
      await f.setState('ready');
      expect((await f.select()).choice.location).toBe('cloud');
      expect(await f.countCloud()).toBe(1);
    });
    it('does not persist a premature explicit-cloud binding before actual physical discovery', async () => {
      const f = await setup();
      await f.request('请在云端执行这个已保存的项目');
      expect((await f.select(false)).choice.status).toBe('unavailable');
      const ready = await f.select();
      expect(ready.grantId).toBe(f.cloudGrant);
      expect(ready.profileDigest).toBeTruthy();
      expect(ready.choice.location).toBe('cloud');
    });
    it('ignores a model cloud preference when local is ready, but honors real user local-only input', async () => {
      const f = await setup();
      expect(
        (await f.select(true, { ...f.args, location: 'cloud' })).choice
          .location,
      ).toBe('local');
      const g = await setup();
      await g.request('只在本地运行，不要上传到云端');
      await g.setState('offline');
      expect((await g.select()).choice).toMatchObject({
        location: 'local',
        status: 'unavailable',
      });
      expect(await g.countCloud()).toBe(0);
    });
    it('requires the selected backend in the frozen employee tools', async () => {
      const f = await setup(false);
      await f.setState('offline');
      expect((await f.select()).choice).toMatchObject({
        location: 'none',
        status: 'unavailable',
      });
      expect(await f.countCloud()).toBe(0);
    });
    it('retains unknown create journals across replay and recovery without a second execute or premature cleanup', async () => {
      const f = await setup();
      await f.setState('offline');
      const created = await createCloudProjectOperation(
        {
          context: f.context,
          callId: f.callId,
          projectSelection: await f.select(),
          worker: f.worker,
          storage: f.storage,
        },
        f.db,
      );
      class MissingCreateAck extends CloudRunnerBackend {
        executions = 0;
        cleanups = 0;
        override async inspect() {
          return null;
        }
        override async execute(): Promise<never> {
          this.executions++;
          throw Error('CLOUD_DAEMON_TIMEOUT');
        }
        override async cleanup() {
          this.cleanups++;
        }
      }
      const backend = new MissingCreateAck();
      const options = { database: f.db, storage: f.storage, backend };
      expect((await runCloudCommandOperation(created, options)).status).toBe(
        'unknown',
      );
      expect((await runCloudCommandOperation(created, options)).status).toBe(
        'unknown',
      );
      expect(backend.executions).toBe(1);
      await f.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.context.jobId}`;
      await recoverCloudCommandOperations({ database: f.db, backend });
      const [journal] =
        await f.db`select cleanup_confirmed_at,outcome from allrice_cloud_execution_attempts where operation_id=${created.snapshot.binding.attempt.operationId}`;
      expect(journal!.cleanup_confirmed_at).toBeNull();
      expect(journal!.outcome).toBeNull();
      expect(backend.cleanups).toBe(0);
      expect(backend.executions).toBe(1);
    });
    it('records an explicit pre-create failure and reclaims its named work volume before confirming cleanup', async () => {
      const f = await setup();
      await f.setState('offline');
      const created = await createCloudProjectOperation(
        {
          context: f.context,
          callId: f.callId,
          projectSelection: await f.select(),
          worker: f.worker,
          storage: f.storage,
        },
        f.db,
      );
      class RejectedCreate extends CloudRunnerBackend {
        cleanups = 0;
        override async inspect() {
          return null;
        }
        override async execute(): Promise<never> {
          throw new CloudProjectPreparationError('CLOUD_DAEMON_400');
        }
        override async cleanup() {
          this.cleanups++;
        }
      }
      const backend = new RejectedCreate();
      const result = await runCloudCommandOperation(created, {
        database: f.db,
        storage: f.storage,
        backend,
      });
      expect(result.status).toBe('failed');
      expect(backend.cleanups).toBe(1);
      const [journal] =
        await f.db`select cleanup_confirmed_at,outcome from allrice_cloud_execution_attempts where operation_id=${created.snapshot.binding.attempt.operationId}`;
      expect(journal!.cleanup_confirmed_at).not.toBeNull();
      expect(journal!.outcome).toMatchObject({
        containerId: '',
        stopped: true,
        reason: 'failed',
        errorCode: 'CLOUD_DAEMON_400',
      });
    });
    it('rejects a changed canonical call and old Worker before creating another backend input', async () => {
      const f = await setup();
      await f.setState('offline');
      const selected = await f.select();
      await expect(
        f.select(true, { ...f.args, args: ['other.cjs'] }),
      ).rejects.toThrow('idempotency_conflict');
      await expect(
        createCloudProjectOperation(
          {
            context: f.context,
            callId: f.callId,
            projectSelection: selected,
            worker: { ...f.worker, leaseToken: randomUUID() },
            storage: f.storage,
          },
          f.db,
        ),
      ).rejects.toThrow('project_execution_origin_changed');
      await f.db`update allrice_jobs set attempt=attempt+1,lease_token=${randomUUID()} where id=${f.context.jobId}`;
      await expect(
        createCloudProjectOperation(
          {
            context: f.context,
            callId: f.callId,
            projectSelection: selected,
            worker: f.worker,
            storage: f.storage,
          },
          f.db,
        ),
      ).rejects.toThrow('cloud_worker_lease_changed');
      expect(await f.countCloud()).toBe(0);
    });
  },
);
