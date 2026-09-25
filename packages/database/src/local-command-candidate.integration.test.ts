/** Real PostgreSQL authority/approval/receipt integration; device/results below
 * are synthetic. Physical execution is separately tested in rice-bridge. */
import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { type ChangesetDocument } from '@allrice/contracts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from './assistant-runtime.fixture.ts';
import { createAssistantLocalCommandFixture } from './local-command-assistant.fixture.ts';
import {
  createLocalCommandOperation,
  listLocalCommandOperations,
} from './local-command-service.ts';
import { localCommandCandidateEvidence } from './local-command-candidate.ts';
import { reportLocalCommandProfile } from './local-command-profile.ts';
import {
  RuntimeLocalCommandSchema,
  localCommandToolchainImageV1,
} from '@allrice/contracts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const hash = (text: string | Buffer) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
suite('MET-144 candidate authority / exact version / durable receipt', () => {
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    for (const flag of [
      'ASSISTANTS',
      'LOCAL_COMMAND',
      'RUNTIME_POLICY',
      'BRIDGE_OPERATION_LEDGER',
      'WORKBENCH',
    ])
      vi.stubEnv(`ALLRICE_${flag}_ENABLED`, '1');
    database = await createAssistantFixtureDatabase();
  }, 120000);
  afterAll(async () => {
    await database?.close();
    vi.unstubAllEnvs();
  });
  async function setup() {
    const f = await createAssistantLocalCommandFixture(database.db);
    const { db } = f;
    const storage = assistantFixtureStorage(db);
    const [target] = await db<{ target_id: string; grant_id: string }[]>`
      select t.id as target_id,g.id as grant_id from allrice_execution_targets t
      join allrice_bridge_folder_grants g on t.target_key='bridge.'||g.device_id::text
      where g.device_id=${f.device.id}`;
    const profile = {
      contractVersion: 1,
      backend: 'local-vm-container-v1',
      imageDigest: localCommandToolchainImageV1,
      architecture: 'amd64',
      available: true,
      features: ['changeset_candidate'],
    };
    await reportLocalCommandProfile(f.device, profile, db);
    const original = 'throw Error("old source");';
    const execution: ChangesetDocument['execution'] = {
      targetId: target!.target_id,
      targetKind: 'rice_bridge',
      deviceId: f.device.id,
      grantId: target!.grant_id,
      grantVersion: 1,
      scopeDigest: `sha256:${'a'.repeat(64)}`,
      workCopy: { id: target!.grant_id, kind: 'in_place' },
    };
    const seriesId = randomUUID();
    let previous: string | null = null,
      version = 0;
    async function publish(
      text = 'console.log("candidate");',
      destination = execution,
    ) {
      const artifactId = randomUUID(),
        objectId = randomUUID();
      const document: ChangesetDocument = {
        contractVersion: 1,
        comparisonScope: 'changeset',
        execution: destination,
        files: [
          {
            path: 'test.mjs',
            before: { text: original, checksum: hash(original) },
            after: { text, checksum: hash(text) },
          },
        ],
      };
      const bytes = Buffer.from(JSON.stringify(document)),
        checksum = hash(bytes);
      const key = `organizations/${f.org}/workspaces/${f.workspace}/owners/${f.user}/artifacts/${objectId}`;
      await storage.put(
        {
          id: objectId,
          organizationId: f.org,
          workspaceId: f.workspace,
          ownerId: f.user,
          key,
          checksum,
          sizeBytes: bytes.length,
          mediaType: 'application/json',
          retentionUntil: null,
          deletedAt: null,
          immutable: true,
        },
        new Blob([bytes]).stream(),
      );
      await db.begin(async (tx) => {
        // Mirror production publication lock order; no Run/tool authority is
        // fabricated by this fixture helper.
        await tx`select id from allrice_chat_sessions where id=${f.task.chatSessionId!} for update`;
        if (previous)
          await tx`select id from allrice_deliverable_versions where id=${previous} for update`;
        await tx`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state,immutable)
          values(${objectId},${f.org},${f.workspace},${f.user},${key},'artifacts','application/json',${bytes.length},${checksum},'ready',true)`;
        await tx`insert into allrice_deliverable_versions(id,organization_id,workspace_id,owner_id,object_id,series_id,version,session_id,file_name,format,parent_version_id)
          values(${artifactId},${f.org},${f.workspace},${f.user},${objectId},${seriesId},${++version},${f.task.chatSessionId!},'candidate.json','json',${previous})`;
        await tx`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,execution,request_id,request_digest)
          values(${artifactId},${f.org},${f.workspace},${f.user},${f.rootRunId},'changeset',${tx.json({ kind: 'model_proposal', runId: f.rootRunId, operationId: null, stepId: null })},${tx.json(destination)},${randomUUID()},${checksum})`;
      });
      previous = artifactId;
      return { artifactId, checksum };
    }
    const candidate = await publish();
    const args = {
      ...f.args,
      files: [{ path: 'test.mjs', sha256: hash(original) }],
      candidate,
    };
    const create = (
      callId: string = randomUUID(),
      argumentsInput: unknown = args,
    ) =>
      createLocalCommandOperation(
        { context: f.context, arguments: argumentsInput, callId, storage },
        db,
      );
    const dispatch = async (created: Awaited<ReturnType<typeof create>>) => {
      await f.approve(
        await f.approvalFor(created.snapshot.binding.attempt.operationId),
      );
      return f.freshLedger().dispatch({
        scope: f.task.scope,
        operationId: created.snapshot.binding.attempt.operationId,
        leaseOwner: randomUUID(),
        leaseMs: 30000,
      });
    };
    return {
      ...f,
      candidate,
      args,
      create,
      dispatch,
      publish,
      storage,
      profile,
      execution,
    };
  }
  it.each(['localCommand', 'development'] as const)(
    'does not dispatch a candidate when the owner turns off %s',
    async (capability) => {
      const f = await setup(),
        created = await f.create();
      const settings = {
        localCommand: true,
        localBrowser: true,
        development: true,
        [capability]: false,
      };
      await f.db`update allrice_execution_targets set metadata=jsonb_set(metadata,'{bridgeSettings}',${f.db.json({ revision: 1, settings })}) where target_key=${`bridge.${f.device.id}`}`;
      await expect(f.dispatch(created)).rejects.toThrow(
        /unavailable|bridge_authority_changed/,
      );
    },
  );

  it('requires exact approval, retains immutable bytes on cold lookup and skips clients without candidate support', async () => {
    const f = await setup(),
      created = await f.create('candidate-call');
    expect(created.snapshot.status).toBe('waiting_user');
    await expect(f.create('candidate-call')).resolves.toMatchObject({
      snapshot: { binding: created.snapshot.binding },
    });
    const ledger = f.freshLedger();
    const selection = {
      scope: f.task.scope,
      deviceId: f.device.id,
      leaseMs: 30000,
      supportsLocalCommand: true,
    };
    expect(
      await ledger.claimNextBridgeOperation({
        ...selection,
        supportsChangesetCandidate: true,
      }),
    ).toBeNull();
    await f.approve(
      await f.approvalFor(created.snapshot.binding.attempt.operationId),
    );
    expect(await ledger.claimNextBridgeOperation(selection)).toBeNull();
    const lease = await ledger.claimNextBridgeOperation({
      ...selection,
      supportsChangesetCandidate: true,
    });
    const payload = RuntimeLocalCommandSchema.parse(lease?.bridgePayload);
    expect(payload.arguments.candidate).toMatchObject(f.candidate);
    expect(hash(payload.arguments.candidate!.content)).toBe(
      f.candidate.checksum,
    );
    const views = await listLocalCommandOperations(
      f.requestContext,
      f.rootRunId,
      f.db,
    );
    expect(views[0]!.candidateState).toBe('current');
  });
  it('rejects a changed version before approval/dispatch and displays old evidence as stale', async () => {
    const f = await setup(),
      created = await f.create();
    await f.approve(
      await f.approvalFor(created.snapshot.binding.attempt.operationId),
    );
    await f.publish('console.log("v2");');
    await expect(
      f.freshLedger().dispatch({
        scope: f.task.scope,
        operationId: created.snapshot.binding.attempt.operationId,
        leaseOwner: randomUUID(),
        leaseMs: 30000,
      }),
    ).rejects.toThrow('unavailable');
    expect(
      (
        await listLocalCommandOperations(f.requestContext, f.rootRunId, f.db)
      )[0]!.candidateState,
    ).toBe('stale');
    await expect(f.create()).rejects.toThrow('bridge_authority_changed');
  });
  it('rechecks current Bridge capability and folder grant at dispatch', async () => {
    const f = await setup(),
      created = await f.create();
    await f.approve(
      await f.approvalFor(created.snapshot.binding.attempt.operationId),
    );
    await reportLocalCommandProfile(
      f.device,
      { ...f.profile, features: [] },
      f.db,
    );
    await expect(f.create()).rejects.toThrow('local_runner_upgrade_required');
    await expect(
      f.freshLedger().dispatch({
        scope: f.task.scope,
        operationId: created.snapshot.binding.attempt.operationId,
        leaseOwner: randomUUID(),
        leaseMs: 30000,
      }),
    ).rejects.toThrow('unavailable');
    await reportLocalCommandProfile(f.device, f.profile, f.db);
    await f.db`update allrice_bridge_folder_grants set root_fingerprint=${'b'.repeat(64)} where id=${f.execution.grantId}`;
    await expect(
      f.freshLedger().dispatch({
        scope: f.task.scope,
        operationId: created.snapshot.binding.attempt.operationId,
        leaseOwner: randomUUID(),
        leaseMs: 30000,
      }),
    ).rejects.toThrow('unavailable');
  });
  it('does not admit forged bytes, wrong SHA, scope, destination, or a child candidate before its binding exists', async () => {
    const f = await setup(),
      other = await setup();
    await expect(
      f.create(randomUUID(), {
        ...f.args,
        candidate: { ...f.candidate, content: '{}' },
      }),
    ).rejects.toThrow();
    await expect(
      f.create(randomUUID(), {
        ...f.args,
        candidate: { ...f.candidate, checksum: hash('wrong') },
      }),
    ).rejects.toThrow();
    await expect(other.create(randomUUID(), f.args)).rejects.toThrow(
      'artifact_not_found',
    );
    await expect(
      f.create(randomUUID(), {
        ...f.args,
        files: [{ path: 'test.mjs', sha256: hash('wrong before') }],
      }),
    ).rejects.toThrow('candidate_baseline_mismatch');
    await expect(
      f.create(randomUUID(), {
        ...f.args,
        candidate: await f.publish('other', {
          ...f.execution,
          grantVersion: 2,
        }),
      }),
    ).rejects.toThrow('unavailable');
  });
  it('blocks a child without an exact development test assignment', async () => {
    const f = await setup();
    await expect(
      createLocalCommandOperation(
        {
          context: f.context,
          arguments: f.args,
          callId: randomUUID(),
          storage: f.storage,
          assistant: { runId: f.child!.runId, worker: f.worker },
        },
        f.db,
      ),
    ).rejects.toThrow('unavailable');
  });
  it.each(['preflight', 'nonzero', 'canceled'])(
    'preserves %s without turning it into success or an endless unknown',
    async (scenario) => {
      const f = await setup(),
        created = await f.create(),
        lease = await f.dispatch(created);
      const ledger = f.freshLedger(),
        payload = RuntimeLocalCommandSchema.parse(lease.bridgePayload);
      const common = {
        scope: f.task.scope,
        operationId: created.snapshot.binding.attempt.operationId,
        leaseToken: lease.leaseToken,
        attempt: lease.snapshot.binding.attempt,
      };
      const output =
        scenario === 'preflight'
          ? undefined
          : {
              backend: 'local-vm-container-v1',
              containerId: 'b'.repeat(64),
              imageDigest: localCommandToolchainImageV1,
              stopped: true,
              exitCode: scenario === 'canceled' ? 137 : 1,
              reason: scenario === 'canceled' ? 'canceled' : 'exited',
              stdout: '',
              stderr: 'synthetic device failure',
              truncated: false,
              workCopy: 'local_isolated_copy',
              sourceDirectoryModified: false,
              candidate: localCommandCandidateEvidence(payload),
            };
      const evidence = {
        id: randomUUID(),
        recordedAt: new Date().toISOString(),
        digest: hash('synthetic failure'),
      };
      if (scenario === 'canceled')
        await ledger.recordReceipt({
          ...common,
          receiptId: randomUUID(),
          signal: { type: 'operation.started', processId: randomUUID() },
        });
      const result = await ledger.recordReceipt({
        ...common,
        receiptId: randomUUID(),
        signal:
          scenario === 'canceled'
            ? { type: 'operation.stopped', effects: 'none', evidence }
            : {
                type: 'operation.outcome',
                result: { status: 'failed', effects: 'none', evidence },
              },
        evidence: {
          summary: 'synthetic only',
          ...(output ? { output } : { errorCode: 'INPUT_VERSION_CHANGED' }),
        },
      });
      expect(result.snapshot.status).toBe(
        scenario === 'canceled' ? 'canceled' : 'failed',
      );
    },
  );
  it('accepts only same-version success receipts and does not relabel after publication', async () => {
    const f = await setup(),
      created = await f.create(),
      lease = await f.dispatch(created);
    const ledger = f.freshLedger(),
      payload = RuntimeLocalCommandSchema.parse(lease.bridgePayload);
    const common = {
      scope: f.task.scope,
      operationId: created.snapshot.binding.attempt.operationId,
      leaseToken: lease.leaseToken,
      attempt: lease.snapshot.binding.attempt,
    };
    const output = {
      backend: 'local-vm-container-v1',
      containerId: 'a'.repeat(64),
      imageDigest: localCommandToolchainImageV1,
      stopped: true,
      exitCode: 0,
      reason: 'exited',
      stdout: 'synthetic device receipt',
      stderr: '',
      truncated: false,
      workCopy: 'local_isolated_copy',
      sourceDirectoryModified: false,
      candidate: localCommandCandidateEvidence(payload),
    };
    const result = (value: unknown) => ({
      ...common,
      receiptId: randomUUID(),
      signal: {
        type: 'operation.outcome' as const,
        result: {
          status: 'succeeded' as const,
          effects: 'none' as const,
          evidence: {
            id: randomUUID(),
            recordedAt: new Date().toISOString(),
            digest: hash('synthetic'),
          },
        },
      },
      evidence: { output: value, summary: 'synthetic only' },
    });
    await expect(
      ledger.recordReceipt(result({ ...output, candidate: undefined })),
    ).rejects.toThrow('invalid_state');
    await expect(
      ledger.recordReceipt(
        result({
          ...output,
          candidate: { ...output.candidate, checksum: hash('other') },
        }),
      ),
    ).rejects.toThrow('invalid_state');
    await expect(
      ledger.recordReceipt(result({ ...output, exitCode: 1 })),
    ).rejects.toThrow('invalid_state');
    await f.publish('newer version');
    const receipt = result(output);
    expect((await ledger.recordReceipt(receipt)).snapshot.status).toBe(
      'succeeded',
    );
    expect((await f.freshLedger().recordReceipt(receipt)).disposition).toBe(
      'duplicate',
    );
    const views = await listLocalCommandOperations(
      f.requestContext,
      f.rootRunId,
      f.db,
    );
    expect(views[0]!.candidateState).toBe('stale');
    expect((views[0]!.evidence as { output: unknown }).output).toEqual(output);
  });
});
