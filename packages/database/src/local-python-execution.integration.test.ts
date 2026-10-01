/** Isolated PostgreSQL authority/byte-collection regression; no VM or real pairing. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BridgeDeviceSchema,
  RuntimeLocalPythonPayloadSchema,
  RuntimeLocalPythonProfileSchema,
  RuntimeLocalPythonResultSchema,
  managedPythonPayloadForPlatform,
} from '@allrice/contracts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import { heartbeatBridgeDevice } from './bridge.ts';
import {
  runtimePolicyDigest,
  setRuntimePolicyControls,
  RuntimePolicyError,
} from './runtime-policy.ts';
import { updateWorkAutomation } from './work-automation.ts';
import { createGovernedBridgeOperationLedger } from './runtime-governed-bridge.ts';
import {
  createLocalPythonOperation,
  selectManagedPythonExecution,
  reportLocalPythonProfile,
  readManagedPythonRuntimeGrant,
  localPythonTransferAuthority,
  readLocalPythonInput,
  storeLocalPythonArtifact,
} from './local-python-execution.ts';
import { waitForLocalAdmission } from '../../../apps/worker/src/tool-broker/handlers/local-admission.ts';
import * as client from './core/client.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const release = managedPythonPayloadForPlatform('macos-x64')!;
const checksum = (bytes: Buffer) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const profile = RuntimeLocalPythonProfileSchema.parse({
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
});

suite(
  'MET164 managed Office exact frozen delegation and existing ledger',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
      storage: string;
    beforeAll(async () => {
      for (const flag of [
        'ALLRICE_RUNTIME_POLICY_ENABLED',
        'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
        'ALLRICE_WORKBENCH_ENABLED',
        'ALLRICE_CLOUD_RUNNER_ENABLED',
      ])
        vi.stubEnv(flag, '1');
      // The Python capability must not depend on the existing Node-specific gate.
      vi.stubEnv('ALLRICE_LOCAL_COMMAND_ENABLED', '0');
      database = await createAssistantFixtureDatabase();
      storage = await mkdtemp(join(tmpdir(), 'allrice-managed-office-'));
      vi.spyOn(client, 'getDatabase').mockReturnValue(database.db);
    }, 60000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await database?.close();
      if (storage) await rm(storage, { recursive: true, force: true });
    });
    const fixture = async (
      options: Parameters<typeof createCloudExecutionFixture>[2] = {
        managedOffice: {},
      },
    ) => {
      const f = await createCloudExecutionFixture(
          database.db,
          storage,
          options,
        ),
        deviceId = randomUUID(),
        token = `synthetic-python-${randomUUID()}`;
      await database.db`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at)
      values(${deviceId},${f.org},${f.workspace},${f.user},'Synthetic managed Office','macos-x64',2,array['local.python.execute'],${createHash('sha256').update(token).digest('hex')},clock_timestamp())`;
      const now = new Date().toISOString(),
        device = BridgeDeviceSchema.parse({
          id: deviceId,
          organizationId: f.org,
          workspaceId: f.workspace,
          ownerId: f.user,
          name: 'Synthetic managed Office',
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
          clientVersion: 'synthetic-managed-office',
          browser: 'unavailable',
          sandbox: 'unavailable',
          preview: 'unavailable',
          paused: false,
          readiness: [
            {
              capability: 'local.office',
              state: 'ready',
              reason: 'ready',
              missing: [],
              versions: {
                bridge: 'synthetic-managed-office',
                imageId: release.imageId,
              },
              observedAt: now,
            },
            {
              capability: 'local.python',
              state: 'ready',
              reason: 'ready',
              missing: [],
              versions: {
                bridge: 'synthetic-managed-office',
                imageId: release.imageId,
              },
              observedAt: now,
            },
          ],
        },
      });
      await reportLocalPythonProfile(device, profile, database.db);
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
        database.db,
      );
      await updateWorkAutomation(
        f.context,
        f.workspace,
        { expectedRevision: 2, capability: 'computer', enabled: true },
        database.db,
      );
      const [job] = await database.db<
        { attempt: number; lease_token: string }[]
      >`select attempt,lease_token from allrice_jobs where id=${f.execution.jobId}`;
      const args = {
        format: 'docx',
        fileName: '中文 空格.docx',
        python: {
          script:
            "from docx import Document\nd=Document();d.add_paragraph('synthetic');d.save('output/result.docx')",
          inputs: [
            {
              objectId: f.object.id,
              path: '资料 空格.json',
              checksum: f.object.checksum,
            },
          ],
        },
      };
      const request = {
        context: f.execution,
        callId: randomUUID(),
        toolName: 'workspace.export.create' as const,
        arguments: args,
        purpose: 'office' as const,
        inputs: args.python.inputs,
        jobAttempt: job!.attempt,
        jobLeaseToken: job!.lease_token,
      };
      return { ...f, device, token, request, args };
    };
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const select = (
      f: Fixture,
      extra: Partial<Parameters<typeof selectManagedPythonExecution>[0]> = {},
    ) => selectManagedPythonExecution({ ...f.request, ...extra }, database.db);
    const payload = (f: Fixture) =>
      RuntimeLocalPythonPayloadSchema.parse({
        capability: 'local.python.execute',
        arguments: {
          path: '.',
          purpose: 'office',
          origin: {
            toolName: 'workspace.export.create',
            callId: f.request.callId,
            argumentsDigest: runtimePolicyDigest(f.args),
          },
          script: f.args.python.script,
          inputs: [
            {
              ...f.args.python.inputs[0],
              sizeBytes: f.object.sizeBytes,
              mediaType: f.object.mediaType,
            },
          ],
          outputs: [
            {
              objectId: randomUUID(),
              path: 'result.docx',
              fileName: '中文 空格.docx',
              format: 'docx',
              mediaType:
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            },
          ],
          profileVersion: 1,
          imageId: release.imageId,
          architecture: release.architecture,
          isolation: 'local-vm-container-v1',
          network: 'none',
          limits: {
            timeoutMs: 60_000,
            inputBytes: 20_000_000,
            artifactBytes: 8_000_000,
            outputBytes: 65_536,
            memoryMiB: 512,
            cpuMillis: 1000,
            pids: 64,
          },
        },
      });
    const create = async (f: Fixture, p = payload(f)) =>
      createLocalPythonOperation(
        {
          selection: await select(f),
          context: f.execution,
          payload: p,
          arguments: f.args,
        },
        database.db,
      );
    const running = async (f: Fixture, p = payload(f)) => {
      const created = await create(f, p),
        ledger = createGovernedBridgeOperationLedger(f.device, {
          database: database.db,
        }),
        scope = created.snapshot.binding.task.scope;
      const claim = await ledger.claimNextBridgeOperation({
        scope,
        deviceId: f.device.id,
        leaseMs: 30_000,
        supportsManagedPython: true,
      });
      if (!claim) throw Error('managed Python claim required');
      const identity = {
        scope,
        operationId: claim.snapshot.binding.attempt.operationId,
        leaseToken: claim.leaseToken,
        attempt: claim.snapshot.binding.attempt,
      };
      await ledger.startOperation({ ...identity, receiptId: randomUUID() });
      return { created, ledger, identity, p };
    };
    const environment = async (
      f: Fixture,
      state: 'preparing' | 'ready' | 'busy',
    ) => {
      await database.db`update allrice_execution_targets set metadata=jsonb_set(metadata,'{environment,readiness,0,state}',${database.db.json(state)}) where target_key=${`bridge.${f.device.id}`} and organization_id=${f.org} and workspace_id=${f.workspace}`;
    };

    it('preserves historic snapshots, Bridge read-only/absent proof and explicit location/local-only boundaries', async () => {
      const legacy = await fixture({}),
        readOnly = await fixture({
          managedOffice: { bridgeAccess: 'read_only' },
        }),
        noProof = await fixture({ managedOffice: { freezeBinding: false } });
      for (const f of [legacy, readOnly, noProof]) {
        expect(await select(f)).toMatchObject({
          choice: { location: 'cloud', status: 'execute' },
        });
        expect(
          await select(f, { callId: randomUUID(), location: 'local' }),
        ).toMatchObject({ choice: { status: 'unavailable' } });
      }
      const f = await fixture();
      expect(await select(f)).toMatchObject({
        choice: { location: 'local', reason: 'local_ready' },
      });
      expect(
        await select(f, { callId: randomUUID(), location: 'cloud' }),
      ).toMatchObject({
        choice: { location: 'cloud', reason: 'explicit_cloud' },
      });
      await database.db`update allrice_messages set content='{"text":"不要上传输入到云端","citations":[]}' where id=(select user_message_id from allrice_employee_runs where run_id=${f.run})`;
      expect(
        await select(f, { callId: randomUUID(), location: 'cloud' }),
      ).toMatchObject({
        choice: {
          location: 'none',
          status: 'unavailable',
          reason: 'local_inputs_required',
        },
      });
    });

    it('does not claim with a legacy client, binds replay to its own operation, and retains independent Python/Node policy', async () => {
      const f = await fixture(),
        p = payload(f),
        created = await create(f, p),
        scope = created.snapshot.binding.task.scope;
      const ledger = createGovernedBridgeOperationLedger(f.device, {
        database: database.db,
      });
      expect(
        await ledger.claimNextBridgeOperation({
          scope,
          deviceId: f.device.id,
          leaseMs: 30_000,
          supportsLocalCommand: true,
        }),
      ).toBeNull();
      const claim = await ledger.claimNextBridgeOperation({
        scope,
        deviceId: f.device.id,
        leaseMs: 30_000,
        supportsManagedPython: true,
      });
      expect(claim?.snapshot.binding.action).toBe('local.python.execute');
      expect(await select(f)).toMatchObject({
        choice: { status: 'execute', location: 'local' },
      });
      expect((await create(f, p)).snapshot.binding.attempt.operationId).toBe(
        created.snapshot.binding.attempt.operationId,
      );
      expect(await select(f, { callId: randomUUID() })).toMatchObject({
        choice: { status: 'wait', reason: 'local_busy', location: 'local' },
      });
      await expect(
        select(f, { arguments: { ...f.args, fileName: 'changed.docx' } }),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      const denied = await fixture();
      await setRuntimePolicyControls(
        denied.context,
        {
          version: 3,
          enabled: true,
          mode: 'execute',
          rules: [{ action: 'local.python.execute', effect: 'deny' }],
        },
        2,
        database.db,
      );
      await expect(create(denied)).rejects.toMatchObject({
        code: 'unavailable',
      });
    });

    it('authorizes only its declared bytes, rejects fabricated collection, then settles actual stored bytes exactly once', async () => {
      const f = await fixture(),
        { ledger, identity, p } = await running(f),
        objectId = p.arguments.outputs[0]!.objectId;
      const input = await readLocalPythonInput(
        f.token,
        identity.operationId,
        identity.leaseToken,
        f.object.id,
      );
      expect(input.object.checksum).toBe(f.object.checksum);
      await expect(
        localPythonTransferAuthority(
          f.token,
          identity.operationId,
          identity.leaseToken,
          randomUUID(),
          'download',
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        localPythonTransferAuthority(
          f.token,
          identity.operationId,
          randomUUID(),
          objectId,
          'upload',
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const bytes = Buffer.from([0x50, 0x4b, 0, 0xff, 0xfe, 0x13]),
        metadata = {
          checksum: checksum(bytes),
          sizeBytes: bytes.length,
          mediaType: p.arguments.outputs[0]!.mediaType,
          validation: 'dsh_office' as const,
        };
      const result = RuntimeLocalPythonResultSchema.parse({
        backend: 'local-vm-container-v1',
        profileVersion: 1,
        purpose: 'office',
        containerId: 'a'.repeat(64),
        imageId: release.imageId,
        architecture: release.architecture,
        stopped: true,
        exitCode: 0,
        reason: 'exited',
        stdout: 'synthetic',
        stderr: '',
        truncated: false,
        artifacts: [
          { ...p.arguments.outputs[0], ...metadata, collected: true },
        ],
        workCopy: 'local_isolated_copy',
        sourceDirectoryModified: false,
      });
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
              digest: runtimePolicyDigest(result),
            },
          },
        },
        evidence: { output: result },
      };
      await expect(ledger.recordReceipt(receipt)).rejects.toMatchObject({
        code: 'invalid_state',
      });
      await expect(
        storeLocalPythonArtifact({
          token: f.token,
          id: identity.operationId,
          leaseToken: identity.leaseToken,
          objectId,
          metadata,
          stream: new Blob([Buffer.from('wrong!')]).stream(),
          storage: f.storage,
        }),
      ).rejects.toMatchObject({ code: 'grant_invalid' });
      expect(
        await database.db`select id from allrice_storage_objects where id=${objectId} and state='ready'`,
      ).toHaveLength(0);
      // A failed upload abandons the reserved metadata; a new explicit task/call
      // receives a new output identity rather than changing an immutable object.
      const next = await fixture(),
        r = await running(next),
        out = r.p.arguments.outputs[0]!,
        meta = { ...metadata, mediaType: out.mediaType };
      const collected = await storeLocalPythonArtifact({
        token: next.token,
        id: r.identity.operationId,
        leaseToken: r.identity.leaseToken,
        objectId: out.objectId,
        metadata: meta,
        stream: new Blob([bytes]).stream(),
        storage: next.storage,
      });
      expect(collected).toMatchObject({ ...out, ...meta, collected: true });
      const nextResult = { ...result, artifacts: [collected] },
        nextReceipt = {
          ...receipt,
          ...r.identity,
          receiptId: randomUUID(),
          signal: {
            ...receipt.signal,
            result: {
              ...receipt.signal.result,
              evidence: {
                ...receipt.signal.result.evidence,
                digest: runtimePolicyDigest(nextResult),
              },
            },
          },
          evidence: { output: nextResult },
        };
      expect((await r.ledger.recordReceipt(nextReceipt)).disposition).toBe(
        'applied',
      );
      expect((await r.ledger.recordReceipt(nextReceipt)).disposition).toBe(
        'duplicate',
      );
      expect((await select(next)).existingSnapshot?.status).toBe('succeeded');
      await expect(
        localPythonTransferAuthority(
          next.token,
          r.identity.operationId,
          r.identity.leaseToken,
          out.objectId,
          'upload',
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    });

    it('invalidates grant generations and other owners, and never claims or replays an unknown operation', async () => {
      const f = await fixture(),
        { ledger, identity } = await running(f),
        foreign = await fixture();
      await expect(
        localPythonTransferAuthority(
          foreign.token,
          identity.operationId,
          identity.leaseToken,
          f.object.id,
          'download',
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const before = await readManagedPythonRuntimeGrant(f.device, database.db);
      expect(
        await database.db`select id from allrice_bridge_folder_grants where device_id=${f.device.id}`,
      ).toHaveLength(0);
      await database.db`update allrice_bridge_managed_runtime_grants set runtime_generation=runtime_generation+1 where device_id=${f.device.id}`;
      expect(
        (await readManagedPythonRuntimeGrant(f.device, database.db))!
          .runtimeGeneration,
      ).toBe(before!.runtimeGeneration + 1);
      await expect(
        ledger.heartbeat({ ...identity, leaseMs: 30_000 }),
      ).rejects.toMatchObject({ code: 'unavailable' });
      await expect(
        localPythonTransferAuthority(
          f.token,
          identity.operationId,
          identity.leaseToken,
          f.object.id,
          'download',
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await ledger.recordReceipt({
        ...identity,
        receiptId: randomUUID(),
        signal: { type: 'operation.uncertain', reason: 'connection_lost' },
      });
      expect(await select(f)).toMatchObject({
        choice: { status: 'reconcile', location: 'local' },
      });
      expect(
        await ledger.claimNextBridgeOperation({
          scope: identity.scope,
          deviceId: f.device.id,
          leaseMs: 30_000,
          supportsManagedPython: true,
        }),
      ).toBeNull();
      expect(
        await database.db`select id from allrice_runtime_operations where run_id=${f.run}`,
      ).toHaveLength(1);
    });

    it('uses durable local preparation waits without a cloud operation and cancels them without leaving a running wait', async () => {
      const f = await fixture();
      await environment(f, 'preparing');
      const controller = new AbortController();
      const input = {
        context: f.execution,
        capabilities: [],
        storageRoot: storage,
        call: {
          id: f.request.callId,
          name: f.request.toolName,
          arguments: f.args,
        },
        managedBrowserJobAttempt: f.request.jobAttempt,
        managedBrowserJobLeaseToken: f.request.jobLeaseToken,
        signal: controller.signal,
      };
      const waiting = waitForLocalAdmission(input, async () => {
        const selection = await select(f);
        if (selection.choice.status === 'wait')
          throw new RuntimePolicyError('local_runner_preparing');
        return selection;
      });
      for (let i = 0; i < 60; i++) {
        const [row] =
          await database.db`select state from allrice_task_resource_waits where call_id=${f.request.callId}`;
        if (row?.state === 'waiting') break;
        await delay(25);
      }
      expect(
        await database.db`select state,reason from allrice_task_resource_waits where call_id=${f.request.callId}`,
      ).toMatchObject([{ state: 'waiting', reason: 'local_preparing' }]);
      expect(
        await database.db`select id from allrice_runtime_operations where run_id=${f.run}`,
      ).toHaveLength(0);
      controller.abort();
      await expect(waiting).rejects.toThrow();
      expect(
        await database.db`select state from allrice_task_resource_waits where call_id=${f.request.callId}`,
      ).toMatchObject([{ state: 'canceled' }]);
      const next = await fixture();
      await environment(next, 'preparing');
      const resumed = waitForLocalAdmission(
        {
          ...input,
          context: next.execution,
          call: {
            id: next.request.callId,
            name: next.request.toolName,
            arguments: next.args,
          },
          managedBrowserJobAttempt: next.request.jobAttempt,
          managedBrowserJobLeaseToken: next.request.jobLeaseToken,
          signal: undefined,
        },
        async () => {
          const s = await select(next);
          if (s.choice.status === 'wait')
            throw new RuntimePolicyError('local_runner_preparing');
          return s;
        },
      );
      await delay(80);
      await environment(next, 'ready');
      expect((await resumed).choice).toMatchObject({
        location: 'local',
        status: 'execute',
      });
      expect(
        await database.db`select state from allrice_task_resource_waits where call_id=${next.request.callId}`,
      ).toMatchObject([{ state: 'completed' }]);
    });
  },
);
