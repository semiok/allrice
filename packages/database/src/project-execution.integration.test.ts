/** Real isolated PostgreSQL; physical runsc/Bridge evidence is collected separately. */
import { writeFile } from 'node:fs/promises';
import { unzipSync, zipSync } from 'fflate';
import { raceProjectPublications } from './project-output-parent.fixture.ts';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ProjectVersionRefSchema,
  CloudExecutionProfileSchema,
  cloudToolchainImageV1,
  RuntimeLocalCommandSchema,
  managedPythonPayloadForPlatform,
  resolveSandboxExecutionPolicy,
  type SandboxExecutionPolicy,
  type ProjectExecuteInput,
  type StorageObject,
  type StoragePort,
  type BridgeReadinessState,
  cloudPlatform,
} from '@allrice/contracts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from './assistant-runtime.fixture.ts';
import { createAssistantLocalCommandFixture } from './local-command-assistant.fixture.ts';
import { executeProjectWorkspace } from './project-workspace.ts';
import { reportLocalCommandProfile } from './local-command-profile.ts';
import { listCloudRuntimeOperations } from './cloud-operation-view.ts';
import {
  selectProjectExecution,
  readProjectWorkflowBudget,
} from './project-execution.ts';
import { createLocalCommandOperation } from './local-command-service.ts';
import {
  createCloudProjectOperation,
  createCloudOperationLedger,
  cloudStableId,
  publishCloudOperationArtifacts,
} from './cloud-execution.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
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

// Authority/lifecycle tests use a deterministic reputation port; the checker
// itself has separate real-DNS acceptance and refusal/cache regressions.
const admission = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./sandbox-network-admission.ts', () => ({
  assertAutomaticSandboxNetwork: admission,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

async function readCloudPublicationState(
  db: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>['db'],
  rootRunId: string,
  sessionId: string,
  operationIds: string[],
  objectIds: string[],
) {
  const [
    attempts,
    receipts,
    reservations,
    budgets,
    versions,
    artifacts,
    objects,
    operations,
    events,
  ] = await Promise.all([
    db`select operation_id,outcome,artifacts,cleanup_confirmed_at from allrice_cloud_execution_attempts
        where operation_id=any(${operationIds}::uuid[]) order by operation_id`,
    db`select receipt_id,operation_id,payload,disposition from allrice_runtime_operation_receipts
        where operation_id=any(${operationIds}::uuid[]) order by operation_id,receipt_id`,
    db`select operation_id,metric,accounting_id,amount,settled_amount,observation_id,observation
        from allrice_runtime_reservations where operation_id=any(${operationIds}::uuid[]) order by operation_id,metric`,
    db`select metric,source,reserved,spent from allrice_runtime_budgets where root_run_id=${rootRunId} order by metric`,
    db`select id,object_id,series_id,version,parent_version_id,format,file_name from allrice_deliverable_versions
        where session_id=${sessionId} order by series_id,version`,
    db`select version_id,provenance from allrice_workbench_artifacts
        where provenance->>'operationId'=any(${operationIds}::text[]) order by version_id`,
    db`select id,object_key,media_type,size_bytes,checksum,state,immutable from allrice_storage_objects
        where id=any(${objectIds}::uuid[]) order by id`,
    db`select id,snapshot->>'status' as status,snapshot from allrice_runtime_operations where id=any(${operationIds}::uuid[]) order by id`,
    db`select operation_id,sequence,payload from allrice_runtime_operation_events
        where operation_id=any(${operationIds}::uuid[]) order by operation_id,sequence`,
  ]);
  return {
    attempts: [...attempts],
    receipts: [...receipts],
    reservations: [...reservations],
    budgets: [...budgets],
    versions: [...versions],
    artifacts: [...artifacts],
    objects: [...objects],
    operations: [...operations],
    events: [...events],
  };
}

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
      if (database)
        console.info('Saved-project fixture cleanup', await database.close());
      vi.unstubAllEnvs();
    });
    async function setup(
      cloud = true,
      knownBug = false,
      sandbox: {
        policy?: SandboxExecutionPolicy;
        network?: boolean;
        allowInputTransfer?: boolean;
        outbound?: boolean;
      } = {},
    ) {
      const f = await createAssistantLocalCommandFixture(
        database.db,
        'allow',
        false,
        {
          skipChild: true,
          projectWorkspace: true,
          projectCloud: cloud,
          snapshot: (s) => ({
            ...s,
            ...(sandbox.policy
              ? { sandboxExecutionPolicy: sandbox.policy }
              : {}),
            capabilitySnapshot: {
              ...s.capabilitySnapshot,
              grantedCapabilities:
                sandbox.outbound === false
                  ? s.capabilitySnapshot.grantedCapabilities.filter(
                      (c) => c !== 'network:outbound',
                    )
                  : s.capabilitySnapshot.grantedCapabilities,
            },
          }),
        },
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
        architecture: cloudPlatform.architecture,
        imageDigest: cloudToolchainImageV1,
        network: 'none',
        ...(sandbox.network
          ? {
              sandboxNetwork: {
                version: 1,
                mode: 'controlled_https',
                origins: ['https://registry.npmjs.org'],
                allowInputTransfer: sandbox.allowInputTransfer !== false,
              },
            }
          : {}),
        maximumConcurrency: 2,
        runtimeVersion: 'release-20260831.0',
        runtimeChecksum: cloudPlatform.runtimeChecksum,
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
      const approveCloud = async (
        created: Awaited<ReturnType<typeof createCloudProjectOperation>>,
      ) => {
        const views = await listCloudRuntimeOperations(
          f.requestContext,
          f.rootRunId,
          f.db,
        );
        const view = views.find(
          (v) =>
            v.snapshot.binding.attempt.operationId ===
            created.snapshot.binding.attempt.operationId,
        );
        if (view?.approval) await f.approve(view.approval.request);
      };
      return {
        ...f,
        approveCloud,
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

    class CapturedProjectZip extends CloudRunnerBackend {
      executions = 0;
      constructor(readonly bytes: Buffer) {
        super();
      }
      override async inspect() {
        return null;
      }
      override async cleanup() {}
      override async execute(
        payload: Parameters<CloudRunnerBackend['execute']>[0],
      ) {
        this.executions++;
        if (!('kind' in payload)) throw Error('Project payload required');
        const a = payload.arguments,
          p = a.projectPreparation,
          source = a.projectSource;
        return {
          containerId: 'a'.repeat(64),
          exitCode: 0,
          stopped: true as const,
          reason: 'completed' as const,
          output: 'synthetic stopped ZIP receipt',
          elapsedMs: 1,
          imageDigest: payload.imageDigest,
          artifacts: [
            {
              path: 'project.zip',
              contentBase64: this.bytes.toString('base64'),
              sizeBytes: this.bytes.length,
              checksum:
                'sha256:' +
                createHash('sha256').update(this.bytes).digest('hex'),
            },
          ],
          projectPreparation: {
            version: 1 as const,
            projectId: p.projectId,
            sourceDigest: p.sourceDigest,
            lockChecksum: p.lockChecksum,
            cacheKey: source.cacheKey,
            manager: p.manager,
            managerVersion: p.managerVersion,
            platform: cloudPlatform.linuxPlatform,
            runtimeImage: payload.imageDigest,
            packageCount: p.packages.length,
            archiveHits: 0,
            downloadedArchives: 0,
            downloadedBytes: 0,
            installation: 'succeeded' as const,
            cacheVolume: 'allrice-project-cache-' + source.cacheKey.slice(7),
            sourceDirectoryModified: false as const,
            hostEnvironmentModified: false as const,
            savedSource: {
              project: source.project,
              restoredDigest: p.sourceDigest,
            },
          },
        };
      }
    }

    it.each(['file', 'document'] as const)(
      'keeps a %s ZIP parent across cloud output and source deliver; cached publication cannot bypass authority',
      async (kind) => {
        const f = await setup();
        await f.setState('offline');
        const zip1 = Buffer.from(
          zipSync({ 'main.cjs': Buffer.from('first\n') }),
        );
        const zip2 = Buffer.from(
          zipSync({ 'main.cjs': Buffer.from('second\n') }),
        );
        // A deterministic physical-result port only: no container, installer or model.
        const execute = async (bytes: Buffer, parentObjectId?: string) => {
          const callId = randomUUID(),
            args = {
              ...f.args,
              outputs: [
                {
                  path: 'project.zip',
                  fileName: parentObjectId ? 'project-v2.zip' : 'project.zip',
                  format: 'zip' as const,
                  ...(parentObjectId ? { parentObjectId } : {}),
                },
              ],
            };
          const selection = await selectProjectExecution(
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
          await f.approveCloud(created);
          const backend = new CapturedProjectZip(bytes);
          const result = await runCloudCommandOperation(created, {
            storage: f.storage,
            database: f.db,
            backend,
          });
          expect(result.status).toBe('succeeded');
          return { created, result, backend };
        };
        let old: { objectId: string; versionId: string };
        if (kind === 'file') old = (await execute(zip1)).result.artifacts[0]!;
        else {
          const delivered = (await executeProjectWorkspace(
            {
              context: f.context,
              sessionId: f.task.chatSessionId!,
              worker: f.worker,
              callId: randomUUID(),
              arguments: { action: 'deliver', project: f.args.project },
            },
            f.storage,
            f.db,
          )) as {
            artifacts: {
              objectId: string;
              versionId: string;
              fileName: string;
            }[];
          };
          old = delivered.artifacts.find(
            (a) => a.fileName === 'project-source.zip',
          )!;
        }
        const original = await getToolBrokerFile(f.context, old.objectId, f.db);
        const oldBytes = await readArtifactBytes(f.storage, original.object);
        const second = await execute(zip2, old.objectId);
        const next = second.result.artifacts[0]!;
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
        const published = await getToolBrokerFile(
          f.context,
          next.objectId,
          f.db,
        );
        expect(published.object).toMatchObject({
          mediaType: 'application/zip',
          immutable: true,
        });
        expect(await readArtifactBytes(f.storage, published.object)).toEqual(
          zip2,
        );
        expect(await readArtifactBytes(f.storage, original.object)).toEqual(
          oldBytes,
        );
        const [attempt] =
          await f.db`select outcome from allrice_cloud_execution_attempts
          where operation_id=${second.created.snapshot.binding.attempt.operationId}`;
        const publication = {
          context: f.context,
          binding: second.created.snapshot.binding,
          payload: second.created.payload,
          artifacts: attempt!.outcome.artifacts,
        };
        const replay = await publishCloudOperationArtifacts(
          publication,
          f.storage,
          f.db,
        );
        expect(replay.map((a) => a.versionId)).toEqual([next.versionId]);
        expect(second.backend.executions).toBe(1);
        const changed = structuredClone(second.created.payload);
        changed.arguments.outputs![0]!.parentObjectId = randomUUID();
        await expect(
          publishCloudOperationArtifacts(
            { ...publication, payload: changed },
            f.storage,
            f.db,
          ),
        ).rejects.toThrow('cloud_binding_changed');

        // The source ZIP can continue a file-kind generated ZIP without changing kind.
        const delivered = (await executeProjectWorkspace(
          {
            context: f.context,
            sessionId: f.task.chatSessionId!,
            worker: f.worker,
            callId: randomUUID(),
            arguments: {
              action: 'deliver',
              project: f.args.project,
              parentObjectId: next.objectId,
            },
          },
          f.storage,
          f.db,
        )) as {
          artifacts: {
            fileName: string;
            objectId: string;
            versionId: string;
          }[];
        };
        const third = delivered.artifacts.find(
          (a) => a.fileName === 'project-source.zip',
        )!;
        const [version] =
          await f.db`select v.series_id,v.version,v.parent_version_id,a.kind
          from allrice_deliverable_versions v join allrice_workbench_artifacts a on a.version_id=v.id
          where v.id=${third.versionId}`;
        expect(version).toMatchObject({
          series_id: rows[0]!.series_id,
          version: 3,
          parent_version_id: next.versionId,
          kind,
        });
        expect(
          (
            await publishCloudOperationArtifacts(publication, f.storage, f.db)
          ).map((a) => a.versionId),
        ).toEqual([next.versionId]);
        await f.db`update allrice_storage_objects set retention_until=created_at+interval '1 microsecond' where id=${old.objectId}`;
        await expect(
          publishCloudOperationArtifacts(publication, f.storage, f.db),
        ).rejects.toThrow();
        await f.db`update allrice_storage_objects set retention_until=null where id=${old.objectId}`;
        await f.db`update allrice_cloud_execution_grants set revoked_at=clock_timestamp()
          where id=${f.cloudGrant}`;
        await expect(
          publishCloudOperationArtifacts(publication, f.storage, f.db),
        ).rejects.toThrow();
      },
    );

    it.each(['completed', 'recover-before-usage'] as const)(
      'settles the losing saved-project publication against one latest ZIP — %s',
      async (stage) => {
        const f = await setup();
        await f.setState('offline');
        const db = f.db,
          context = f.context,
          rootRunId = f.rootRunId,
          sessionId = f.task.chatSessionId!;
        const delivered = (await executeProjectWorkspace(
          {
            context,
            sessionId,
            worker: f.worker,
            callId: randomUUID(),
            arguments: { action: 'deliver', project: f.args.project },
          },
          f.storage,
          db,
        )) as {
          artifacts: {
            fileName: string;
            objectId: string;
            versionId: string;
          }[];
        };
        const parent = delivered.artifacts.find(
            (artifact) => artifact.fileName === 'project-source.zip',
          )!,
          zip = Buffer.from(
            zipSync({ 'main.cjs': Buffer.from('same physical output\n') }),
          ),
          outputCases = [
            {
              path: 'project.zip',
              fileName: 'project-v2.zip',
              format: 'zip' as const,
              mediaType: 'application/zip',
              bytes: zip,
            },
            {
              path: 'index.html',
              fileName: 'index.html',
              format: 'html' as const,
              mediaType: 'text/html',
              bytes: Buffer.from('<!doctype html><p>saved output</p>'),
            },
            {
              path: 'summary.json',
              fileName: 'summary.json',
              format: 'json' as const,
              mediaType: 'application/json',
              bytes: Buffer.from('{"amountCents":250}\n'),
            },
            {
              path: 'notes.txt',
              fileName: 'notes.txt',
              format: 'text' as const,
              mediaType: 'text/plain',
              bytes: Buffer.from('saved output\n'),
            },
          ],
          outputs = outputCases.map(({ path, fileName, format }, index) => ({
            path,
            fileName,
            format,
            ...(index === 0 ? { parentObjectId: parent.objectId } : {}),
          })),
          captured = outputCases.map(({ path, bytes }) => ({
            path,
            contentBase64: bytes.toString('base64'),
            sizeBytes: bytes.length,
            checksum:
              'sha256:' + createHash('sha256').update(bytes).digest('hex'),
          })),
          operations: Awaited<
            ReturnType<typeof createCloudProjectOperation>
          >[] = [];
        for (let index = 0; index < 2; index++) {
          const callId = randomUUID(),
            selection = await selectProjectExecution(
              {
                context,
                callId,
                arguments: { ...f.args, outputs },
                worker: f.worker,
                cloudReady: true,
              },
              db,
            ),
            created = await createCloudProjectOperation(
              {
                context,
                callId,
                projectSelection: selection,
                worker: f.worker,
                storage: f.storage,
              },
              db,
            );
          await f.approveCloud(created);
          expect(created.payload.network).toBe('none');
          operations.push(created);
        }
        class CapturedOutputs extends CapturedProjectZip {
          cleanups = 0;
          outcome:
            Awaited<ReturnType<CapturedProjectZip['execute']>> | undefined;
          constructor() {
            super(zip);
          }
          override async execute(
            payload: Parameters<CloudRunnerBackend['execute']>[0],
          ) {
            const outcome = {
              ...(await super.execute(payload)),
              output: 'synthetic physical output preserved',
              artifacts: captured,
            };
            this.outcome = structuredClone(outcome);
            return outcome;
          }
          override async cleanup() {
            this.cleanups++;
          }
        }

        const operationIds = operations.map(
            (op) => op.snapshot.binding.attempt.operationId,
          ),
          idsFor = (index: number) =>
            outputCases.map((output) =>
              cloudStableId(`${operationIds[index]}:artifact:${output.path}`),
            ),
          readState = () =>
            readCloudPublicationState(db, rootRunId, sessionId, operationIds, [
              ...idsFor(0),
              ...idsFor(1),
            ]),
          toolBudget = (state: Awaited<ReturnType<typeof readState>>) =>
            state.budgets.find((row) => row.metric === 'tool_calls')!,
          admitted = await readState(),
          written: StorageObject[] = [],
          probes: { object: StorageObject; present: boolean }[] = [],
          deletes: StorageObject[] = [];
        const tracked: StoragePort = {
          put: async (object, stream) => {
            written.push(structuredClone(object));
            await f.storage.put(object, stream);
          },
          get: f.storage.get.bind(f.storage),
          exists: async (object) => {
            const present = await f.storage.exists(object);
            probes.push({ object: structuredClone(object), present });
            return present;
          },
          delete: async (object) => {
            deletes.push(structuredClone(object));
            await f.storage.delete(object);
          },
        };
        const backends = [new CapturedOutputs(), new CapturedOutputs()],
          execute = (index: number) =>
            runCloudCommandOperation(operations[index]!, {
              storage: tracked,
              database: db,
              backend: backends[index]!,
            }),
          interruption = Error(
            'injected crash after failed receipt before tool_calls settlement',
          ),
          settle =
            stage === 'recover-before-usage'
              ? vi
                  .spyOn(operations[1]!.ledger, 'settleUsage')
                  .mockRejectedValueOnce(interruption)
              : undefined;
        let raced;
        try {
          raced = await raceProjectPublications({
            db,
            storage: tracked,
            organizationId: f.org,
            workspaceId: f.workspace,
            first: () => execute(0),
            second: () => execute(1),
          });
        } finally {
          settle?.mockRestore();
        }
        expect(raced.blocked.holder).not.toBe(raced.blocked.waiter);
        expect(raced.results[0]!.status).toBe('fulfilled');
        const winner = raced.results[0]!;
        if (winner.status !== 'fulfilled')
          throw Error('First publication must win the observed lock race');
        expect(winner.value.status).toBe('succeeded');
        const failureResult = {
          operationId: operationIds[1],
          status: 'failed',
          reason: 'failed',
          exitCode: 0,
          stopped: true,
          cleanupConfirmed: true,
          errorCode: 'project_output_parent_stale',
          artifacts: [],
          output: 'synthetic physical output preserved',
        };
        const loser = raced.results[1]!;
        if (stage === 'completed') {
          expect(loser.status).toBe('fulfilled');
          if (loser.status !== 'fulfilled')
            throw Error(
              'Confirmed publication rejection must return a failed result',
            );
          expect(loser.value).toMatchObject(failureResult);
        } else {
          expect(loser.status).toBe('rejected');
          if (loser.status !== 'rejected')
            throw Error('Injected settlement interruption was not observed');
          expect(loser.reason).toBe(interruption);
        }

        // Compare complete descriptors from the actual publisher and absence proof;
        // only each operation's deterministic object identity may differ.
        expect(written.map((object) => object.id)).toEqual(idsFor(0));
        expect(written.map((object) => object.mediaType)).toEqual(
          outputCases.map((output) => output.mediaType),
        );
        expect(probes).toHaveLength(outputCases.length);
        expect(deletes).toEqual([]);
        for (const [index, probe] of probes.entries()) {
          expect(probe.present).toBe(false);
          expect(probe.object).toEqual({
            ...written[index]!,
            id: idsFor(1)[index],
            key: written[index]!.key.replace(/[^/]+$/, idsFor(1)[index]!),
          });
          const stored = Buffer.from(
            await new Response(
              await f.storage.get(written[index]!),
            ).arrayBuffer(),
          );
          expect(stored).toEqual(outputCases[index]!.bytes);
        }
        const physical = backends[1]!.outcome!;
        expect(physical).toMatchObject({
          exitCode: 0,
          stopped: true,
          reason: 'completed',
          output: 'synthetic physical output preserved',
        });
        expect(
          physical.artifacts.map((artifact) =>
            Buffer.from(artifact.contentBase64, 'base64'),
          ),
        ).toEqual(outputCases.map((output) => output.bytes));
        const afterRace = await readState(),
          failedJournal = afterRace.attempts.find(
            (row) => row.operation_id === operationIds[1],
          )!,
          failedReceipt = afterRace.receipts.find(
            (row) =>
              row.receipt_id === cloudStableId(`${operationIds[1]}:result`),
          )!,
          rejection = {
            version: 1,
            code: 'project_output_parent_stale',
            physicalOutcomeDigest: runtimePolicyDigest(physical),
            payloadDigest: runtimePolicyDigest(operations[1]!.payload),
            storageWrites: 0,
            publishedArtifacts: 0,
            absentStorageObjectsDigest: runtimePolicyDigest(
              probes.map((probe) => probe.object),
            ),
          };
        expect(failedJournal.outcome).toEqual(physical);
        expect(failedJournal.artifacts).toEqual([]);
        expect(
          afterRace.operations.find((row) => row.id === operationIds[1])!
            .status,
        ).toBe('failed');
        expect(failedReceipt).toMatchObject({
          operation_id: operationIds[1],
          disposition: 'applied',
          payload: {
            attempt: operations[1]!.snapshot.binding.attempt,
            signal: {
              type: 'operation.outcome',
              result: { status: 'failed', effects: 'none' },
            },
            evidence: {
              exitCode: 0,
              stopped: true,
              reason: 'completed',
              output: physical.output,
              artifacts: [],
              errorCode: 'project_output_parent_stale',
            },
          },
        });
        expect(failedReceipt.payload.evidence.publicationRejection).toEqual(
          rejection,
        );
        expect(failedReceipt.payload.signal.result.evidence.digest).toBe(
          runtimePolicyDigest({
            outcome: physical,
            artifacts: [],
            publicationRejection: rejection,
          }),
        );
        expect(
          afterRace.receipts.filter(
            (row) => row.receipt_id === failedReceipt.receipt_id,
          ),
        ).toHaveLength(1);

        if (stage === 'recover-before-usage') {
          const pending = afterRace.reservations.find(
            (row) =>
              row.operation_id === operationIds[1] &&
              row.metric === 'tool_calls',
          )!;
          expect(pending.settled_amount).toBeNull();
          expect(pending.observation_id).toBeNull();
          expect(pending.observation).toBeNull();
          expect(failedJournal.cleanup_confirmed_at).toBeNull();
          expect(backends[1]!.cleanups).toBe(0);
          expect(Number(toolBudget(afterRace).reserved)).toBe(
            Number(toolBudget(admitted).reserved) - 1,
          );
          expect(Number(toolBudget(afterRace).spent)).toBe(
            Number(toolBudget(admitted).spent) + 1,
          );
          // A fresh recovery call constructs its own ledger from persisted binding,
          // payload, physical outcome and receipt. This is not a process restart.
          await db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${context.jobId}`;
          const recovery = new CapturedOutputs(),
            coldExecute = vi
              .spyOn(recovery, 'execute')
              .mockRejectedValue(Error('Cold recovery must not execute')),
            coldCollect = vi
              .spyOn(recovery, 'collect')
              .mockRejectedValue(
                Error('Durable physical outcome must not be recollected'),
              );
          expect(
            await recoverCloudCommandOperations({
              database: db,
              backend: recovery,
            }),
          ).toEqual({ recovered: 1, failed: 0 });
          expect(
            await recoverCloudCommandOperations({
              database: db,
              backend: recovery,
            }),
          ).toEqual({ recovered: 0, failed: 0 });
          expect(coldExecute).not.toHaveBeenCalled();
          expect(coldCollect).not.toHaveBeenCalled();
          expect(recovery.cleanups).toBe(1);
        }
        const closed = await readState(),
          settled = closed.reservations.filter(
            (row) => row.metric === 'tool_calls',
          );
        expect(settled).toHaveLength(2);
        for (const meter of settled) {
          const index = operationIds.indexOf(meter.operation_id),
            binding = operations[index]!.snapshot.binding;
          expect(Number(meter.amount)).toBe(1);
          expect(Number(meter.settled_amount)).toBe(1);
          expect(meter.observation_id).toBe(
            cloudStableId(`${meter.operation_id}:usage`),
          );
          expect(meter.observation).toMatchObject({
            observationId: meter.observation_id,
            accountingId: meter.accounting_id,
            task: binding.task,
            source: toolBudget(closed).source,
            accountingBoundary: { kind: 'operation', attempt: binding.attempt },
            metric: 'tool_calls',
            unit: 'calls',
            amount: 1,
            state: 'settled',
            quality: 'measured',
          });
        }
        expect(Number(toolBudget(closed).reserved)).toBe(
          Number(toolBudget(admitted).reserved) - 2,
        );
        expect(Number(toolBudget(closed).spent)).toBe(
          Number(toolBudget(admitted).spent) + 2,
        );
        expect(
          closed.reservations.filter((row) => row.metric !== 'tool_calls'),
        ).toEqual(
          admitted.reservations.filter((row) => row.metric !== 'tool_calls'),
        );
        expect(
          closed.attempts.every(
            (row) => row.cleanup_confirmed_at instanceof Date,
          ),
        ).toBe(true);
        expect(
          closed.attempts.find((row) => row.operation_id === operationIds[1])!
            .outcome,
        ).toEqual(physical);
        expect(closed.receipts).toEqual(afterRace.receipts);
        expect(closed.artifacts).toHaveLength(outputCases.length);
        expect(
          closed.artifacts.every(
            (row) => row.provenance.operationId === operationIds[0],
          ),
        ).toBe(true);
        expect(closed.objects.map((row) => row.id).sort()).toEqual(
          idsFor(0).sort(),
        );
        expect(
          closed.versions.filter((row) => idsFor(1).includes(row.object_id)),
        ).toEqual([]);
        const parentVersion = closed.versions.find(
            (row) => row.id === parent.versionId,
          )!,
          chain = closed.versions.filter(
            (row) => row.series_id === parentVersion.series_id,
          );
        expect(chain.map((row) => row.version)).toEqual([1, 2]);
        expect(chain[1]).toMatchObject({
          parent_version_id: parent.versionId,
          object_id: idsFor(0)[0],
        });

        // Re-entry uses a new ledger and backend; durable failure never republishes,
        // re-executes, settles twice or changes the original result receipt.
        const replay = new CapturedOutputs(),
          replayExecute = vi
            .spyOn(replay, 'execute')
            .mockRejectedValue(Error('Exact result read must not execute')),
          replayCollect = vi
            .spyOn(replay, 'collect')
            .mockRejectedValue(Error('Exact result read must not collect')),
          replayCreated = {
            ...operations[1]!,
            ledger: createCloudOperationLedger(operations[1]!.principal, db),
          },
          reread = () =>
            runCloudCommandOperation(replayCreated, {
              storage: tracked,
              database: db,
              backend: replay,
            }),
          firstRead = await reread();
        expect(firstRead).toMatchObject(failureResult);
        expect(await reread()).toEqual(firstRead);
        expect(replay.cleanups).toBe(0);
        if (stage === 'completed')
          expect(
            await runCloudCommandOperation(
              {
                ...operations[0]!,
                ledger: createCloudOperationLedger(
                  operations[0]!.principal,
                  db,
                ),
              },
              { storage: tracked, database: db, backend: replay },
            ),
          ).toEqual(winner.value);
        expect(replayExecute).not.toHaveBeenCalled();
        expect(replayCollect).not.toHaveBeenCalled();
        expect(backends.map((backend) => backend.executions)).toEqual([1, 1]);
        expect(written).toHaveLength(outputCases.length);
        expect(probes).toHaveLength(outputCases.length);
        expect(await readState()).toEqual(closed);
        console.info('Saved-project PostgreSQL publication proof', {
          stage,
          blocked: raced.blocked,
          statuses: closed.operations.map((row) => row.status).sort(),
          mediaTypes: written.map((object) => object.mediaType),
          receiptId: failedReceipt.receipt_id,
          physicalOutcomeDigest: rejection.physicalOutcomeDigest,
          toolCalls: settled.map((row) => ({
            amount: Number(row.settled_amount),
            state: row.observation.state,
          })),
          cleanupConfirmed: true,
          repeatStateUnchanged: true,
        });
      },
    );
    it.each([600000, 1800000, 3600000] as const)(
      'freezes the saved-project %s ms cap and one clock across dispatch/retry',
      async (cap) => {
        vi.stubEnv('ALLRICE_SANDBOX_EXECUTION_V1_ENABLED', '1');
        const policy = resolveSandboxExecutionPolicy(
          cap === 600000
            ? []
            : [
                {
                  scope: 'tenant',
                  scopeId: randomUUID(),
                  source: 'tenant_override',
                  maxExecutionMs: cap,
                },
              ],
        );
        const f = await setup(true, false, { policy });
        const args = {
          ...f.args,
          execution: { version: 1 as const, kind: 'install' as const },
        };
        const selection = await f.select(true, args);
        expect(selection.choice.location).toBe('cloud'); // older Bridge must not silently ignore the new contract
        const c = await createCloudProjectOperation(
          {
            context: f.context,
            callId: f.callId,
            projectSelection: selection,
            worker: f.worker,
            storage: f.storage,
          },
          f.db,
        );
        expect(c.payload.executionBudget).toEqual({
          version: 1,
          kind: 'install',
          policy,
          initialBudgetMs: 120000,
        });
        expect(c.snapshot.binding.command?.budgetDigest).toBe(
          runtimePolicyDigest({
            limits: args.limits,
            execution: c.payload.executionBudget,
          }),
        );
        await f.approveCloud(c);
        const scope = c.snapshot.binding.task.scope,
          attempt = c.snapshot.binding.attempt;
        const lease = await c.ledger.dispatch({
          scope,
          operationId: attempt.operationId,
          leaseOwner: f.context.worker.id,
          leaseMs: 15000,
        });
        const receipt = {
          scope,
          operationId: attempt.operationId,
          attempt,
          leaseToken: lease.leaseToken,
        };
        await c.ledger.startOperation({ ...receipt, receiptId: randomUUID() });
        const [first, replay] = await Promise.all([
          c.ledger.exchangeSandboxExecutionBudget(receipt),
          c.ledger.exchangeSandboxExecutionBudget(receipt),
        ]);
        expect(first).toEqual(replay);
        expect(first.spec.policy.maxExecutionMs).toBe(cap);
        expect(first.deadlineAt - first.startedAt).toBe(120000);
        expect(first.hardDeadlineAt - first.startedAt).toBeLessThanOrEqual(cap);
        const [view] = await listCloudRuntimeOperations(
          f.requestContext,
          f.rootRunId,
          f.db,
        );
        expect(view!.proposal).toMatchObject({
          kind: 'project',
          executionBudget: c.payload.executionBudget,
        });
        await f.db`update allrice_cloud_execution_grants set revoked_at=clock_timestamp() where id=${f.cloudGrant}`;
        await expect(
          c.ledger.exchangeSandboxExecutionBudget(receipt),
        ).rejects.toThrow('cloud_grant_unavailable');
        const [stored] =
          await f.db`select execution_budget from allrice_runtime_operations where id=${attempt.operationId}`;
        expect(stored!.execution_budget).toEqual(first);
      },
    );
    it('binds source and destinations to exact project approval; revocation blocks dispatch', async () => {
      vi.stubEnv('ALLRICE_SANDBOX_NETWORK_ENABLED', '1');
      const f = await setup(true, false, { network: true });
      const network = {
        mode: 'controlled_https' as const,
        origins: ['https://registry.npmjs.org'],
      };
      const selection = await f.select(true, { ...f.args, network });
      const c = await createCloudProjectOperation(
        {
          context: f.context,
          callId: f.callId,
          projectSelection: selection,
          worker: f.worker,
          storage: f.storage,
        },
        f.db,
      );
      expect(c.payload.network).toEqual(network);
      expect(c.snapshot.binding.dataScope.map((s) => s.destination)).toEqual([
        'cloud_execution',
        'external_service',
      ]);
      expect(c.snapshot.binding.dataScope[1]).toMatchObject({
        content: f.args.project.snapshot,
        externalNetwork: network,
        authorizationId: f.cloudGrant,
        authorizationVersion: 1,
      });
      const [view] = await listCloudRuntimeOperations(
        f.requestContext,
        f.rootRunId,
        f.db,
      );
      expect(view!.proposal).toMatchObject({
        kind: 'project',
        network,
        project: f.args.project,
      });
      await f.approveCloud(c);
      await f.db`update allrice_cloud_execution_grants set revoked_at=clock_timestamp() where id=${f.cloudGrant}`;
      await expect(
        c.ledger.dispatch({
          scope: c.snapshot.binding.task.scope,
          operationId: c.snapshot.binding.attempt.operationId,
          leaseOwner: f.context.worker.id,
          leaseMs: 15000,
        }),
      ).rejects.toThrow('cloud_grant_unavailable');
    });
    it('admits saved-source execution through backend screening without a manual website profile', async () => {
      vi.stubEnv('ALLRICE_SANDBOX_NETWORK_ENABLED', '1');
      const f = await setup(true, false, { network: false });
      const network = {
        mode: 'controlled_https' as const,
        origins: ['https://registry.npmjs.org'],
      };
      const selection = await f.select(true, { ...f.args, network });
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
      expect(created.payload.network).toEqual(network);
      expect(created.snapshot.binding.dataScope).toContainEqual(
        expect.objectContaining({
          destination: 'external_service',
          externalNetwork: network,
        }),
      );
    });
    it.each([
      [
        { network: true, allowInputTransfer: false },
        'sandbox_network_transfer_not_authorized',
      ],
      [{ network: true, outbound: false }, 'sandbox_network_not_authorized'],
    ] as const)(
      'does not treat saved source as public or borrow missing network authority: %s',
      async (options, reason) => {
        vi.stubEnv('ALLRICE_SANDBOX_NETWORK_ENABLED', '1');
        const f = await setup(true, false, options);
        const selection = await f.select(true, {
          ...f.args,
          network: {
            mode: 'controlled_https',
            origins: ['https://registry.npmjs.org'],
          },
        });
        await expect(
          createCloudProjectOperation(
            {
              context: f.context,
              callId: f.callId,
              projectSelection: selection,
              worker: f.worker,
              storage: f.storage,
            },
            f.db,
          ),
        ).rejects.toThrow(reason);
        // The caller's immutable proposal may be retained for diagnostics,
        // but denial must leave no admitted operation or physical attempt.
        const [counts] = await f.db`select
          (select count(*)::int from allrice_runtime_operations where run_id=${f.rootRunId}) operations,
          (select count(*)::int from allrice_cloud_execution_attempts a join allrice_cloud_execution_inputs i on i.operation_id=a.operation_id where i.run_id=${f.rootRunId}) attempts`;
        expect(counts).toEqual({ operations: 0, attempts: 0 });
      },
    );
    it('keeps omitted legacy project budget and environment digests unchanged', async () => {
      const f = await setup();
      await f.setState('offline');
      const selection = await f.select();
      const c = await createCloudProjectOperation(
        {
          context: f.context,
          callId: f.callId,
          projectSelection: selection,
          worker: f.worker,
          storage: f.storage,
        },
        f.db,
      );
      expect(c.payload.executionBudget).toBeUndefined();
      expect(c.payload.arguments.execution).toBeUndefined();
      expect(c.payload.arguments.network).toBeUndefined();
      expect(c.payload.network).toBe('none');
      expect(c.snapshot.binding.command).toMatchObject({
        budgetDigest: runtimePolicyDigest(f.args.limits),
        networkPolicyDigest: runtimePolicyDigest({ network: 'none' }),
        effectiveEnvironmentDigest: runtimePolicyDigest({
          backend: 'cloud-gvisor-v1',
          credentials: 'none',
          user: '1000',
          preparation: 'trusted_root_supervisor',
        }),
      });
    });
    it('rejects missing frozen policy and disables new project budgets without changing legacy requests', async () => {
      vi.stubEnv('ALLRICE_SANDBOX_EXECUTION_V1_ENABLED', '1');
      const old = await setup();
      const args = {
        ...old.args,
        execution: { version: 1 as const, kind: 'compute' as const },
      };
      const selection = await old.select(true, args);
      await expect(
        createCloudProjectOperation(
          {
            context: old.context,
            callId: old.callId,
            projectSelection: selection,
            worker: old.worker,
            storage: old.storage,
          },
          old.db,
        ),
      ).rejects.toThrow('sandbox_execution_upgrade_required');
      const f = await setup(true, false, {
        policy: resolveSandboxExecutionPolicy([]),
      });
      const next = await f.select(true, {
        ...f.args,
        execution: args.execution,
      });
      vi.stubEnv('ALLRICE_SANDBOX_EXECUTION_V1_ENABLED', '0');
      try {
        await expect(
          createCloudProjectOperation(
            {
              context: f.context,
              callId: f.callId,
              projectSelection: next,
              worker: f.worker,
              storage: f.storage,
            },
            f.db,
          ),
        ).rejects.toThrow('sandbox_execution_not_enabled');
      } finally {
        vi.stubEnv('ALLRICE_SANDBOX_EXECUTION_V1_ENABLED', '1');
      }
    });
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
      expect(
        await readProjectWorkflowBudget(
          { context: f.context, worker: f.worker },
          f.db,
        ),
      ).toMatchObject({
        executions: 8,
        used: { executions: 8, edits: 0 },
        remaining: { executions: 0, edits: 3 },
        nextAction: 'read_or_deliver_only',
      });
      await expect(
        readProjectWorkflowBudget(
          {
            context: { ...f.context, workspaceId: randomUUID() },
            worker: f.worker,
          },
          f.db,
        ),
      ).rejects.toThrow('run_or_frozen_configuration_changed');
      await expect(
        selectProjectExecution({ ...replayInput!, callId: randomUUID() }, f.db),
      ).rejects.toThrow('project_workflow_budget_exhausted');
      const g = await setup();
      await g.select();
      await g.db`update allrice_audit_events set occurred_at=clock_timestamp()-interval '31 minutes' where action='execution.location' and metadata->>'runId'=${g.rootRunId}`;
      expect(
        await readProjectWorkflowBudget(
          { context: g.context, worker: g.worker },
          g.db,
        ),
      ).toMatchObject({
        used: { executions: 1 },
        remaining: { elapsedMs: 0 },
        nextAction: 'read_or_deliver_only',
      });
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
    it('keeps a large managed project off legacy Bridge, preserving cloud permission and user local-only choices', async () => {
      const large = (f: Awaited<ReturnType<typeof setup>>) => ({
        ...f.args,
        projectPreparation: {
          ...f.args.projectPreparation,
          resourceProfile: 'web-development',
          packages: Array.from({ length: 129 }, (_, i) => ({
            name: `synthetic-${i}`,
            version: '1.0.0',
            integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'),
          })),
        },
      });
      const f = await setup();
      expect((await f.select(true, large(f))).choice).toMatchObject({
        location: 'cloud',
        status: 'execute',
      });
      const local = await setup();
      await local.request('只在本地运行，禁止使用云端。');
      expect((await local.select(true, large(local))).choice.status).toBe(
        'unavailable',
      );
      const denied = await setup(false);
      expect((await denied.select(true, large(denied))).choice.status).toBe(
        'unavailable',
      );
      // Direct local commands cannot bypass the selection check either.
      const { action: _action, project: _project, ...arguments_ } = large(f);
      void [_action, _project];
      await expect(
        createLocalCommandOperation(
          {
            context: f.context,
            callId: randomUUID(),
            arguments: {
              ...arguments_,
              files: [{ path: 'main.cjs', sha256: 'sha256:' + '1'.repeat(64) }],
            },
            worker: f.worker,
            storage: f.storage,
          },
          f.db,
        ),
      ).rejects.toThrow('local_runner_upgrade_required');
      expect(await f.countCloud()).toBe(0);
    });
    it('routes a uv lock only to a backend of its CPU architecture', async () => {
      // The fixture Bridge is amd64; the cloud follows this host (arm64 on Apple
      // silicon, amd64 on the Linux CI).
      const withLock = (
        f: Awaited<ReturnType<typeof setup>>,
        fileName: string,
      ) => ({
        ...f.args,
        executable: '/workspace/.venv/bin/python',
        projectPreparation: {
          ...f.args.projectPreparation,
          manager: 'uv',
          managerVersion: '0.8.22',
          lockPath: 'requirements.lock',
          scripts: 'disabled',
          packages: [
            {
              name: fileName.split('-')[0],
              version: fileName.split('-')[1],
              fileName,
              url: `https://files.pythonhosted.org/packages/00/00/${fileName}`,
              sha256: 'sha256:' + '3'.repeat(64),
            },
          ],
        },
      });
      const pure = 'six-1.17.0-py2.py3-none-any.whl',
        x86 =
          'numpy-2.2.6-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl',
        arm =
          'numpy-2.2.6-cp311-cp311-manylinux_2_17_aarch64.manylinux2014_aarch64.whl';
      for (const fileName of [pure, x86]) {
        const f = await setup();
        expect(
          (await f.select(true, withLock(f, fileName))).choice,
        ).toMatchObject({ location: 'local', status: 'execute' });
      }
      const f = await setup();
      if (cloudPlatform.architecture === 'arm64') {
        // The tool selects first without a cloud probe: an unsuitable Bridge must
        // then lead to the probe ("cloud_unavailable"), not to a mismatch error.
        expect((await f.select(false, withLock(f, arm))).choice).toMatchObject({
          location: 'none',
          status: 'unavailable',
          reason: 'cloud_unavailable',
        });
        expect((await f.select(true, withLock(f, arm))).choice).toMatchObject({
          location: 'cloud',
          status: 'execute',
        });
        // A revoked cloud grant is "cloud unavailable", not a lock mismatch.
        const revoked = await setup();
        await revoked.db`update allrice_cloud_execution_grants set enabled=false where id=${revoked.cloudGrant}`;
        expect(
          (await revoked.select(true, withLock(revoked, arm))).choice,
        ).toMatchObject({ status: 'unavailable', reason: 'cloud_unavailable' });
      } else
        // The amd64 cloud cannot install it either: known without a probe.
        await expect(f.select(false, withLock(f, arm))).rejects.toThrow(
          'project_lock_platform_mismatch',
        );
      // Local-only work on the amd64 Bridge: the mismatch itself is reported.
      const local = await setup();
      await local.request('只在本地运行，禁止使用云端。');
      await expect(
        local.select(false, withLock(local, arm)),
      ).rejects.toMatchObject({
        code: 'project_lock_platform_mismatch',
        cloudBlocked: 'local_request',
        bridgeArchitectures: ['amd64'],
        serverArchitecture: cloudPlatform.architecture,
      });
      // Cloud-only work leaves the Bridge out: an x86_64 lock that only the amd64
      // Bridge could install is a mismatch for an arm64 cloud.
      const cloudOnly = await setup();
      await cloudOnly.request('只在云端运行。');
      if (cloudPlatform.architecture === 'arm64')
        await expect(
          cloudOnly.select(false, withLock(cloudOnly, x86)),
        ).rejects.toMatchObject({
          cloudBlocked: null,
          bridgeArchitectures: [],
        });
      // A direct local command cannot send the lock to this Bridge either.
      const {
        action: _action,
        project: _project,
        ...arguments_
      } = withLock(f, arm);
      void [_action, _project];
      await expect(
        createLocalCommandOperation(
          {
            context: f.context,
            callId: randomUUID(),
            arguments: {
              ...arguments_,
              files: [{ path: 'main.cjs', sha256: 'sha256:' + '1'.repeat(64) }],
            },
            worker: f.worker,
            storage: f.storage,
          },
          f.db,
        ),
      ).rejects.toThrow('project_lock_platform_mismatch');
    });
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
              platform: cloudPlatform.linuxPlatform,
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
