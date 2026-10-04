/** Real isolated PostgreSQL; physical runsc/Bridge evidence is collected separately. */
import { writeFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
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
  listWorkbenchArtifacts,
  readArtifactBytes,
} from './artifact-review.ts';
import { getToolBrokerFile } from './execution/tool-broker.ts';
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
    async function setup(cloud = true, knownBug = false) {
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
        {
          path: 'main.cjs',
          text: knownBug
            ? 'module.exports=(a,b)=>a-b;\n'
            : "console.log('saved-project:42')\n",
        },
        ...(knownBug
          ? [
              {
                path: 'verify.cjs',
                text: "const assert=require('node:assert/strict'),fs=require('node:fs'),add=require('./main.cjs');assert.equal(add(20,22),42);fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<!doctype html><meta charset=\"utf-8\"><title>Known bug verified</title><button onclick=\"document.querySelector(\\\"output\\\").textContent=20+22\">Compute</button><output>42</output>');console.log('original assertion passed:42');\n",
              },
            ]
          : []),
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
            createHash('sha256')
              .update(files.find((f) => f.path === 'pnpm-lock.yaml')!.text)
              .digest('hex'),
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
        opened,
      };
    }
    it.runIf(process.env.ALLRICE_RUN_PROJECT_CLOUD_INTEGRATION === '1')(
      'first closed loop: known error -> actual runsc failure -> source fix -> original assertion -> details/private static + source download',
      async () => {
        const f = await setup(true, true);
        await f.setState('offline');
        const backend = new CloudRunnerBackend();
        let args = {
          ...f.args,
          limits: { ...f.args.limits, timeoutMs: 30000 },
          args: ['verify.cjs'],
          outputs: [
            {
              path: 'dist/index.html',
              fileName: 'index.html',
              format: 'html' as const,
            },
          ],
        };
        const execute = async () => {
          const callId = randomUUID(),
            selection = await selectProjectExecution(
              {
                context: f.context,
                callId,
                arguments: args,
                worker: f.worker,
                cloudReady: true,
              },
              f.db,
            );
          const created = await createCloudProjectOperation(
            {
              context: f.context,
              callId,
              projectSelection: selection,
              worker: f.worker,
              storage: f.storage,
            },
            f.db,
          );
          let result;
          try {
            result = await runCloudCommandOperation(created, {
              database: f.db,
              storage: f.storage,
              backend,
            });
          } catch (error) {
            if (process.env.ALLRICE_PROJECT_FIRST_LOOP_EVIDENCE)
              await writeFile(
                process.env.ALLRICE_PROJECT_FIRST_LOOP_EVIDENCE,
                JSON.stringify(
                  {
                    error: String(error),
                    operations:
                      await f.db`select snapshot from allrice_runtime_operations where run_id=${f.rootRunId}`,
                    receipts:
                      await f.db`select disposition,payload->'signal' as signal from allrice_runtime_operation_receipts where operation_id=${created.snapshot.binding.attempt.operationId}`,
                    attempts:
                      await f.db`select outcome from allrice_cloud_execution_attempts where operation_id=${created.snapshot.binding.attempt.operationId}`,
                  },
                  null,
                  2,
                ),
              );
            throw error;
          }
          return {
            result,
            operationId: created.snapshot.binding.attempt.operationId,
          };
        };
        const failed = await execute();
        expect(failed.result.status).toBe('failed');
        expect(failed.result.output).toContain('AssertionError');
        expect(failed.result.artifacts).toEqual([]);
        const saved = (await executeProjectWorkspace(
          {
            context: f.context,
            sessionId: f.task.chatSessionId!,
            callId: randomUUID(),
            worker: f.worker,
            arguments: {
              action: 'apply',
              expectedHead: args.project,
              proposal: {
                files: [
                  {
                    path: 'main.cjs',
                    before: 'module.exports=(a,b)=>a-b;\n',
                    after: 'module.exports=(a,b)=>a+b;\n',
                  },
                ],
              },
            },
          },
          f.storage,
          f.db,
        )) as { project: unknown; sourceDigest: string };
        args = {
          ...args,
          project: ProjectVersionRefSchema.parse(saved.project),
          projectPreparation: {
            ...args.projectPreparation,
            sourceDigest: saved.sourceDigest,
          },
        };
        const passed = await execute();
        expect(passed.result.status).toBe('succeeded');
        expect(passed.result.output).toContain('original assertion passed:42');
        expect(passed.result.artifacts).toHaveLength(1);
        const detail = await listCloudRuntimeOperations(
          f.requestContext,
          f.rootRunId,
          f.db,
        );
        expect(
          detail.find(
            (o) =>
              o.snapshot.binding.attempt.operationId === passed.operationId,
          )?.proposal,
        ).toMatchObject({
          kind: 'project',
          project: args.project,
          outputs: args.outputs,
        });
        const delivered = (await executeProjectWorkspace(
          {
            context: f.context,
            sessionId: f.task.chatSessionId!,
            worker: f.worker,
            callId: randomUUID(),
            arguments: {
              action: 'deliver',
              project: args.project,
              baseline: f.args.project,
            },
          },
          f.storage,
          f.db,
        )) as {
          artifacts: { objectId: string; fileName: string }[];
          report: { executions: { status: string }[] };
        };
        expect(delivered.report.executions.map((r) => r.status)).toEqual([
          'failed',
          'succeeded',
        ]);
        const listed = await listWorkbenchArtifacts(
          {
            actor: { type: 'user', id: f.user },
            organizationId: f.org,
            workspaceId: f.workspace,
          },
          f.task.chatSessionId!,
          undefined,
          f.db,
        );
        expect(listed.artifacts).toHaveLength(4);
        const archive = delivered.artifacts.find(
          (a) => a.fileName === 'project-source.zip',
        )!;
        const { object } = await getToolBrokerFile(
          f.context,
          archive.objectId,
          f.db,
        );
        const zip = unzipSync(await readArtifactBytes(f.storage, object));
        expect(Buffer.from(zip['main.cjs']!).toString()).toBe(
          'module.exports=(a,b)=>a+b;\n',
        );
        expect(Buffer.from(zip['verify.cjs']!).toString()).toContain(
          'assert.equal(add(20,22),42)',
        );
        const html = passed.result.artifacts[0]!,
          stored = await getToolBrokerFile(f.context, html.objectId, f.db);
        expect(
          (await readArtifactBytes(f.storage, stored.object)).toString(),
        ).toContain('<output>42</output>');
        const other = await setup();
        await expect(
          listCloudRuntimeOperations(other.requestContext, f.rootRunId, f.db),
        ).rejects.toThrow();
        await expect(
          getToolBrokerFile(other.context, html.objectId, f.db),
        ).rejects.toThrow();
      },
      120000,
    );
    it('shares an eight-call and elapsed budget across projects, preserves same-call replay and read/delivery', async () => {
      const f = await setup();
      let replayInput: Parameters<typeof selectProjectExecution>[0] | undefined;
      for (let i = 0; i < 8; i++) {
        const input = {
          context: f.context,
          callId: randomUUID(),
          arguments: f.args,
          worker: f.worker,
          cloudReady: true,
        };
        const selected = await selectProjectExecution(input, f.db);
        expect(selected.choice.location).toBe('local');
        replayInput = input;
      }
      expect(
        (await selectProjectExecution(replayInput!, f.db)).choice.location,
      ).toBe('local');
      await expect(
        selectProjectExecution({ ...replayInput!, callId: randomUUID() }, f.db),
      ).rejects.toThrow('project_workflow_budget_exhausted');
      const g = await setup();
      await g.select();
      await g.db`update allrice_audit_events set occurred_at=clock_timestamp()-interval '31 minutes' where action='execution.location' and metadata->>'runId'=${g.rootRunId}`;
      await expect(
        selectProjectExecution(
          {
            context: g.context,
            callId: randomUUID(),
            arguments: g.args,
            worker: g.worker,
            cloudReady: true,
          },
          g.db,
        ),
      ).rejects.toThrow('project_workflow_budget_exhausted');
      expect(
        await executeProjectWorkspace(
          {
            context: g.context,
            sessionId: g.task.chatSessionId!,
            worker: g.worker,
            callId: randomUUID(),
            arguments: { action: 'deliver', project: g.args.project },
          },
          g.storage,
          g.db,
        ),
      ).toHaveProperty('artifacts');
    });
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
    it('records a finite project deadline as a failed check, settles it once and permits the next check in the same Run', async () => {
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
      // Synthetic physical port: this tests persisted receipt/Run semantics,
      // not a native VM timeout. The real deadline has separate evidence.
      class FiniteDeadline extends CloudRunnerBackend {
        executions = 0;
        override async execute(
          payload: Parameters<CloudRunnerBackend['execute']>[0],
        ) {
          this.executions++;
          if (!('kind' in payload)) throw Error('Project required');
          const a = payload.arguments,
            s = a.projectSource,
            p = a.projectPreparation;
          return {
            containerId: 'a'.repeat(64),
            exitCode: null,
            stopped: true as const,
            reason: 'deadline' as const,
            output: 'verification deadline',
            artifacts: [],
            elapsedMs: 1000,
            imageDigest: payload.imageDigest,
            projectPreparation: {
              version: 1 as const,
              projectId: p.projectId,
              sourceDigest: p.sourceDigest,
              lockChecksum: p.lockChecksum,
              cacheKey: s.cacheKey,
              manager: p.manager,
              managerVersion: p.managerVersion,
              platform: 'linux-amd64' as const,
              runtimeImage: payload.imageDigest,
              packageCount: p.packages.length,
              archiveHits: 0,
              downloadedArchives: 0,
              downloadedBytes: 0,
              installation: 'interrupted' as const,
              cacheVolume: `allrice-project-cache-${s.cacheKey.slice(7)}`,
              sourceDirectoryModified: false as const,
              hostEnvironmentModified: false as const,
              savedSource: {
                project: s.project,
                restoredDigest: p.sourceDigest,
              },
            },
          };
        }
        override async cleanup() {}
      }
      const backend = new FiniteDeadline(),
        options = { database: f.db, storage: f.storage, backend };
      expect((await runCloudCommandOperation(created, options)).status).toBe(
        'failed',
      );
      expect((await runCloudCommandOperation(created, options)).status).toBe(
        'failed',
      );
      expect(backend.executions).toBe(1);
      const [root] =
        await f.db`select cancel_request_id from allrice_runtime_roots where root_run_id=${f.rootRunId}`;
      expect(root!.cancel_request_id).toBeNull();
      const [receipt] =
        await f.db`select payload,disposition from allrice_runtime_operation_receipts where operation_id=${created.snapshot.binding.attempt.operationId} and payload->'signal'->>'type'='operation.outcome'`;
      expect(receipt!.disposition).toBe('applied');
      expect(receipt!.payload.signal.result.status).toBe('failed');
      const [usage] =
        await f.db`select observation from allrice_runtime_reservations where operation_id=${created.snapshot.binding.attempt.operationId} and metric='tool_calls'`;
      expect(usage!.observation).toMatchObject({ amount: 1, state: 'settled' });
      expect(
        (
          await selectProjectExecution(
            {
              context: f.context,
              callId: randomUUID(),
              arguments: f.args,
              worker: f.worker,
              cloudReady: true,
            },
            f.db,
          )
        ).choice.status,
      ).toBe('execute');
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
