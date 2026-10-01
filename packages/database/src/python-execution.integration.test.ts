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
  type StoragePort,
} from '@allrice/contracts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import {
  createCloudPythonOperation,
  cloudStableId,
} from './cloud-execution.ts';
import { heartbeatBridgeDevice } from './bridge.ts';
import {
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
} from './local-python-execution.ts';
import { createGovernedBridgeOperationLedger } from './runtime-governed-bridge.ts';
import { normalizeCloudPythonArguments } from './cloud-authority.ts';
import { getToolBrokerFile } from './execution/tool-broker.ts';
import * as client from './core/client.ts';
import { prepareTenantCloudGrants } from './employees/development-cloud-grants.ts';
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
suite(
  'canonical Python exact cloud origin and local ready-object lifecycle',
  () => {
    let isolated: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
      storageRoot: string;
    beforeAll(async () => {
      for (const flag of [
        'ALLRICE_RUNTIME_POLICY_ENABLED',
        'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
        'ALLRICE_WORKBENCH_ENABLED',
        'ALLRICE_CLOUD_RUNNER_ENABLED',
      ])
        vi.stubEnv(flag, '1');
      vi.stubEnv('ALLRICE_LOCAL_COMMAND_ENABLED', '0');
      isolated = await createAssistantFixtureDatabase();
      storageRoot = await mkdtemp(join(tmpdir(), 'allrice-canonical-python-'));
      vi.spyOn(client, 'getDatabase').mockReturnValue(isolated.db);
    }, 60000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await isolated?.close();
      if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
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
      }[] = [],
    ) => ({
      script: 'synthetic captured outcome; never executed',
      outputs,
      limits: { artifactBytes: 4_000_000 },
    });
    const running = async (f: F, a: Record<string, unknown>) => {
      const d = await device(f),
        r = await request(f, a),
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
          outputs: normalized.outputs.map((o, index) => ({
            ...o,
            mediaType: media[o.format],
            objectId: cloudStableId(
              `managed-python-output:${f.run}:${r.callId}:${index}`,
            ),
          })),
          profileVersion: 1,
          imageId: release.imageId,
          architecture: release.architecture,
          isolation: 'local-vm-container-v1',
          network: 'none',
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
      const claim = await ledger.claimNextBridgeOperation({
        scope,
        deviceId: d.device.id,
        leaseMs: 30000,
        supportsManagedPython: true,
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
            ...(out.format === 'png' ? { png: pngProof } : {}),
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
      return { ...d, r, p, created, ledger, identity, upload, succeed };
    };

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
