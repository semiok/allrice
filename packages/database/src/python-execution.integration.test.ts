import {
  raceProjectPublications,
  raceQueuedOutputPublications,
} from './project-output-parent.fixture.ts';
import { CloudRunnerBackend } from '../../../apps/worker/src/cloud-runner/backend.js';
import {
  runCloudCommandOperation,
  recoverCloudCommandOperations,
} from '../../../apps/worker/src/cloud-runner/executor.js';
import {
  updateBridgeSandboxNetwork,
  getBridgeSandboxNetwork,
  resolveBridgeSandboxNetworkGrant,
} from './bridge-sandbox-network.ts';
/** Isolated DB/StoragePort regression. Captured bytes are never tenant-executed here. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BridgeDeviceSchema,
  RuntimeLocalPythonProfileSchema,
  RuntimeLocalPythonPayloadSchema,
  RuntimeLocalPythonResultSchema,
  EmployeeExecutionSnapshotSchema,
  cloudPythonImageV1,
  cloudToolchainImageV1,
  managedPythonPayloadForPlatform,
  resolveSandboxExecutionPolicy,
  type StoragePort,
  type StorageObject,
} from '@allrice/contracts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import {
  createCloudPythonOperation,
  createCloudOperationLedger,
  publishCloudOperationArtifacts,
  cloudStableId,
  loadCloudCommandInputs,
} from './cloud-execution.ts';
import { heartbeatBridgeDevice } from './bridge.ts';
import {
  RuntimePolicyError,
  setRuntimePolicyControls,
  runtimePolicyDigest as digest,
} from './runtime-policy.ts';
import { updateWorkAutomation } from './work-automation.ts';
import {
  selectManagedPythonExecution,
  reportLocalPythonProfile,
  createLocalPythonOperation,
  storeLocalPythonArtifact,
  publishLocalPythonArtifacts,
  assertLocalPythonDelegation,
  managedPythonCallNotDispatched,
} from './local-python-execution.ts';
import { createGovernedBridgeOperationLedger } from './runtime-governed-bridge.ts';
import { normalizeCloudPythonArguments } from './cloud-authority.ts';
import { completeStorageDelete, prepareStorageDelete } from './data.ts';
import {
  createToolBrokerExportObject,
  getToolBrokerFile,
  registerToolBrokerExport,
} from './execution/tool-broker.ts';
import * as client from './core/client.ts';
import { prepareTenantCloudGrants } from './employees/development-cloud-grants.ts';
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
const release = managedPythonPayloadForPlatform('macos-x64')!;
const sha = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);
const revisedPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
const pngProof = {
  checker: 'pillow-11.3.0' as const,
  checksum: sha(png),
  width: 1,
  height: 1,
};
const modernProfile = RuntimeLocalPythonProfileSchema.parse({
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
  pythonChartsContractVersion: 1,
});

async function readCloudPublicationState(
  db: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>['db'],
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
  'canonical Python exact cloud origin and local ready-object lifecycle',
  () => {
    let isolated: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>,
      storageRoot: string;
    beforeAll(async () => {
      for (const flag of [
        'ALLRICE_RUNTIME_POLICY_ENABLED',
        'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
        'ALLRICE_WORKBENCH_ENABLED',
        'ALLRICE_CLOUD_RUNNER_ENABLED',
        'ALLRICE_SANDBOX_EXECUTION_V1_ENABLED',
        'ALLRICE_SANDBOX_NETWORK_ENABLED',
      ])
        vi.stubEnv(flag, '1');
      vi.stubEnv('ALLRICE_LOCAL_COMMAND_ENABLED', '0');
      isolated = await createRuntimeFixtureDatabase();
      storageRoot = await mkdtemp(join(tmpdir(), 'allrice-canonical-python-'));
      vi.spyOn(client, 'getDatabase').mockReturnValue(isolated.db);
    }, 60000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (isolated)
        console.info(
          'Canonical Python fixture cleanup',
          await isolated.close(),
        );
      if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
      console.info('Canonical Python output storage cleanup', { storageRoot });
    });
    const fixture = (
      options: Parameters<typeof createCloudExecutionFixture>[2] = {
        canonicalPython: {},
      },
    ) => createCloudExecutionFixture(isolated.db, storageRoot, options);
    type F = Awaited<ReturnType<typeof fixture>>;
    const request = async (
      f: F,
      args: Record<string, unknown>,
      callId = randomUUID(),
    ) => {
      const [job] = await isolated.db<
        { attempt: number; lease_token: string }[]
      >`select attempt,lease_token from allrice_jobs where id=${f.execution.jobId}`;
      return {
        context: f.execution,
        callId,
        toolName: 'python.execute' as const,
        arguments: args,
        purpose: 'python_charts' as const,
        inputs: normalizeCloudPythonArguments(args).inputs,
        location: args.location as 'local' | 'cloud' | 'auto' | undefined,
        jobAttempt: job!.attempt,
        jobLeaseToken: job!.lease_token,
      };
    };
    const device = async (f: F, modern = true) => {
      const id = randomUUID(),
        token = `synthetic-canonical-${randomUUID()}`,
        now = new Date().toISOString();
      await isolated.db`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at)
      values(${id},${f.org},${f.workspace},${f.user},'Synthetic chart','macos-x64',2,array['local.python.execute'],${createHash('sha256').update(token).digest('hex')},clock_timestamp())`;
      const d = BridgeDeviceSchema.parse({
        id,
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        name: 'Synthetic chart',
        platform: 'macos-x64',
        protocolVersion: 2,
        capabilities: ['local.python.execute'],
        status: 'online',
        lastSeenAt: now,
        createdAt: now,
        revokedAt: null,
      });
      await heartbeatBridgeDevice(token, {
        protocolVersion: 2,
        capabilities: ['local.python.execute'],
        environment: {
          version: 1,
          clientVersion: 'synthetic-chart',
          browser: 'unavailable',
          sandbox: 'unavailable',
          preview: 'unavailable',
          paused: false,
          readiness: [
            {
              capability: 'local.python',
              state: 'ready',
              reason: 'ready',
              missing: [],
              versions: { bridge: 'synthetic-chart', imageId: release.imageId },
              observedAt: now,
            },
          ],
        },
      });
      const oldProfile = { ...modernProfile };
      delete oldProfile.pythonChartsContractVersion;
      await reportLocalPythonProfile(
        d,
        modern ? modernProfile : oldProfile,
        isolated.db,
      );
      await setRuntimePolicyControls(
        f.context,
        {
          version: 2,
          enabled: true,
          mode: 'execute',
          rules: [
            { action: 'local.process.execute', effect: 'deny' },
            { action: 'local.python.execute', effect: 'allow' },
            { action: 'cloud.process.execute', effect: 'allow' },
          ],
        },
        1,
        isolated.db,
      );
      await updateWorkAutomation(
        f.context,
        f.workspace,
        { expectedRevision: 2, capability: 'computer', enabled: true },
        isolated.db,
      );
      return { device: d, token };
    };
    const args = (
      outputs: {
        path: string;
        fileName: string;
        format: 'png' | 'json' | 'txt' | 'csv';
        parentObjectId?: string;
      }[] = [],
    ) => ({
      script: 'synthetic captured outcome; never executed',
      outputs,
      limits: { artifactBytes: 4_000_000 },
    });
    const running = async (
      f: F,
      a: Record<string, unknown>,
      outputMediaTypes: string[] = [],
      existingDevice?: Awaited<ReturnType<typeof device>>,
    ) => {
      const d = existingDevice ?? (await device(f));
      if (a.execution)
        await reportLocalPythonProfile(
          d.device,
          {
            ...modernProfile,
            sandboxExecutionVersion: 1,
            ...(a.network ? { sandboxNetworkVersion: 1 } : {}),
          },
          isolated.db,
        );
      const r = await request(f, a),
        selection = await selectManagedPythonExecution(r, isolated.db),
        normalized = normalizeCloudPythonArguments(a);
      const media = {
        png: 'image/png',
        json: 'application/json',
        txt: 'text/plain',
        csv: 'text/csv',
      };
      const p = RuntimeLocalPythonPayloadSchema.parse({
        capability: 'local.python.execute',
        ...(selection.networkGrant
          ? { networkGrant: selection.networkGrant }
          : {}),
        ...(selection.executionBudget
          ? { executionBudget: selection.executionBudget }
          : {}),
        arguments: {
          path: '.',
          purpose: 'python_charts',
          origin: {
            toolName: 'python.execute',
            callId: r.callId,
            argumentsDigest: digest(a),
          },
          script: normalized.script,
          inputs: normalized.inputs.map((i) => ({
            ...i,
            sizeBytes: f.object.sizeBytes,
            mediaType: f.object.mediaType,
          })),
          outputs: normalized.outputs.map(
            ({ path, fileName, format }, index) => ({
              path,
              fileName,
              format,
              mediaType: outputMediaTypes[index] ?? media[format],
              objectId: cloudStableId(
                `managed-python-output:${f.run}:${r.callId}:${index}`,
              ),
            }),
          ),
          profileVersion: 1,
          imageId: release.imageId,
          architecture: release.architecture,
          isolation: 'local-vm-container-v1',
          network: normalized.network ?? 'none',
          ...(normalized.execution ? { execution: normalized.execution } : {}),
          limits: { ...normalized.limits, inputBytes: 2_000_000 },
        },
      });
      const created = await createLocalPythonOperation(
        { selection, context: f.execution, payload: p, arguments: a },
        isolated.db,
      );
      const ledger = createGovernedBridgeOperationLedger(d.device, {
        database: isolated.db,
      });
      const scope = created.snapshot.binding.task.scope;
      if (p.executionBudget)
        expect(
          await ledger.claimNextBridgeOperation({
            scope,
            deviceId: d.device.id,
            leaseMs: 30000,
            supportsManagedPython: true,
          }),
        ).toBeNull();
      const claim = await ledger.claimNextBridgeOperation({
        scope,
        deviceId: d.device.id,
        leaseMs: 30000,
        supportsManagedPython: true,
        ...(p.executionBudget ? { supportsSandboxExecutionV1: true } : {}),
        ...(p.networkGrant ? { supportsSandboxNetworkV1: true } : {}),
      });
      if (!claim) throw Error('managed chart claim required');
      const identity = {
        scope,
        operationId: claim.snapshot.binding.attempt.operationId,
        leaseToken: claim.leaseToken,
        attempt: claim.snapshot.binding.attempt,
      };
      await ledger.startOperation({ ...identity, receiptId: randomUUID() });
      const upload = (
        index: number,
        bytes: Uint8Array,
        storage: StoragePort = f.storage,
        extra = {},
      ) => {
        const out = p.arguments.outputs[index]!;
        return storeLocalPythonArtifact({
          token: d.token,
          id: identity.operationId,
          leaseToken: identity.leaseToken,
          objectId: out.objectId,
          metadata: {
            checksum: sha(bytes),
            sizeBytes: bytes.length,
            mediaType: out.mediaType,
            validation: out.format === 'png' ? 'trusted_png' : 'utf8',
            ...(out.format === 'png'
              ? { png: { ...pngProof, checksum: sha(bytes) } }
              : {}),
            ...extra,
          },
          stream: new Blob([Uint8Array.from(bytes)]).stream(),
          storage,
        });
      };
      const succeed = async (
        artifacts: Awaited<ReturnType<typeof upload>>[],
      ) => {
        const result = RuntimeLocalPythonResultSchema.parse({
          backend: 'local-vm-container-v1',
          profileVersion: 1,
          purpose: 'python_charts',
          containerId: 'a'.repeat(64),
          imageId: release.imageId,
          architecture: release.architecture,
          stopped: true,
          exitCode: 0,
          reason: 'exited',
          stdout: 'synthetic',
          stderr: '',
          truncated: false,
          artifacts,
          workCopy: 'local_isolated_copy',
          sourceDirectoryModified: false,
        });
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
                digest: digest(result),
              },
            },
          },
          evidence: { output: result },
        });
        return result;
      };
      return {
        ...d,
        r,
        p,
        selection,
        created,
        ledger,
        identity,
        upload,
        succeed,
      };
    };
    const seedOutputParent = async (
      f: F,
      options: {
        sessionId?: string;
        ownerId?: string;
        format?: 'png' | 'text';
        immutable?: boolean;
      } = {},
    ) => {
      const format = options.format ?? 'text',
        bytes = format === 'png' ? png : Buffer.from('amountCents\n100\n'),
        context = {
          ...f.execution,
          policySnapshot: {
            ...f.execution.policySnapshot,
            subjectId: options.ownerId ?? f.user,
          },
        },
        object = {
          ...createToolBrokerExportObject({
            context,
            mediaType: format === 'png' ? 'image/png' : 'text/csv',
            sizeBytes: bytes.length,
            checksum: sha(bytes),
          }),
          immutable: options.immutable ?? true,
        };
      await f.storage.put(object, new Blob([bytes]).stream());
      const version = await registerToolBrokerExport(
        {
          context,
          sessionId: options.sessionId ?? f.session,
          fileName: format === 'png' ? 'chart.png' : 'metrics.csv',
          format,
          object,
        },
        isolated.db,
      );
      return { object, version };
    };

    it('streams both original input sizes and proves exact-call operation absence without changing file authority', async () => {
      const f = await fixture();
      const files = await Promise.all(
        [1651149, 1494177].map((n) =>
          f.upload(Buffer.alloc(n, 120), 'text/plain'),
        ),
      );
      const a = {
        ...args(),
        inputs: files.map((o, i) => ({
          path: `${i}.csv`,
          objectId: o.id,
          checksum: o.checksum,
        })),
      };
      const r = await request(f, a);
      expect(
        await managedPythonCallNotDispatched(
          f.execution,
          r.callId,
          isolated.db,
        ),
      ).toBe(true);
      await selectManagedPythonExecution(r, isolated.db);
      const created = await createCloudPythonOperation(
        { context: f.execution, callId: r.callId, arguments: a },
        isolated.db,
      );
      expect(
        await managedPythonCallNotDispatched(
          f.execution,
          r.callId,
          isolated.db,
        ),
      ).toBe(false);
      expect(
        await managedPythonCallNotDispatched(
          f.execution,
          randomUUID(),
          isolated.db,
        ),
      ).toBe(true);
      const get = vi.fn(f.storage.get.bind(f.storage));
      const inputs = await loadCloudCommandInputs(
        f.execution,
        created.payload,
        {
          get,
          put: f.storage.put.bind(f.storage),
          delete: f.storage.delete.bind(f.storage),
          exists: f.storage.exists.bind(f.storage),
        } satisfies StoragePort,
        isolated.db,
      );
      expect(get).not.toHaveBeenCalled();
      let total = 0;
      for (const source of inputs) {
        if ('contentBase64' in source)
          throw Error('ordinary inputs must stream');
        const reader = (
          await source.open(new AbortController().signal)
        ).getReader();
        const hash = createHash('sha256');
        for (;;) {
          const value = await reader.read();
          if (value.done) break;
          total += value.value.length;
          hash.update(value.value);
        }
        reader.releaseLock();
        expect(`sha256:${hash.digest('hex')}`).toBe(source.checksum);
      }
      expect(total).toBe(3145326);
      expect(get).toHaveBeenCalledTimes(2);
    });
    it('retains raw canonical Python and its frozen approval across deployment default changes', async () => {
      const f = await fixture();
      const original = {
        script: 'print("汇总完成")',
        location: 'cloud',
        limits: { outputBytes: 1024 },
      };
      const raw = structuredClone(original);
      const r = await request(f, original);
      await selectManagedPythonExecution(r, isolated.db);
      const input = {
        context: f.execution,
        callId: r.callId,
        arguments: original,
      };
      const timeout = process.env.ALLRICE_CLOUD_COMMAND_TIMEOUT_MS;
      const output = process.env.ALLRICE_CLOUD_COMMAND_OUTPUT_BYTES;
      vi.stubEnv('ALLRICE_CLOUD_COMMAND_TIMEOUT_MS', '1500');
      vi.stubEnv('ALLRICE_CLOUD_COMMAND_OUTPUT_BYTES', '2048');
      try {
        const created = await createCloudPythonOperation(input, isolated.db);
        expect(created.payload.arguments.limits).toMatchObject({
          timeoutMs: 1500,
          outputBytes: 1024,
        });
        expect(created.payload.origin).toMatchObject({
          argumentsDigest: digest(raw),
        });
        vi.stubEnv('ALLRICE_CLOUD_COMMAND_TIMEOUT_MS', '2500');
        vi.stubEnv('ALLRICE_CLOUD_COMMAND_OUTPUT_BYTES', '4096');
        expect(
          (await createCloudPythonOperation(input, isolated.db)).snapshot
            .binding,
        ).toEqual(created.snapshot.binding);
        await f.approve(created);
        const lease = await created.ledger.dispatch({
          scope: created.snapshot.binding.task.scope,
          operationId: created.snapshot.binding.attempt.operationId,
          leaseOwner: f.worker,
          leaseMs: 15000,
        });
        expect(lease.leaseToken).toBeTruthy();
        const [stored] =
          await isolated.db`select original_arguments,payload,binding from allrice_cloud_execution_inputs
          where operation_id=${created.snapshot.binding.attempt.operationId}`;
        expect(stored!.original_arguments).toEqual(raw);
        expect(stored!.binding).toEqual(created.snapshot.binding);
        expect(original).toEqual(raw);
        await expect(
          createCloudPythonOperation(
            {
              ...input,
              arguments: { ...original, limits: { outputBytes: 2048 } },
            },
            isolated.db,
          ),
        ).rejects.toThrow('cloud_input_changed');
        const nextRequest = await request(f, original);
        await selectManagedPythonExecution(nextRequest, isolated.db);
        const next = await createCloudPythonOperation(
          { ...input, callId: nextRequest.callId },
          isolated.db,
        );
        expect(next.payload.arguments.limits).toMatchObject({
          timeoutMs: 2500,
          outputBytes: 1024,
        });
        // Local normalization keeps the static existing default even in this env.
        expect(normalizeCloudPythonArguments(original).limits).toMatchObject({
          timeoutMs: 30000,
          outputBytes: 1024,
        });
      } finally {
        vi.stubEnv('ALLRICE_CLOUD_COMMAND_TIMEOUT_MS', timeout);
        vi.stubEnv('ALLRICE_CLOUD_COMMAND_OUTPUT_BYTES', output);
      }
    });
    it('requires streaming capability for oversized local inputs and keeps explicit local requests local', async () => {
      const f = await fixture(),
        d = await device(f);
      const object = await f.upload(Buffer.alloc(3145326, 120), 'text/plain');
      const a = {
        ...args(),
        location: 'local',
        inputs: [
          { path: 'data.csv', objectId: object.id, checksum: object.checksum },
        ],
      };
      const r = await request(f, a);
      const sized = {
        ...r,
        inputs: r.inputs.map((i) => ({ ...i, sizeBytes: object.sizeBytes })),
      };
      const old = await selectManagedPythonExecution(sized, isolated.db);
      expect(old.choice.status).toBe('unavailable');
      expect(old.choice.location).not.toBe('cloud');
      await reportLocalPythonProfile(
        d.device,
        { ...modernProfile, inputStreamingVersion: 1 },
        isolated.db,
      );
      const current = await selectManagedPythonExecution(sized, isolated.db);
      expect(current.choice).toMatchObject({
        location: 'local',
        status: 'execute',
      });
    });
    it('admits canonical cloud for ordinary members without BridgeRW/binding/device, preserving raw arguments and exact legacy separation', async () => {
      for (const canonicalPython of [
        { bridgeAccess: 'read_only' as const },
        { freezeBinding: false },
        {},
      ]) {
        const f = await fixture({ memberRole: 'member', canonicalPython }),
          a = args(),
          r = await request(f, a);
        const selected = await selectManagedPythonExecution(r, isolated.db);
        expect(selected.choice).toMatchObject({
          location: 'cloud',
          status: 'execute',
        });
        const created = await createCloudPythonOperation(
          { context: f.execution, callId: r.callId, arguments: a },
          isolated.db,
        );
        expect(created.payload).toMatchObject({
          imageDigest: cloudPythonImageV1,
          origin: {
            toolName: 'python.execute',
            callId: r.callId,
            purpose: 'python_charts',
            argumentsDigest: digest(a),
          },
        });
        expect(a).not.toHaveProperty('language');
        expect(a).not.toHaveProperty('location');
        expect(created.payload.arguments.language).toBe('python');
        const [row] =
          await isolated.db`select original_arguments,payload from allrice_cloud_execution_inputs where operation_id=${created.snapshot.binding.attempt.operationId}`;
        expect(row!.original_arguments).toEqual(a);
        expect(row!.payload).toEqual(created.payload);
        expect(f.grant.profile.imageDigest).toBe(cloudToolchainImageV1);
        await f.approve(created);
        expect(
          await created.ledger.dispatch({
            scope: created.snapshot.binding.task.scope,
            operationId: created.snapshot.binding.attempt.operationId,
            leaseOwner: created.context.worker.id,
            leaseMs: 30000,
          }),
        ).not.toBeNull();
        await expect(f.create('legacy-denied')).rejects.toThrow(
          'cloud_frozen_tool_not_allowed',
        );
        await expect(
          isolated.db`update allrice_cloud_execution_inputs set original_arguments='{}' where operation_id=${created.snapshot.binding.attempt.operationId}`,
        ).rejects.toThrow(/immutable/i);
      }
      const legacy = await fixture({}),
        r = await request(legacy, args());
      await selectManagedPythonExecution(r, isolated.db);
      await expect(
        createCloudPythonOperation(
          {
            context: legacy.execution,
            callId: r.callId,
            arguments: r.arguments,
          },
          isolated.db,
        ),
      ).rejects.toThrow('cloud_frozen_tool_not_allowed');
    });

    it('admits exact canonical cloud budget/network intent and rechecks the independent network grant', async () => {
      const network = {
        mode: 'controlled_https' as const,
        origins: ['https://pypi.org'],
      };
      const f = await fixture({
        canonicalPython: {},
        sandboxExecutionPolicy: resolveSandboxExecutionPolicy([]),
        outboundCapability: true,
        sandboxNetwork: { ...network, version: 1, allowInputTransfer: true },
      });
      const a = {
        ...args(),
        location: 'cloud',
        execution: { version: 1, kind: 'compute' },
        network,
      };
      const r = await request(f, a);
      await selectManagedPythonExecution(r, isolated.db);
      const created = await createCloudPythonOperation(
        { context: f.execution, callId: r.callId, arguments: a },
        isolated.db,
      );
      expect(created.payload.arguments.execution).toEqual(a.execution);
      expect(created.payload.executionBudget?.policy.maxExecutionMs).toBe(
        600000,
      );
      expect(created.payload.network).toEqual(network);
      expect(created.payload.origin?.argumentsDigest).toBe(digest(a));
      await f.approve(created);
      await isolated.db`update allrice_cloud_execution_grants set enabled=false where id=${f.grant.id}`;
      await expect(
        created.ledger.dispatch({
          scope: created.snapshot.binding.task.scope,
          operationId: created.snapshot.binding.attempt.operationId,
          leaseOwner: created.context.worker.id,
          leaseMs: 30000,
        }),
      ).rejects.toThrow('cloud_grant_unavailable');
      const denied = await fixture({
        canonicalPython: {},
        sandboxExecutionPolicy: resolveSandboxExecutionPolicy([]),
      });
      const deniedRequest = await request(denied, a);
      await selectManagedPythonExecution(deniedRequest, isolated.db);
      await expect(
        createCloudPythonOperation(
          {
            context: denied.execution,
            callId: deniedRequest.callId,
            arguments: a,
          },
          isolated.db,
        ),
      ).rejects.toThrow('sandbox_network_not_authorized');
    });

    it('automatically admits a new local request without a settings row and freezes each exact destination independently', async () => {
      const network = {
        mode: 'controlled_https' as const,
        origins: ['https://pypi.org'],
      };
      const f = await fixture({
        canonicalPython: {},
        outboundCapability: true,
        sandboxExecutionPolicy: resolveSandboxExecutionPolicy([]),
      });
      const d = await device(f);
      await reportLocalPythonProfile(
        d.device,
        {
          ...modernProfile,
          sandboxExecutionVersion: 1,
          sandboxNetworkVersion: 1,
        },
        isolated.db,
      );
      const a = {
        ...args(),
        location: 'local',
        execution: { version: 1, kind: 'compute' },
        network,
      };
      expect(
        await getBridgeSandboxNetwork(
          f.context,
          f.workspace,
          d.device.id,
          isolated.db,
        ),
      ).toEqual({ version: 0, enabled: false, profile: null });
      const first = await selectManagedPythonExecution(
        await request(f, a),
        isolated.db,
      );
      expect(first.networkGrant).toMatchObject({ id: d.device.id, version: 1 });
      const second = await selectManagedPythonExecution(
        await request(f, {
          ...a,
          network: { ...network, origins: ['https://example.com'] },
        }),
        isolated.db,
      );
      expect(second.networkGrant?.digest).not.toBe(first.networkGrant?.digest);
      const [row] =
        await isolated.db`select execution_snapshot from allrice_employee_runs where run_id=${f.execution.runId}`;
      const frozen = EmployeeExecutionSnapshotSchema.parse(
        row!.execution_snapshot,
      );
      await expect(
        resolveBridgeSandboxNetworkGrant(
          isolated.db,
          d.device,
          network,
          false,
          frozen,
          first.networkGrant,
        ),
      ).resolves.toEqual(first.networkGrant);
      await expect(
        resolveBridgeSandboxNetworkGrant(
          isolated.db,
          { ...d.device, ownerId: randomUUID() },
          network,
          false,
          frozen,
        ),
      ).rejects.toThrow('sandbox_network_not_authorized');
      await expect(
        resolveBridgeSandboxNetworkGrant(
          isolated.db,
          d.device,
          network,
          false,
          frozen,
          second.networkGrant,
        ),
      ).rejects.toThrow('sandbox_network_grant_changed');
      admission.mockRejectedValueOnce(
        new RuntimePolicyError('sandbox_network_destination_blocked'),
      );
      await expect(
        selectManagedPythonExecution(await request(f, a), isolated.db),
      ).rejects.toThrow('sandbox_network_destination_blocked');
      expect(
        await getBridgeSandboxNetwork(
          f.context,
          f.workspace,
          d.device.id,
          isolated.db,
        ),
      ).toEqual({ version: 0, enabled: false, profile: null });

      // A pre-upgrade operation keeps its old, narrower grant and revocation.
      const profile = {
        ...network,
        version: 1 as const,
        allowInputTransfer: false,
      };
      await updateBridgeSandboxNetwork(
        f.context,
        f.workspace,
        d.device.id,
        { expectedVersion: 0, enabled: true, profile },
        isolated.db,
      );
      const [legacy] =
        await isolated.db`select id from allrice_bridge_sandbox_network_grants where device_id=${d.device.id}`;
      const ref = {
        id: legacy!.id as string,
        version: 1,
        digest: digest(profile),
      };
      await expect(
        resolveBridgeSandboxNetworkGrant(
          isolated.db,
          d.device,
          network,
          false,
          frozen,
          ref,
        ),
      ).resolves.toEqual(ref);
      await expect(
        resolveBridgeSandboxNetworkGrant(
          isolated.db,
          d.device,
          network,
          true,
          frozen,
          ref,
        ),
      ).rejects.toThrow('sandbox_network_transfer_not_authorized');
      await updateBridgeSandboxNetwork(
        f.context,
        f.workspace,
        d.device.id,
        { expectedVersion: 1, enabled: false, profile },
        isolated.db,
      );
      await expect(
        resolveBridgeSandboxNetworkGrant(
          isolated.db,
          d.device,
          network,
          false,
          frozen,
          ref,
        ),
      ).rejects.toThrow('sandbox_network_not_authorized');
    });

    it.each([
      'device-revoked',
      'risk-blocked',
      'member-removed',
      'feature-disabled',
    ])(
      'fences a running local network attempt when %s, while preserving the original grant and input versions',
      async (mode) => {
        vi.stubEnv('ALLRICE_SANDBOX_NETWORK_ENABLED', '1');
        const network = {
            mode: 'controlled_https' as const,
            origins: ['https://pypi.org'],
          },
          f = await fixture({
            canonicalPython: {},
            outboundCapability: true,
            sandboxExecutionPolicy: resolveSandboxExecutionPolicy([]),
            sandboxNetwork: {
              ...network,
              version: 1,
              allowInputTransfer: true,
            },
          });
        const run = await running(f, {
          ...args(),
          inputs: [
            {
              objectId: f.object.id,
              checksum: f.object.checksum,
              path: 'input.json',
            },
          ],
          location: 'local',
          execution: { version: 1, kind: 'compute' },
          network,
        });
        const lease = await run.ledger.sandboxNetworkLease(run.identity);
        const budget = await run.ledger.exchangeSandboxExecutionBudget(
          run.identity,
        );
        expect(Date.parse(lease.expiresAt)).toBe(budget.hardDeadlineAt);
        expect(lease.target).toEqual({
          kind: 'bridge',
          targetId: run.created.snapshot.binding.execution.targetId,
          deviceId: run.device.id,
        });
        expect(lease.network).toEqual(network);
        expect(lease.grantId).toBe(run.p.networkGrant?.id);
        expect(run.created.snapshot.binding.dataScope).toEqual([
          expect.objectContaining({
            content: {
              kind: 'storage_object',
              id: f.object.id,
              checksum: f.object.checksum,
            },
            destination: 'external_service',
            authorizationId: lease.grantId,
            authorizationVersion: 1,
          }),
        ]);
        await expect(
          run.ledger.sandboxNetworkLease({
            ...run.identity,
            attempt: { ...run.identity.attempt, attemptId: randomUUID() },
          }),
        ).rejects.toThrow('lease_lost');
        if (mode === 'member-removed')
          await isolated.db`update allrice_memberships set active=false where user_id=${f.user} and organization_id=${f.org}`;
        else if (mode === 'feature-disabled')
          vi.stubEnv('ALLRICE_SANDBOX_NETWORK_ENABLED', '0');
        else if (mode === 'device-revoked')
          await isolated.db`update allrice_bridge_devices set revoked_at=clock_timestamp() where id=${run.device.id}`;
        else
          admission.mockRejectedValueOnce(
            new RuntimePolicyError('sandbox_network_destination_blocked'),
          );
        try {
          await expect(
            run.ledger.sandboxNetworkLease(run.identity),
          ).rejects.toThrow();
        } finally {
          vi.stubEnv('ALLRICE_SANDBOX_NETWORK_ENABLED', '1');
        }
      },
    );

    it('freezes the managed Python budget and fences old clients, profile downgrade and disabled policy', async () => {
      const execution = { version: 1, kind: 'compute' };
      const f = await fixture({
        canonicalPython: {},
        sandboxExecutionPolicy: resolveSandboxExecutionPolicy([]),
      });
      const run = await running(f, { ...args(), location: 'local', execution });
      const budget = await run.ledger.exchangeSandboxExecutionBudget(
        run.identity,
      );
      expect(budget.spec).toEqual(run.p.executionBudget);
      expect(budget.spec.policy.maxExecutionMs).toBe(600000);
      expect(budget.deadlineAt - budget.startedAt).toBe(60000);
      expect(run.p.arguments.limits.timeoutMs).toBe(30000);
      await reportLocalPythonProfile(run.device, modernProfile, isolated.db);
      const [frozenRow] =
        await isolated.db`select execution_snapshot from allrice_employee_runs where run_id=${f.run}`;
      const frozen = EmployeeExecutionSnapshotSchema.parse(
        frozenRow!.execution_snapshot,
      );
      await expect(
        isolated.db.begin((tx) =>
          assertLocalPythonDelegation(
            tx,
            run.device,
            run.created.snapshot.binding,
            run.p,
            frozen,
          ),
        ),
      ).rejects.toThrow('bridge_authority_changed');
      await expect(
        run.ledger.exchangeSandboxExecutionBudget(run.identity),
      ).rejects.toThrow('unavailable');
      await reportLocalPythonProfile(
        run.device,
        { ...modernProfile, sandboxExecutionVersion: 1 },
        isolated.db,
      );
      vi.stubEnv('ALLRICE_SANDBOX_EXECUTION_V1_ENABLED', '0');
      try {
        await expect(
          isolated.db.begin((tx) =>
            assertLocalPythonDelegation(
              tx,
              run.device,
              run.created.snapshot.binding,
              run.p,
              frozen,
            ),
          ),
        ).rejects.toThrow('sandbox_execution_not_enabled');
        await expect(
          run.ledger.exchangeSandboxExecutionBudget(run.identity),
        ).rejects.toThrow('unavailable');
      } finally {
        vi.stubEnv('ALLRICE_SANDBOX_EXECUTION_V1_ENABLED', '1');
      }
      const old = await fixture();
      await device(old);
      await expect(
        selectManagedPythonExecution(
          await request(old, { ...args(), location: 'local', execution }),
          isolated.db,
        ),
      ).rejects.toThrow('sandbox_execution_policy_changed');
    });

    it('honors explicit local and local-only inputs, exact origin digest, revocation and cloud unknown without replay', async () => {
      const f = await fixture({
          canonicalPython: { bridgeAccess: 'read_only' },
        }),
        a = { ...args(), location: 'local' },
        r = await request(f, a);
      expect(
        (await selectManagedPythonExecution(r, isolated.db)).choice.status,
      ).toBe('unavailable');
      await expect(
        createCloudPythonOperation(
          { context: f.execution, callId: r.callId, arguments: a },
          isolated.db,
        ),
      ).rejects.toThrow('cloud_input_changed');
      const f2 = await fixture(),
        a2 = args(),
        r2 = await request(f2, a2);
      await isolated.db`update allrice_messages set content='{"text":"不要上传输入到云端","citations":[]}' where id=(select user_message_id from allrice_employee_runs where run_id=${f2.run})`;
      expect(
        (await selectManagedPythonExecution(r2, isolated.db)).choice.status,
      ).toBe('unavailable');
      const f3 = await fixture(),
        a3 = args(),
        r3 = await request(f3, a3);
      await selectManagedPythonExecution(r3, isolated.db);
      await expect(
        createCloudPythonOperation(
          {
            context: f3.execution,
            callId: r3.callId,
            arguments: { ...a3, script: 'changed' },
          },
          isolated.db,
        ),
      ).rejects.toThrow('cloud_input_changed');
      const created = await createCloudPythonOperation(
        { context: f3.execution, callId: r3.callId, arguments: a3 },
        isolated.db,
      );
      await f3.approve(created);
      const claim = await created.ledger.dispatch({
        scope: created.snapshot.binding.task.scope,
        operationId: created.snapshot.binding.attempt.operationId,
        leaseOwner: created.context.worker.id,
        leaseMs: 30000,
      });
      if (!claim) throw Error('cloud claim required');
      await created.ledger.recordReceipt({
        scope: claim.snapshot.binding.task.scope,
        operationId: claim.snapshot.binding.attempt.operationId,
        leaseToken: claim.leaseToken,
        attempt: claim.snapshot.binding.attempt,
        receiptId: randomUUID(),
        signal: { type: 'operation.uncertain', reason: 'connection_lost' },
      });
      expect(
        (await selectManagedPythonExecution(r3, isolated.db)).choice,
      ).toMatchObject({ location: 'cloud', status: 'reconcile' });
      await expect(
        created.ledger.dispatch({
          scope: created.snapshot.binding.task.scope,
          operationId: created.snapshot.binding.attempt.operationId,
          leaseOwner: created.context.worker.id,
          leaseMs: 30000,
        }),
      ).rejects.toMatchObject({ code: 'invalid_state' });
      const f4 = await fixture(),
        r4 = await request(f4, args());
      await selectManagedPythonExecution(r4, isolated.db);
      await isolated.db`update allrice_cloud_execution_grants set enabled=false where id=${f4.grant.id}`;
      await expect(
        createCloudPythonOperation(
          { context: f4.execution, callId: r4.callId, arguments: r4.arguments },
          isolated.db,
        ),
      ).rejects.toThrow('cloud_runner_unavailable');
    });

    it('requires new observed chart protocol, while binding complete local inputs/outputs/limits to the immutable original call', async () => {
      const f = await fixture(),
        d = await device(f, false),
        a = args([{ path: 'chart.png', fileName: '图表.png', format: 'png' }]),
        r = await request(f, a);
      expect(
        (await selectManagedPythonExecution(r, isolated.db)).choice.location,
      ).toBe('cloud');
      expect(
        (
          await selectManagedPythonExecution(
            { ...r, callId: randomUUID(), location: 'local' },
            isolated.db,
          )
        ).choice.status,
      ).toBe('unavailable');
      await reportLocalPythonProfile(d.device, modernProfile, isolated.db);
      expect(
        (
          await selectManagedPythonExecution(
            { ...r, callId: randomUUID() },
            isolated.db,
          )
        ).choice.location,
      ).toBe('local');
      const next = await fixture(),
        run = await running(next, {
          ...a,
          inputs: [
            {
              objectId: next.object.id,
              checksum: next.object.checksum,
              path: '原始资料.json',
            },
          ],
        });
      const [e] =
        await isolated.db`select execution_snapshot from allrice_employee_runs where run_id=${next.run}`;
      const frozen = EmployeeExecutionSnapshotSchema.parse(
        e!.execution_snapshot,
      );
      for (const argumentsInput of [
        {
          ...run.p.arguments,
          outputs: run.p.arguments.outputs.map((o) => ({
            ...o,
            fileName: 'changed.png',
          })),
        },
        {
          ...run.p.arguments,
          outputs: run.p.arguments.outputs.map((o) => ({
            ...o,
            mediaType: 'application/json',
          })),
        },
        {
          ...run.p.arguments,
          inputs: run.p.arguments.inputs.map((i) => ({
            ...i,
            path: 'changed.json',
          })),
        },
        {
          ...run.p.arguments,
          limits: {
            ...run.p.arguments.limits,
            timeoutMs: run.p.arguments.limits.timeoutMs - 1,
          },
        },
      ])
        await expect(
          isolated.db.begin((tx) =>
            assertLocalPythonDelegation(
              tx,
              run.device,
              run.created.snapshot.binding,
              { ...run.p, arguments: argumentsInput },
              frozen,
            ),
          ),
        ).rejects.toThrow('bridge_authority_changed');
    });

    it('atomically reserves aggregate output bytes and gives one writer ownership; pending duplicate cannot delete the winner', async () => {
      const f = await fixture(),
        run = await running(
          f,
          args([
            { path: 'a.txt', fileName: 'a.txt', format: 'txt' },
            { path: 'b.txt', fileName: 'b.txt', format: 'txt' },
          ]),
        );
      let releasePut!: () => void,
        started!: () => void,
        putCount = 0,
        deleteCount = 0;
      const gate = new Promise<void>((r) => (releasePut = r)),
        hasStarted = new Promise<void>((r) => (started = r));
      const tracked: StoragePort = {
        put: async (o, s) => {
          putCount++;
          started();
          await gate;
          return f.storage.put(o, s);
        },
        get: (o) => f.storage.get(o),
        exists: (o) => f.storage.exists(o),
        delete: async (o) => {
          deleteCount++;
          await f.storage.delete(o);
        },
      };
      const bytes = Buffer.alloc(2_600_000, 65),
        winner = run.upload(0, bytes, tracked);
      await hasStarted;
      await expect(run.upload(0, bytes, tracked)).rejects.toMatchObject({
        code: 'grant_invalid',
      });
      await expect(run.upload(1, bytes, tracked)).rejects.toMatchObject({
        code: 'quota_exceeded',
      });
      expect(putCount).toBe(1);
      expect(deleteCount).toBe(0);
      releasePut();
      await winner;
      expect(await run.upload(0, bytes, tracked)).toMatchObject({
        collected: true,
        sizeBytes: bytes.length,
      });
      expect(putCount).toBe(1);
      expect(deleteCount).toBe(0);
      const [usage] =
        await isolated.db`select sum(size_bytes)::bigint as bytes,count(*)::int as n from allrice_storage_objects where id=any(${run.p.arguments.outputs.map((o) => o.objectId)}::uuid[]) and state<>'deleted'`;
      expect(Number(usage!.bytes)).toBe(bytes.length);
      expect(usage!.n).toBe(1);
      const next = await fixture(),
        simultaneous = await running(
          next,
          args([
            { path: 'a.txt', fileName: 'a.txt', format: 'txt' },
            { path: 'b.txt', fileName: 'b.txt', format: 'txt' },
          ]),
        );
      let simultaneousPuts = 0;
      const concurrentStorage: StoragePort = {
        put: async (o, s) => {
          simultaneousPuts++;
          await next.storage.put(o, s);
        },
        get: (o) => next.storage.get(o),
        exists: (o) => next.storage.exists(o),
        delete: (o) => next.storage.delete(o),
      };
      const attempts = await Promise.allSettled([
        simultaneous.upload(0, bytes, concurrentStorage),
        simultaneous.upload(1, bytes, concurrentStorage),
      ]);
      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.find((a) => a.status === 'rejected')).toMatchObject({
        status: 'rejected',
        reason: { code: 'quota_exceeded' },
      });
      expect(simultaneousPuts).toBe(1);
    });

    it('reconciles a lost ready-commit acknowledgement without deleting or rewriting committed bytes', async () => {
      const f = await fixture(),
        run = await running(
          f,
          args([{ path: 'chart.png', fileName: '图表.png', format: 'png' }]),
        );
      let puts = 0,
        deletes = 0;
      const begin = isolated.db.begin;
      let beginSpy: ReturnType<typeof vi.spyOn> | undefined;
      const storage: StoragePort = {
        put: async (o, s) => {
          puts++;
          await f.storage.put(o, s);
        },
        get: (o) => f.storage.get(o),
        exists: async (o) => {
          const exists = await f.storage.exists(o);
          beginSpy = vi
            .spyOn(isolated.db, 'begin')
            .mockImplementationOnce(async (...parameters: unknown[]) => {
              await Reflect.apply(begin, isolated.db, parameters);
              throw Error('synthetic ready commit acknowledgement lost');
            });
          return exists;
        },
        delete: async (o) => {
          deletes++;
          await f.storage.delete(o);
        },
      };
      try {
        await expect(run.upload(0, png, storage)).rejects.toThrow(
          'synthetic ready commit acknowledgement lost',
        );
      } finally {
        beginSpy?.mockRestore();
      }
      const [row] =
        await isolated.db`select state from allrice_storage_objects where id=${run.p.arguments.outputs[0]!.objectId}`;
      expect(row!.state).toBe('ready');
      expect(puts).toBe(1);
      expect(deletes).toBe(0);
      const { object } = await getToolBrokerFile(
        f.execution,
        run.p.arguments.outputs[0]!.objectId,
      );
      expect(
        Buffer.from(
          await new Response(await f.storage.get(object)).arrayBuffer(),
        ),
      ).toEqual(png);
      const retryStorage: StoragePort = {
        ...storage,
        exists: (o) => f.storage.exists(o),
      };
      expect(await run.upload(0, png, retryStorage)).toMatchObject({
        collected: true,
        checksum: sha(png),
      });
      expect(puts).toBe(1);
      expect(deletes).toBe(0);
    });

    it('validates actual PNG bytes/report before ready and refuses cross-owner upload/publication', async () => {
      const f = await fixture(),
        run = await running(
          f,
          args([{ path: 'chart.png', fileName: '图表.png', format: 'png' }]),
        );
      await expect(
        run.upload(0, png, f.storage, { png: { ...pngProof, width: 2 } }),
      ).rejects.toMatchObject({ code: 'grant_invalid' });
      expect(
        await isolated.db`select id from allrice_storage_objects where id=${run.p.arguments.outputs[0]!.objectId} and state='ready'`,
      ).toHaveLength(0);
      const next = await fixture(),
        r = await running(
          next,
          args([{ path: 'chart.png', fileName: '图表.png', format: 'png' }]),
        );
      const artifact = await r.upload(0, png);
      expect(artifact.png).toEqual(pngProof);
      await r.succeed([artifact]);
      const other = await fixture();
      await expect(
        publishLocalPythonArtifacts(
          { context: other.execution, operationId: r.identity.operationId },
          next.storage,
          isolated.db,
        ),
      ).rejects.toThrow('local_python_result_unconfirmed');
      await expect(
        getToolBrokerFile(other.execution, artifact.objectId),
      ).rejects.toThrow();
    });

    it.each(['completed', 'recover-before-usage'] as const)(
      'settles the losing canonical cloud Python publication against one latest parent — %s',
      async (stage) => {
        const f = await fixture(),
          seeded = await seedOutputParent(f),
          parent = { objectId: seeded.object.id, versionId: seeded.version.id },
          db = isolated.db,
          context = f.execution,
          rootRunId = f.run,
          sessionId = f.session,
          outputCases = [
            {
              path: 'metrics.csv',
              fileName: 'metrics.csv',
              format: 'csv' as const,
              mediaType: 'text/csv',
              bytes: Buffer.from('amountCents\n250\n'),
            },
            {
              path: 'chart.png',
              fileName: 'chart.png',
              format: 'png' as const,
              mediaType: 'image/png',
              bytes: png,
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
              format: 'txt' as const,
              mediaType: 'text/plain',
              bytes: Buffer.from('saved output\n'),
            },
            {
              path: 'README.md',
              fileName: 'README.md',
              format: 'txt' as const,
              mediaType: 'text/markdown',
              bytes: Buffer.from('# Saved output\n'),
            },
          ],
          outputs = outputCases.map(({ path, fileName, format }, index) => ({
            path,
            fileName,
            format,
            ...(index === 0 ? { parentObjectId: parent.objectId } : {}),
          })),
          captured = outputCases.map(({ path, bytes, format }) => ({
            path,
            contentBase64: bytes.toString('base64'),
            ...(format === 'png' ? { png: pngProof } : {}),
          })),
          operations: Awaited<ReturnType<typeof createCloudPythonOperation>>[] =
            [];
        for (let index = 0; index < 2; index++) {
          const arguments_ = { ...args(outputs), location: 'cloud' },
            r = await request(f, arguments_);
          await selectManagedPythonExecution(r, db);
          const created = await createCloudPythonOperation(
            {
              context,
              callId: r.callId,
              arguments: arguments_,
            },
            db,
          );
          await f.approve(created);
          expect(created.payload.network).toBe('none');
          operations.push(created);
        }
        class CapturedOutputs extends CloudRunnerBackend {
          executions = 0;
          cleanups = 0;
          outcome:
            Awaited<ReturnType<CloudRunnerBackend['execute']>> | undefined;
          override async inspect() {
            return null;
          }
          override async cleanup() {
            this.cleanups++;
          }
          override async execute() {
            this.executions++;
            const outcome = {
              containerId: '1'.repeat(64),
              exitCode: 0,
              stopped: true as const,
              reason: 'completed' as const,
              output: 'synthetic physical output preserved',
              elapsedMs: 1,
              artifacts: captured,
            };
            this.outcome = structuredClone(outcome);
            return outcome;
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
            physicalOutcomeDigest: digest(physical),
            payloadDigest: digest(operations[1]!.payload),
            storageWrites: 0,
            publishedArtifacts: 0,
            absentStorageObjectsDigest: digest(
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
          digest({
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
        console.info('Canonical Python PostgreSQL publication proof', {
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
    it('queues two independent local Python publication transactions, then permits the exact winner replay', async () => {
      const f = await fixture(),
        parent = await seedOutputParent(f),
        runs: Awaited<ReturnType<typeof running>>[] = [];
      for (let i = 0; i < 2; i++) {
        const a = args([
          {
            path: 'metrics.csv',
            fileName: 'metrics.csv',
            format: 'csv',
            parentObjectId: parent.object.id,
          },
        ]);
        const r = await running(f, a, [], runs.at(-1));
        await r.succeed([
          await r.upload(0, Buffer.from('amountCents\n' + i + '\n')),
        ]);
        runs.push(r);
      }
      const publish = (index: number) =>
        publishLocalPythonArtifacts(
          {
            context: f.execution,
            operationId: runs[index]!.identity.operationId,
          },
          f.storage,
          isolated.db,
        );
      const raced = await raceQueuedOutputPublications({
        db: isolated.db,
        organizationId: f.org,
        workspaceId: f.workspace,
        first: () => publish(0),
        second: () => publish(1),
      });
      expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = raced.find((r) => r.status === 'rejected');
      expect(failed?.status === 'rejected' && String(failed.reason)).toContain(
        'project_output_parent_stale',
      );
      const winner = raced.findIndex((r) => r.status === 'fulfilled'),
        value = raced[winner]!;
      if (value.status !== 'fulfilled') throw Error('No winner');
      expect(await publish(winner)).toEqual(value.value);
      expect(
        await isolated.db`select id from allrice_deliverable_versions where series_id=${parent.version.seriesId}`,
      ).toHaveLength(2);
    });
    it.each([
      'grant-revoked',
      'parent-deleted',
      'parent-expired',
      'result-expired',
    ] as const)(
      'rechecks canonical cloud Python %s before an exact cached revision',
      async (reason) => {
        const f = await fixture(),
          parent = await seedOutputParent(f, { immutable: false });
        const a = {
          ...args([
            {
              path: 'metrics.csv',
              fileName: 'metrics.csv',
              format: 'csv',
              parentObjectId: parent.object.id,
            },
          ]),
          location: 'cloud',
        };
        const req = await request(f, a);
        await selectManagedPythonExecution(req, isolated.db);
        const created = await createCloudPythonOperation(
          { context: f.execution, callId: req.callId, arguments: a },
          isolated.db,
        );
        await f.approve(created);
        const bytes = Buffer.from('amountCents\n250\n'),
          artifacts = [
            { path: 'metrics.csv', contentBase64: bytes.toString('base64') },
          ];
        class StoppedCsv extends CloudRunnerBackend {
          executions = 0;
          override async inspect() {
            return null;
          }
          override async cleanup() {}
          override async execute() {
            this.executions++;
            return {
              containerId: '1'.repeat(64),
              exitCode: 0,
              stopped: true as const,
              reason: 'completed' as const,
              output: 'synthetic stopped receipt',
              elapsedMs: 1,
              artifacts,
            };
          }
        }
        const backend = new StoppedCsv(),
          result = await runCloudCommandOperation(created, {
            storage: f.storage,
            database: isolated.db,
            backend,
          });
        expect(result.status).toBe('succeeded');
        const v2 = result.artifacts[0]!;
        const publish = () =>
          publishCloudOperationArtifacts(
            {
              context: f.execution,
              binding: created.snapshot.binding,
              payload: created.payload,
              artifacts,
            },
            f.storage,
            isolated.db,
          );
        expect((await publish()).map((v) => v.versionId)).toEqual([
          v2.versionId,
        ]);
        const thirdArgs = {
            ...a,
            outputs: [{ ...a.outputs[0]!, parentObjectId: v2.objectId }],
          },
          thirdRequest = await request(f, thirdArgs);
        await selectManagedPythonExecution(thirdRequest, isolated.db);
        const third = await createCloudPythonOperation(
          {
            context: f.execution,
            callId: thirdRequest.callId,
            arguments: thirdArgs,
          },
          isolated.db,
        );
        await f.approve(third);
        expect(
          (
            await runCloudCommandOperation(third, {
              storage: f.storage,
              database: isolated.db,
              backend: new StoppedCsv(),
            })
          ).status,
        ).toBe('succeeded');
        expect((await publish()).map((v) => v.versionId)).toEqual([
          v2.versionId,
        ]);

        // Same original call is replayable after its own child makes the parent historical.
        expect(
          (
            await createCloudPythonOperation(
              { context: f.execution, callId: req.callId, arguments: a },
              isolated.db,
            )
          ).snapshot.binding,
        ).toEqual(created.snapshot.binding);
        const stale = await request(f, a);
        await selectManagedPythonExecution(stale, isolated.db);
        await expect(
          createCloudPythonOperation(
            { context: f.execution, callId: stale.callId, arguments: a },
            isolated.db,
          ),
        ).rejects.toThrow('project_output_parent_stale');
        if (reason === 'grant-revoked')
          await isolated.db`update allrice_cloud_execution_grants set revoked_at=clock_timestamp() where id=${f.grant.id}`;
        if (reason === 'parent-deleted')
          await isolated.db`update allrice_storage_objects set state='deleted',deleted_at=clock_timestamp() where id=${parent.object.id}`;
        if (reason === 'parent-expired')
          await isolated.db`update allrice_storage_objects set retention_until=created_at+interval '1 microsecond' where id=${parent.object.id}`;
        if (reason === 'result-expired')
          await isolated.db`update allrice_storage_objects set retention_until=created_at+interval '1 microsecond' where id=${v2.objectId}`;
        await expect(publish()).rejects.toThrow();
        expect(backend.executions).toBe(1);
        expect(
          await isolated.db`select id from allrice_deliverable_versions where series_id=${parent.version.seriesId}`,
        ).toHaveLength(3);
      },
    );

    it.each([
      'parent-expired',
      'result-expired',
      'membership-revoked',
    ] as const)(
      'rechecks local Python %s on the exact operation receipt',
      async (reason) => {
        const f = await fixture(),
          parent = await seedOutputParent(f),
          a = args([
            {
              path: 'metrics.csv',
              fileName: 'metrics.csv',
              format: 'csv',
              parentObjectId: parent.object.id,
            },
          ]);
        const r = await running(f, a);
        await r.succeed([await r.upload(0, Buffer.from('amountCents\n250\n'))]);
        const publish = () =>
          publishLocalPythonArtifacts(
            { context: f.execution, operationId: r.identity.operationId },
            f.storage,
            isolated.db,
          );
        const first = await publish();
        expect(await publish()).toEqual(first);
        const third = await running(
          f,
          args([
            {
              path: 'metrics.csv',
              fileName: 'metrics.csv',
              format: 'csv',
              parentObjectId: first[0]!.object.id,
            },
          ]),
          [],
          r,
        );
        await third.succeed([
          await third.upload(0, Buffer.from('amountCents\n500\n')),
        ]);
        await publishLocalPythonArtifacts(
          { context: f.execution, operationId: third.identity.operationId },
          f.storage,
          isolated.db,
        );
        expect(await publish()).toEqual(first);

        if (reason === 'parent-expired')
          await isolated.db`update allrice_storage_objects set retention_until=created_at+interval '1 microsecond' where id=${parent.object.id}`;
        if (reason === 'result-expired')
          await isolated.db`update allrice_storage_objects set retention_until=created_at+interval '1 microsecond' where id=${first[0]!.object.id}`;
        if (reason === 'membership-revoked')
          await isolated.db`update allrice_memberships set active=false where organization_id=${f.org} and user_id=${f.user}`;
        await expect(publish()).rejects.toThrow();
        expect(
          await isolated.db`select id from allrice_deliverable_versions where series_id=${parent.version.seriesId}`,
        ).toHaveLength(3);
      },
    );
    it.each(['png', 'csv'] as const)(
      'continues a local %s output from its frozen parent without copying ready bytes or changing the old version',
      async (format) => {
        const f = await fixture(),
          oldBytes = format === 'png' ? png : Buffer.from('amountCents\n100\n'),
          newBytes =
            format === 'png' ? revisedPng : Buffer.from('amountCents\n250\n'),
          output = {
            path: `metrics.${format}`,
            fileName: `指标 v1.${format}`,
            format,
          },
          first = await running(f, args([output]));
        await first.succeed([await first.upload(0, oldBytes)]);
        const [v1] = await publishLocalPythonArtifacts(
          { context: f.execution, operationId: first.identity.operationId },
          f.storage,
          isolated.db,
        );
        const revisedArgs = args([
          {
            ...output,
            fileName: `指标 v2.${format}`,
            parentObjectId: v1!.object.id,
          },
        ]);
        const second = await running(f, revisedArgs, [], first);
        expect(second.p.arguments.outputs[0]).not.toHaveProperty(
          'parentObjectId',
        );
        expect(second.p.arguments.inputs).toEqual([]);
        expect(second.created.snapshot.binding.dataScope).not.toContainEqual(
          expect.objectContaining({
            content: expect.objectContaining({ id: v1!.object.id }),
          }),
        );
        const [frozen] =
          await isolated.db`select original_arguments from allrice_local_python_delegations where operation_id=${second.identity.operationId}`;
        expect(frozen!.original_arguments.outputs).toEqual(revisedArgs.outputs);
        const uploaded = await second.upload(0, newBytes);
        await second.succeed([uploaded]);
        const [usage] =
          await isolated.db`select sum(size_bytes)::bigint as bytes,count(*)::int as n from allrice_storage_objects where organization_id=${f.org} and workspace_id=${f.workspace} and state<>'deleted'`;
        await isolated.db`insert into allrice_storage_quotas(organization_id,workspace_id,limit_bytes) values(${f.org},${f.workspace},${Number(usage!.bytes)})`;
        const tracked: StoragePort = {
          get: (o) => f.storage.get(o),
          exists: (o) => f.storage.exists(o),
          delete: (o) => f.storage.delete(o),
          put: vi.fn(async () => {
            throw Error('revision must reuse ready bytes');
          }),
        };
        const publish = () =>
          publishLocalPythonArtifacts(
            { context: f.execution, operationId: second.identity.operationId },
            tracked,
            isolated.db,
          );
        const current = await publish(),
          v2 = current[0]!;
        expect(v2).toMatchObject({
          fileName: `指标 v2.${format}`,
          object: {
            id: uploaded.objectId,
            mediaType: format === 'png' ? 'image/png' : 'text/csv',
            checksum: sha(newBytes),
          },
        });
        expect(v2.object.id).not.toBe(v1!.object.id);
        const [original] =
          await isolated.db`select series_id,version,parent_version_id from allrice_deliverable_versions where id=${v1!.versionId}`;
        expect(original).toMatchObject({ version: 1, parent_version_id: null });
        const [revised] =
          await isolated.db`select series_id,version,parent_version_id,file_name,format,object_id from allrice_deliverable_versions where id=${v2.versionId}`;
        expect(revised).toMatchObject({
          series_id: original!.series_id,
          version: 2,
          parent_version_id: v1!.versionId,
          file_name: `指标 v2.${format}`,
          format: format === 'png' ? 'png' : 'text',
          object_id: uploaded.objectId,
        });
        for (const [published, bytes] of [
          [v1!, oldBytes],
          [v2, newBytes],
        ] as const) {
          const stored = Buffer.from(
            await new Response(
              await f.storage.get(published.object),
            ).arrayBuffer(),
          );
          expect(stored).toEqual(bytes);
          expect(sha(stored)).toBe(published.object.checksum);
        }
        expect(await Promise.all([publish(), publish()])).toEqual([
          current,
          current,
        ]);
        expect(tracked.put).not.toHaveBeenCalled();
        expect(
          await isolated.db`select id from allrice_deliverable_versions where series_id=${original!.series_id}`,
        ).toHaveLength(2);
        const [after] =
          await isolated.db`select count(*)::int as n from allrice_storage_objects where organization_id=${f.org} and workspace_id=${f.workspace}`;
        expect(after!.n).toBe(usage!.n);
        await expect(
          createLocalPythonOperation(
            {
              selection: second.selection,
              context: f.execution,
              payload: second.p,
              arguments: {
                ...revisedArgs,
                outputs: [
                  { ...revisedArgs.outputs[0]!, parentObjectId: v2.object.id },
                ],
              },
            },
            isolated.db,
          ),
        ).rejects.toThrow('idempotency_conflict');
      },
    );

    it.each([
      'wrong-session',
      'other-owner',
      'deleted',
      'not-deliverable',
      'wrong-format',
    ] as const)(
      'rejects a local %s parent before creating an operation or an unlinked replacement',
      async (kind) => {
        const f = await fixture();
        let ownerId = f.user,
          sessionId = f.session;
        if (kind === 'other-owner') ownerId = (await fixture()).user;
        if (kind === 'wrong-session' || kind === 'other-owner') {
          sessionId = randomUUID();
          await isolated.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
            select ${sessionId},organization_id,workspace_id,${ownerId},'Parent isolation',employee_assignment_id,employee_version_id from allrice_chat_sessions where id=${f.session}`;
        }
        const parent =
          kind === 'not-deliverable'
            ? await f.upload(Buffer.from('amountCents\n100\n'), 'text/csv')
            : (
                await seedOutputParent(f, {
                  ownerId,
                  sessionId,
                  format: kind === 'wrong-format' ? 'png' : 'text',
                  immutable: kind !== 'deleted',
                })
              ).object;
        if (kind === 'deleted') {
          const file = await prepareStorageDelete(f.context, parent.id);
          await f.storage.delete(file.object);
          await completeStorageDelete(f.context, parent.id);
        }
        const before =
          await isolated.db`select id from allrice_deliverable_versions where organization_id=${f.org} order by id`;
        await expect(
          running(
            f,
            args([
              {
                path: 'metrics.csv',
                fileName: 'metrics-v2.csv',
                format: 'csv',
                parentObjectId: parent.id,
              },
            ]),
          ),
        ).rejects.toThrow();
        expect(
          await isolated.db`select id from allrice_deliverable_versions where organization_id=${f.org} order by id`,
        ).toEqual(before);
        expect(
          await isolated.db`select id from allrice_runtime_operations where run_id=${f.run}`,
        ).toHaveLength(0);
      },
    );

    it('rechecks a local parent deleted after admission and retains the unpublished ready output', async () => {
      const f = await fixture(),
        // Existing mutable exports are deletable; do not bypass the ready
        // immutable-object guard used by the Python v1/v2 positive cases.
        parent = await seedOutputParent(f, { immutable: false }),
        run = await running(
          f,
          args([
            {
              path: 'metrics.csv',
              fileName: 'metrics-v2.csv',
              format: 'csv',
              parentObjectId: parent.object.id,
            },
          ]),
        ),
        bytes = Buffer.from('amountCents\n250\n'),
        uploaded = await run.upload(0, bytes);
      await run.succeed([uploaded]);
      const file = await prepareStorageDelete(f.context, parent.object.id);
      await f.storage.delete(file.object);
      await completeStorageDelete(f.context, parent.object.id);
      await expect(
        publishLocalPythonArtifacts(
          { context: f.execution, operationId: run.identity.operationId },
          f.storage,
          isolated.db,
        ),
      ).rejects.toThrow();
      expect(
        await isolated.db`select id from allrice_deliverable_versions where organization_id=${f.org}`,
      ).toHaveLength(1);
      const [object] =
        await isolated.db`select state,checksum from allrice_storage_objects where id=${uploaded.objectId}`;
      expect(object).toMatchObject({ state: 'ready', checksum: sha(bytes) });
    });

    it.each(['canceled', 'device-revoked'] as const)(
      'does not publish a local revision after its stopped result is %s',
      async (reason) => {
        const f = await fixture(),
          parent = await seedOutputParent(f),
          run = await running(
            f,
            args([
              {
                path: 'metrics.csv',
                fileName: 'metrics-v2.csv',
                format: 'csv',
                parentObjectId: parent.object.id,
              },
            ]),
          );
        await run.succeed([
          await run.upload(0, Buffer.from('amountCents\n250\n')),
        ]);
        if (reason === 'canceled')
          await run.ledger.cancelRoot(run.identity.scope, f.run, randomUUID());
        else
          await isolated.db`update allrice_bridge_devices set revoked_at=clock_timestamp() where id=${run.device.id}`;
        await expect(
          publishLocalPythonArtifacts(
            { context: f.execution, operationId: run.identity.operationId },
            f.storage,
            isolated.db,
          ),
        ).rejects.toThrow();
        expect(
          await isolated.db`select id from allrice_deliverable_versions where series_id=${parent.version.seriesId}`,
        ).toHaveLength(1);
        expect(
          await isolated.db`select version_id from allrice_workbench_artifacts where run_id=${f.run}`,
        ).toHaveLength(0);
      },
    );

    it('publishes eight already-ready objects without copying or charging quota twice, with stable versions on replay', async () => {
      const f = await fixture({ memberRole: 'member', canonicalPython: {} }),
        outputs = Array.from({ length: 8 }, (_, i) => ({
          path: `图表 ${i}.png`,
          fileName: `图表 ${i}.png`,
          format: 'png' as const,
        })),
        run = await running(f, args(outputs));
      const artifacts = [];
      for (let i = 0; i < 8; i++) artifacts.push(await run.upload(i, png));
      await run.succeed(artifacts);
      const [usage] =
        await isolated.db`select sum(size_bytes)::bigint as bytes,count(*)::int as n from allrice_storage_objects where organization_id=${f.org} and workspace_id=${f.workspace} and state<>'deleted'`;
      await isolated.db`insert into allrice_storage_quotas(organization_id,workspace_id,limit_bytes) values(${f.org},${f.workspace},${Number(usage!.bytes)})`;
      let puts = 0;
      const tracked: StoragePort = {
        put: async () => {
          puts++;
          throw Error('publisher must retain bytes');
        },
        get: (o) => f.storage.get(o),
        exists: (o) => f.storage.exists(o),
        delete: (o) => f.storage.delete(o),
      };
      const lastId = artifacts[7]!.objectId;
      const expiredDuringRead: StoragePort = {
        ...tracked,
        get: async (o) => {
          const stream = await f.storage.get(o);
          if (o.id === lastId)
            await isolated.db`update allrice_storage_objects set retention_until=created_at+interval '1 microsecond' where id=${lastId}`;
          return stream;
        },
      };
      await expect(
        publishLocalPythonArtifacts(
          { context: f.execution, operationId: run.identity.operationId },
          expiredDuringRead,
          isolated.db,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(
        await isolated.db`select id from allrice_deliverable_versions where organization_id=${f.org}`,
      ).toHaveLength(0);
      expect(
        await isolated.db`select version_id from allrice_workbench_artifacts where organization_id=${f.org}`,
      ).toHaveLength(0);
      expect(
        await isolated.db`select id from allrice_storage_objects where id=any(${artifacts.slice(0, 7).map((a) => a.objectId)}::uuid[]) and retention_until is null`,
      ).toHaveLength(0);
      await isolated.db`update allrice_storage_objects set retention_until=clock_timestamp()+interval '1 day' where id=${lastId}`;
      const published = await publishLocalPythonArtifacts(
        { context: f.execution, operationId: run.identity.operationId },
        tracked,
        isolated.db,
      );
      expect(published).toHaveLength(8);
      expect(puts).toBe(0);
      expect(published.map((a) => a.object.id)).toEqual(
        artifacts.map((a) => a.objectId),
      );
      expect(
        await publishLocalPythonArtifacts(
          { context: f.execution, operationId: run.identity.operationId },
          tracked,
          isolated.db,
        ),
      ).toEqual(published);
      const [count] =
        await isolated.db`select count(*)::int as n from allrice_storage_objects where organization_id=${f.org} and workspace_id=${f.workspace}`;
      expect(count!.n).toBe(usage!.n);
      expect(
        await isolated.db`select id from allrice_deliverable_versions where organization_id=${f.org} and workspace_id=${f.workspace}`,
      ).toHaveLength(8);
      const rows =
        await isolated.db`select category,retention_until from allrice_storage_objects where id=any(${artifacts.map((a) => a.objectId)}::uuid[])`;
      expect(rows).toHaveLength(8);
      for (const row of rows) {
        expect(row.category).toBe('artifacts');
        expect(row.retention_until).toBeNull();
      }
      const reader = await f.storage.get(published[0]!.object);
      expect(Buffer.from(await new Response(reader).arrayBuffer())).toEqual(
        png,
      );
    });

    it.each([
      ['text/markdown', 'markdown'],
      ['text/plain', 'text'],
    ] as const)(
      'retains ready Markdown bytes and legacy %s metadata on publication and replay',
      async (mediaType, format) => {
        const f = await fixture(),
          run = await running(
            f,
            args([{ path: 'report.md', fileName: '报告.md', format: 'txt' }]),
            [mediaType],
          );
        const bytes = Buffer.from('# 对账结果\n\n差额为 **0.00 元**。\n');
        const artifact = await run.upload(0, bytes);
        await run.succeed([artifact]);
        const tracked = {
          get: f.storage.get.bind(f.storage),
          exists: f.storage.exists.bind(f.storage),
          delete: f.storage.delete.bind(f.storage),
          put: vi.fn(async () => {
            throw Error('must not rewrite ready bytes');
          }),
        };
        const published = await publishLocalPythonArtifacts(
          { context: f.execution, operationId: run.identity.operationId },
          tracked,
          isolated.db,
        );
        expect(published[0]!.object).toMatchObject({
          id: artifact.objectId,
          mediaType,
          checksum: sha(bytes),
        });
        const [version] =
          await isolated.db`select format from allrice_deliverable_versions where id=${published[0]!.versionId}`;
        expect(version!.format).toBe(format);
        expect(
          Buffer.from(
            await new Response(
              await f.storage.get(published[0]!.object),
            ).arrayBuffer(),
          ),
        ).toEqual(bytes);
        expect(
          await publishLocalPythonArtifacts(
            { context: f.execution, operationId: run.identity.operationId },
            tracked,
            isolated.db,
          ),
        ).toEqual(published);
        expect(tracked.put).not.toHaveBeenCalled();
        expect(
          await isolated.db`select id from allrice_deliverable_versions where object_id=${artifact.objectId}`,
        ).toHaveLength(1);
      },
    );

    it.each([
      ['script.txt', 'txt', 'text/markdown'],
      ['report.md', 'txt', 'text/html'],
      ['metrics.md', 'json', 'text/markdown'],
    ])(
      'refuses a changed presentation type for %s before local dispatch',
      async (fileName, format, mediaType) => {
        const f = await fixture();
        await expect(
          running(
            f,
            args([
              { path: fileName, fileName, format: format as 'txt' | 'json' },
            ]),
            [mediaType],
          ),
        ).rejects.toThrow('unavailable');
        expect(
          await isolated.db`select version_id from allrice_workbench_artifacts where organization_id=${f.org}`,
        ).toHaveLength(0);
      },
    );

    it('accepts stdout-only stopped success without StorageObject, quota or deliverable creation', async () => {
      const f = await fixture(),
        run = await running(f, args());
      await run.succeed([]);
      expect(
        await publishLocalPythonArtifacts(
          { context: f.execution, operationId: run.identity.operationId },
          f.storage,
          isolated.db,
        ),
      ).toEqual([]);
      expect(
        await isolated.db`select id from allrice_deliverable_versions where organization_id=${f.org}`,
      ).toHaveLength(0);
      expect(
        await isolated.db`select id from allrice_storage_objects where organization_id=${f.org}`,
      ).toHaveLength(1);
    });
    it('prepares the existing compute grant for Python-only employee assignments and preserves a paused grant', async () => {
      const f = await fixture();
      const [e] =
        await isolated.db`select execution_snapshot from allrice_employee_runs where run_id=${f.run}`;
      const frozen = EmployeeExecutionSnapshotSchema.parse(
        e!.execution_snapshot,
      );
      if (
        frozen.schemaVersion !== 2 ||
        !frozen.capabilitySnapshot.bindings.managedPython
      )
        throw Error('published canonical fixture required');
      expect(frozen.capabilitySnapshot.bindings.toolNames).toEqual([
        'python.execute',
      ]);
      const revisionId =
        frozen.capabilitySnapshot.bindings.managedPython.publication.revisionId;
      await isolated.db`insert into allrice_platform_employee_tenant_assignments(employee_id,revision_id,organization_id,workspace_id,tenant_employee_id,tenant_employee_version_id)
        select p.employee_id,p.id,${f.org},${f.workspace},v.employee_id,v.id from allrice_platform_employee_revisions p
        join allrice_employee_versions v on v.id=${frozen.employee.versionId} where p.id=${revisionId}`;
      const owners = [randomUUID(), randomUUID()];
      for (const user of owners) {
        await isolated.db`insert into allrice_users(id,email,display_name,password_hash) values(${user},${`${user}@example.test`},'Synthetic compute member','not-login')`;
        await isolated.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${f.org},${f.workspace},${user},'member')`;
        await isolated.db`insert into allrice_employee_assignments(organization_id,workspace_id,employee_id,employee_version_id,user_id)
          values(${f.org},${f.workspace},${frozen.employee.id},${frozen.employee.versionId},${user})`;
      }
      const paused = randomUUID();
      await isolated.db`insert into allrice_cloud_execution_grants(id,organization_id,workspace_id,owner_id,target_id,version,profile,enabled)
        values(${paused},${f.org},${f.workspace},${owners[1]!},${f.target},1,${isolated.db.json(f.grant.profile)},false)`;
      await isolated.db`update allrice_execution_targets set metadata=${isolated.db.json({ managedBy: 'allrice', profile: f.grant.profile })} where id=${f.target}`;
      await isolated.db.begin((tx) =>
        prepareTenantCloudGrants(tx, {
          organizationId: f.org,
          workspaceId: f.workspace,
        }),
      );
      const grants =
        await isolated.db`select id,owner_id,enabled,version from allrice_cloud_execution_grants where organization_id=${f.org}`;
      expect(grants.filter((g) => g.owner_id === owners[0])).toMatchObject([
        { enabled: true, version: 1 },
      ]);
      expect(grants.filter((g) => g.owner_id === owners[1])).toEqual([
        { id: paused, owner_id: owners[1], enabled: false, version: 1 },
      ]);
      expect(grants.filter((g) => g.owner_id === f.user)).toHaveLength(1);
    });
  },
);
