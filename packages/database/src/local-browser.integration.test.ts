import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalBrowserFixture } from './local-browser.fixture.ts';
import {
  browserIdentity,
  currentBrowserWorkspace,
} from './browser-control-authority.ts';
import { publishBrowserObservationArtifact } from './browser-control-artifact.ts';
import { listBrowserControlManagement } from './browser-control-management.ts';
import {
  createBrowserOperation,
  createBrowserOperationLedger,
  listBrowserWorkspaces,
  requestBrowserControl,
  readCurrentBrowserWorkspace,
  createBrowserDirectInput,
  revokeBrowserControlGrant,
} from './browser-control.ts';
import {
  installLocalBrowserGrant,
  revokeLocalBrowserGrant,
  pendingLocalBrowserRevocations,
  acknowledgeLocalBrowserRevocation,
} from './local-browser-grants.ts';
import {
  claimLocalBrowserWorkspace,
  heartbeatLocalBrowserWorkspace,
  recordLocalBrowserStopped,
} from './local-browser-workspaces.ts';
import {
  startLocalBrowserOperation,
  recordLocalBrowserReceipt,
  nextLocalBrowserOperation,
  acknowledgeLocalBrowserControl,
  publishLocalBrowserObservation,
  requestLocalBrowserEffect,
  localBrowserEffectStatus,
  completeLocalBrowserEffect,
} from './local-browser-operations.ts';
import {
  captureLocalBrowserFile,
  takeLocalBrowserInput,
} from './local-browser-files.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import type * as Client from './core/client.ts';
let db: ReturnType<typeof postgres>,
  admin: ReturnType<typeof postgres>,
  storageRoot: string;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
const schema = `p22_browser_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const fixture = () => createLocalBrowserFixture(db, storageRoot);
suite('P22 real PostgreSQL device browser authority', () => {
  beforeAll(async () => {
    const source = process.env.ALLRICE_TEST_DATABASE_URL;
    if (!source) throw Error('dedicated DB required');
    const url = new URL(source);
    if (!(
      url.hostname === '127.0.0.1' &&
      url.port === '5432' &&
      url.username === 'a123' &&
      url.pathname === '/allrice_b2'
    ))
      throw Error('disposable DB only');
    for (const key of [
      'ALLRICE_BROWSER_CONTROL_ENABLED',
      'ALLRICE_LOCAL_BROWSER_ENABLED',
      'ALLRICE_RUNTIME_POLICY_ENABLED',
      'ALLRICE_CLOUD_RUNNER_ENABLED',
      'ALLRICE_WORKBENCH_ENABLED',
    ])
      vi.stubEnv(key, '1');
    vi.stubEnv('ALLRICE_BROWSER_CONTROL_KEY', '17'.repeat(32));
    admin = postgres(source, { max: 2, onnotice: () => {} });
    await admin.unsafe(`create schema ${schema}`);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    db = postgres(url.toString(), { max: 8, onnotice: () => {} });
    const dir = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(dir))
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await db.unsafe(await readFile(new URL(file, dir), 'utf8'));
    storageRoot = await mkdtemp(join(tmpdir(), 'allrice-p22-test-'));
    vi.stubEnv('ALLRICE_STORAGE_ROOT', storageRoot);
  }, 60000);
  afterAll(async () => {
    await db?.end();
    if (admin) {
      if (!/^p22_browser_[a-f0-9]{32}$/.test(schema))
        throw Error('unsafe schema');
      await admin.unsafe(`drop schema ${schema} cascade`);
      await admin.end();
    }
    if (storageRoot?.includes('/allrice-p22-test-'))
      await rm(storageRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  it('orders artifact quota locks before observation identity locks under deterministic concurrent admission', async () => {
    const f = await fixture(),
      b = f.browser!;
    const w = await readCurrentBrowserWorkspace(f.context, b.w.id, db);
    let quotaRequested!: () => void, identityAcquired!: () => void;
    const requested = new Promise<void>((resolve) => {
      quotaRequested = resolve;
    });
    const identity = new Promise<void>((resolve) => {
      identityAcquired = resolve;
    });
    // This only schedules actual SQL; no authority check, lock or response is mocked.
    const instrumented = new Proxy(db, {
      get(target, key) {
        if (key !== 'begin') return Reflect.get(target, key, target);
        return (work: (tx: postgres.TransactionSql) => Promise<unknown>) =>
          target.begin((tx) =>
            work(
              new Proxy(tx, {
                apply(query, thisArg, args: unknown[]) {
                  const fragments = args[0];
                  if (
                    Array.isArray(fragments) &&
                    fragments
                      .join('?')
                      .includes('select id from allrice_workspaces') &&
                    fragments.join('?').includes('for update')
                  ) {
                    quotaRequested();
                    return identity.then(() =>
                      Reflect.apply(query, thisArg, args),
                    );
                  }
                  return Reflect.apply(query, thisArg, args);
                },
              }),
            ),
          );
      },
    });
    const publication = publishBrowserObservationArtifact(
      w,
      b.obs!,
      f.storage,
      instrumented,
    );
    // Avoid an unhandled failure if PostgreSQL chooses the publishing transaction
    // as deadlock victim on the pre-fix implementation; assertion still requires success.
    void publication.catch(() => undefined);
    await requested;
    const observer = db.begin(async (tx) => {
      await browserIdentity(tx, f.context);
      identityAcquired();
      return currentBrowserWorkspace(tx, f.context, w.id);
    });
    try {
      const [artifact, observed] = await Promise.all([publication, observer]);
      expect(artifact).toBeTruthy();
      expect(observed.id).toBe(w.id);
      expect(
        await db`select version_id from allrice_workbench_artifacts where run_id=${f.run}`,
      ).toHaveLength(1);
    } finally {
      identityAcquired();
      await Promise.allSettled([publication, observer]);
    }
  }, 15000);
  it('opens without folder grant; exact approval and one START precede a durable receipt', async () => {
    const f = await fixture(),
      b = f.browser!;
    expect(
      await db`select id from allrice_bridge_folder_grants where device_id=${f.device.id}`,
    ).toHaveLength(0);
    expect((await listBrowserControlManagement(f.context, db)).grants).toEqual(
      [],
    );
    const op = await createBrowserOperation(
      f.context,
      b.command,
      randomUUID(),
      db,
    );
    expect(op.snapshot.binding.execution).toMatchObject({
      targetKind: 'rice_bridge',
      deviceId: f.device.id,
      grantId: f.localGrant.grantId,
    });
    expect(
      (
        await startLocalBrowserOperation(
          f.device,
          {
            ...b.identity!,
            operationId: op.snapshot.binding.attempt.operationId,
          },
          db,
        )
      ).mayExecute,
    ).toBe(false);
    await f.approve(op);
    const start = await startLocalBrowserOperation(
      f.device,
      { ...b.identity!, operationId: op.snapshot.binding.attempt.operationId },
      db,
    );
    expect(start.mayExecute).toBe(true);
    expect(
      (
        await startLocalBrowserOperation(
          f.device,
          {
            ...b.identity!,
            operationId: op.snapshot.binding.attempt.operationId,
          },
          db,
        )
      ).mayExecute,
    ).toBe(false);
    const receipt = {
      ...b.identity!,
      operationId: op.snapshot.binding.attempt.operationId,
      operationLeaseToken: start.operationLeaseToken!,
      receiptId: randomUUID(),
      status: 'succeeded' as const,
      networkEffect: false,
      observationId: b.obs!.id,
      downloadObjectId: null,
      errorCode: null,
    };
    await recordLocalBrowserReceipt(f.device, receipt, db);
    await recordLocalBrowserReceipt(f.device, receipt, db);
    await expect(
      recordLocalBrowserReceipt(f.device, { ...receipt, status: 'failed' }, db),
    ).rejects.toThrow('local_browser_receipt_conflict');
    const [view] = await listBrowserWorkspaces(f.context, f.run, db);
    expect(view).toMatchObject({
      transport: 'local',
      localDeviceName: f.device.name,
      persistLogin: false,
    });
    expect(view!.operations[0]!.snapshot.status).toBe('succeeded');
  });
  it('rejects overlong real-renderer observations without weakening the 60 second freshness boundary', async () => {
    const f = await fixture(),
      b = f.browser!;
    const obs = await b.observation(1, false);
    await expect(
      publishLocalBrowserObservation(
        f.device,
        {
          ...b.identity!,
          observation: {
            ...obs,
            expiresAt: new Date(
              Date.parse(obs.capturedAt) + 120_000,
            ).toISOString(),
          },
        },
        db,
      ),
    ).rejects.toMatchObject({ code: 'browser_observation_stale' });
    await expect(
      publishLocalBrowserObservation(
        f.device,
        { ...b.identity!, observation: obs },
        db,
      ),
    ).resolves.toEqual({ ok: true });
  });
  it('no frozen tool, wrong owner or reserved preview grant is admitted', async () => {
    const f = await createLocalBrowserFixture(db, storageRoot, {
      frozen: false,
    });
    await expect(f.open()).rejects.toThrow(
      'local_browser_frozen_authority_denied',
    );
    await expect(
      installLocalBrowserGrant(
        { ...f.context, actor: { type: 'user', id: randomUUID() } },
        { deviceId: f.device.id, profile: f.profile },
        db,
      ),
    ).rejects.toThrow();
    await expect(
      installLocalBrowserGrant(
        f.context,
        {
          deviceId: f.device.id,
          profile: {
            ...f.profile,
            origins: ['https://p-test.preview.allrice.invalid'],
          },
        },
        db,
      ),
    ).rejects.toThrow('browser_reserved_origin_denied');
    for (const origin of [
      'https://127.0.0.1',
      'https://localhost',
      'https://[::1]',
      'https://host.internal',
    ]) {
      await expect(
        installLocalBrowserGrant(
          f.context,
          {
            deviceId: f.device.id,
            profile: { ...f.profile, origins: [origin] },
          },
          db,
        ),
      ).rejects.toThrow('browser_public_origin_required');
    }
    const grants =
      await db`select id from allrice_browser_control_grants where owner_id=${f.user}`;
    expect(grants).toHaveLength(1);
  });
  it('same controller recovers claim; another process/device cannot claim or present a token', async () => {
    const f = await fixture(),
      b = f.browser!;
    expect(
      (await claimLocalBrowserWorkspace(f.device, b.controllerId, true, db))
        .lease?.token,
    ).toBe(b.identity!.controllerLeaseToken);
    expect(
      (await claimLocalBrowserWorkspace(f.device, randomUUID(), true, db))
        .workspace,
    ).toBeNull();
    await expect(
      heartbeatLocalBrowserWorkspace(
        { ...f.device, id: randomUUID() },
        b.identity!,
        db,
      ),
    ).rejects.toThrow();
    await expect(
      heartbeatLocalBrowserWorkspace(
        f.device,
        { ...b.identity!, controllerLeaseToken: randomUUID() },
        db,
      ),
    ).rejects.toThrow();
    await expect(f.open()).rejects.toThrow('local_browser_profile_busy');
  });
  it('takeover invalidates old exact approval; ACK requires a newly registered observation', async () => {
    const f = await fixture(),
      b = f.browser!,
      op = await createBrowserOperation(f.context, b.command, randomUUID(), db);
    await f.approve(op);
    await requestBrowserControl(
      f.context,
      b.w.id,
      {
        requestId: randomUUID(),
        expectedFence: 1,
        control: 'human',
        observationId: b.obs!.id,
      },
      db,
    );
    await expect(
      startLocalBrowserOperation(
        f.device,
        {
          ...b.identity!,
          operationId: op.snapshot.binding.attempt.operationId,
        },
        db,
      ),
    ).rejects.toThrow();
    await expect(
      acknowledgeLocalBrowserControl(
        f.device,
        { ...b.identity!, fence: 2, state: 'human', observationId: b.obs!.id },
        db,
      ),
    ).rejects.toThrow();
    const obs = await b.observation(2);
    await acknowledgeLocalBrowserControl(
      f.device,
      { ...b.identity!, fence: 2, state: 'human', observationId: obs.id },
      db,
    );
    expect(
      (await readCurrentBrowserWorkspace(f.context, b.w.id, db)).state,
    ).toBe('human');
  });
  it('expired controller cannot renew/start/reclaim; unknown stop stays busy until actual confirmation', async () => {
    const f = await fixture(),
      b = f.browser!;
    await db`update allrice_local_browser_workspaces set lease_expires_at=clock_timestamp()-interval '1 second' where browser_workspace_id=${b.w.id}`;
    expect(
      (await heartbeatLocalBrowserWorkspace(f.device, b.identity!, db))
        .workspace.revoked,
    ).toBe(true);
    expect(
      (await claimLocalBrowserWorkspace(f.device, b.controllerId, true, db))
        .workspace,
    ).toBeNull();
    await expect(
      nextLocalBrowserOperation(f.device, b.identity!, db),
    ).rejects.toThrow();
    await recordLocalBrowserStopped(
      f.device,
      { ...b.identity!, confirmed: false },
      db,
    );
    await expect(f.open()).rejects.toThrow('local_browser_profile_busy');
    await recordLocalBrowserStopped(
      f.device,
      { ...b.identity!, confirmed: true },
      db,
    );
    expect((await f.open()).id).not.toBe(b.w.id);
  });
  it('flag OFF still delivers cleanup and confirmed revocation without assigning work', async () => {
    const f = await fixture(),
      b = f.browser!;
    await revokeLocalBrowserGrant(f.context, f.localGrant.grantId, db);
    vi.stubEnv('ALLRICE_LOCAL_BROWSER_ENABLED', '0');
    try {
      const claim = await claimLocalBrowserWorkspace(
        f.device,
        randomUUID(),
        true,
        db,
      );
      expect(claim.workspace).toBeNull();
      expect(claim.revocations).toHaveLength(1);
      expect(
        (await heartbeatLocalBrowserWorkspace(f.device, b.identity!, db))
          .workspace.revoked,
      ).toBe(true);
      const ack = {
        grantId: f.localGrant.grantId,
        grantRevision: 1,
        logicalProfileId: f.localGrant.logicalProfileId,
        confirmed: true,
        errorCode: null,
      };
      await expect(
        acknowledgeLocalBrowserRevocation(f.device, ack, db),
      ).rejects.toThrow();
      await recordLocalBrowserStopped(
        f.device,
        { ...b.identity!, confirmed: true },
        db,
      );
      await acknowledgeLocalBrowserRevocation(f.device, ack, db);
      expect(await pendingLocalBrowserRevocations(f.device, db)).toHaveLength(
        0,
      );
    } finally {
      vi.stubEnv('ALLRICE_LOCAL_BROWSER_ENABLED', '1');
    }
  });
  it('grant may not be revoked through the cloud administrator adapter; unclaimed cleanup never invents a physical stop', async () => {
    const f = await createLocalBrowserFixture(db, storageRoot, {
        claim: false,
      }),
      b = f.browser!;
    await expect(
      revokeBrowserControlGrant(f.context, f.localGrant.grantId, db),
    ).rejects.toThrow('browser_grant_unavailable');
    await revokeLocalBrowserGrant(f.context, f.localGrant.grantId, db);
    const [w] =
      await db`select state from allrice_browser_workspaces where id=${b.w.id}`;
    expect(w!.state).toBe('closed');
    expect(
      (await claimLocalBrowserWorkspace(f.device, randomUUID(), false, db))
        .workspace,
    ).toBeNull();
    await acknowledgeLocalBrowserRevocation(
      f.device,
      {
        grantId: f.localGrant.grantId,
        grantRevision: 1,
        logicalProfileId: f.localGrant.logicalProfileId,
        confirmed: true,
        errorCode: null,
      },
      db,
    );
    expect(await pendingLocalBrowserRevocations(f.device, db)).toEqual([]);
  });
  it('exact registered screenshot, fence and monotonic revision govern observations', async () => {
    const f = await fixture(),
      b = f.browser!;
    await expect(
      publishLocalBrowserObservation(
        f.device,
        {
          ...b.identity!,
          observation: {
            ...b.obs!,
            id: randomUUID(),
            revision: 2,
            screenshotObjectId: randomUUID(),
          },
        },
        db,
      ),
    ).rejects.toThrow('local_browser_capture_denied');
    const newer = await b.observation(1);
    await expect(
      publishLocalBrowserObservation(
        f.device,
        { ...b.identity!, observation: b.obs! },
        db,
      ),
    ).rejects.toThrow('browser_observation_stale');
    await publishLocalBrowserObservation(
      f.device,
      { ...b.identity!, observation: newer },
      db,
    );
    await expect(
      captureLocalBrowserFile(
        f.device,
        {
          ...b.identity!,
          kind: 'screenshot',
          fence: 2,
          observationId: randomUUID(),
        },
        Buffer.from('89504e470d0a1a0a', 'hex'),
        f.storage,
        db,
      ),
    ).rejects.toThrow();
  });
  it('owned upload requires its exact START and is delivered once; arbitrary artifact substitution is rejected', async () => {
    const f = await fixture(),
      b = f.browser!;
    const upload = await createBrowserOperation(
      f.context,
      {
        ...b.command,
        action: {
          type: 'upload',
          elementId: 'e3',
          objectId: f.object.id,
          checksum: f.object.checksum,
          fileName: 'input.json',
        },
      },
      randomUUID(),
      db,
    );
    const operationId = upload.snapshot.binding.attempt.operationId;
    await expect(
      takeLocalBrowserInput(
        f.device,
        {
          ...b.identity!,
          operationId,
          operationLeaseToken: randomUUID(),
          inputKind: 'upload',
        },
        f.storage,
        db,
      ),
    ).rejects.toThrow();
    await f.approve(upload);
    const start = await startLocalBrowserOperation(
      f.device,
      { ...b.identity!, operationId },
      db,
    );
    const request = {
      ...b.identity!,
      operationId,
      operationLeaseToken: start.operationLeaseToken!,
      inputKind: 'upload' as const,
    };
    expect(
      (
        await takeLocalBrowserInput(f.device, request, f.storage, db)
      ).toString(),
    ).toBe('[12,8,5]');
    await expect(
      takeLocalBrowserInput(f.device, request, f.storage, db),
    ).rejects.toThrow('browser_input_already_consumed');
    await expect(
      createBrowserOperation(
        f.context,
        {
          ...b.command,
          action: {
            type: 'upload',
            elementId: 'e3',
            objectId: randomUUID(),
            checksum: f.object.checksum,
            fileName: 'input.json',
          },
        },
        randomUUID(),
        db,
      ),
    ).rejects.toThrow();
  });
  it('private input stays encrypted, human-only, exact-operation bound and one-use', async () => {
    const f = await fixture(),
      b = f.browser!;
    await requestBrowserControl(
      f.context,
      b.w.id,
      {
        requestId: randomUUID(),
        expectedFence: 1,
        control: 'human',
        observationId: b.obs!.id,
      },
      db,
    );
    const obs = await b.observation(2);
    await acknowledgeLocalBrowserControl(
      f.device,
      { ...b.identity!, fence: 2, state: 'human', observationId: obs.id },
      db,
    );
    const secret = 'P22-synthetic-not-a-real-password';
    const direct = await createBrowserDirectInput(
      f.context,
      b.w.id,
      { fence: 2, observationId: obs.id, elementId: 'e1', value: secret },
      db,
    );
    const command = {
      ...b.command,
      actor: 'human',
      fence: 2,
      observationId: obs.id,
      action: {
        type: 'sensitive_fill',
        elementId: 'e1',
        inputId: direct.inputId,
      },
    };
    const op = await createBrowserOperation(
        f.context,
        command,
        randomUUID(),
        db,
      ),
      operationId = op.snapshot.binding.attempt.operationId;
    expect(JSON.stringify(op.payload)).not.toContain(secret);
    const [stored] =
      await db`select envelope from allrice_browser_direct_inputs where id=${direct.inputId}`;
    expect(JSON.stringify(stored)).not.toContain(secret);
    await f.approve(op);
    const start = await startLocalBrowserOperation(
      f.device,
      { ...b.identity!, operationId },
      db,
    );
    const input = {
      ...b.identity!,
      operationId,
      operationLeaseToken: start.operationLeaseToken!,
      inputKind: 'private' as const,
    };
    const bytes = await takeLocalBrowserInput(f.device, input, f.storage, db);
    expect(bytes.toString()).toBe(secret);
    bytes.fill(0);
    await expect(
      takeLocalBrowserInput(f.device, input, f.storage, db),
    ).rejects.toThrow('browser_direct_input_unavailable');
  });
  it('download requires a running exact operation; forged capture references and receipts are rejected', async () => {
    const f = await fixture(),
      b = f.browser!,
      op = await createBrowserOperation(f.context, b.command, randomUUID(), db),
      operationId = op.snapshot.binding.attempt.operationId;
    const capture = {
      ...b.identity!,
      kind: 'download' as const,
      operationId,
      operationLeaseToken: randomUUID(),
      fileName: 'result.txt',
      mediaType: 'text/plain',
    };
    await expect(
      captureLocalBrowserFile(
        f.device,
        capture,
        Buffer.from('result'),
        f.storage,
        db,
      ),
    ).rejects.toThrow();
    await f.approve(op);
    const start = await startLocalBrowserOperation(
      f.device,
      { ...b.identity!, operationId },
      db,
    );
    const result = await captureLocalBrowserFile(
      f.device,
      { ...capture, operationLeaseToken: start.operationLeaseToken! },
      Buffer.from('result'),
      f.storage,
      db,
    );
    const receipt = {
      ...b.identity!,
      operationId,
      operationLeaseToken: start.operationLeaseToken!,
      receiptId: randomUUID(),
      status: 'succeeded' as const,
      networkEffect: false,
      observationId: null,
      downloadObjectId: randomUUID(),
      errorCode: null,
    };
    await expect(
      recordLocalBrowserReceipt(f.device, receipt, db),
    ).rejects.toThrow('local_browser_capture_denied');
    await recordLocalBrowserReceipt(
      f.device,
      { ...receipt, downloadObjectId: result.objectId },
      db,
    );
  });
  it('intercepted submissions have a second exact approval, stable retry id, and one permission token', async () => {
    const f = await fixture(),
      b = f.browser!,
      op = await createBrowserOperation(f.context, b.command, randomUUID(), db),
      operationId = op.snapshot.binding.attempt.operationId;
    await f.approve(op);
    const start = await startLocalBrowserOperation(
      f.device,
      { ...b.identity!, operationId },
      db,
    );
    const request = {
      ...b.identity!,
      operationId,
      operationLeaseToken: start.operationLeaseToken!,
      requestId: randomUUID(),
      effect: {
        url: f.profile.origins[0] + '/submit',
        urlDigest: runtimePolicyDigest('submit'),
        method: 'POST' as const,
        bodyDigest: runtimePolicyDigest('synthetic'),
        bodyBytes: 9,
      },
    };
    const effect = await requestLocalBrowserEffect(f.device, request, db);
    expect(
      (await requestLocalBrowserEffect(f.device, request, db)).operationId,
    ).toBe(effect.operationId);
    const status = {
      ...b.identity!,
      operationId,
      approvalOperationId: effect.operationId,
    };
    expect((await localBrowserEffectStatus(f.device, status, db)).status).toBe(
      'pending',
    );
    const snapshot = await createBrowserOperationLedger(
      f.context,
      db,
    ).readOperation(op.snapshot.binding.task.scope, effect.operationId);
    await f.approve({ snapshot });
    const permission = await localBrowserEffectStatus(f.device, status, db);
    expect(permission.status).toBe('ready');
    expect((await localBrowserEffectStatus(f.device, status, db)).status).toBe(
      'unknown',
    );
    await completeLocalBrowserEffect(
      f.device,
      {
        ...b.identity!,
        approvalOperationId: effect.operationId,
        permissionToken: permission.permissionToken!,
        confirmed: true,
      },
      db,
    );
    expect(
      (
        await createBrowserOperationLedger(f.context, db).readOperation(
          op.snapshot.binding.task.scope,
          effect.operationId,
        )
      ).status,
    ).toBe('succeeded');
  });
  it('revocation after START accepts facts but denies any further I/O or re-execution', async () => {
    const f = await fixture(),
      b = f.browser!,
      op = await createBrowserOperation(f.context, b.command, randomUUID(), db),
      operationId = op.snapshot.binding.attempt.operationId;
    await f.approve(op);
    const start = await startLocalBrowserOperation(
      f.device,
      { ...b.identity!, operationId },
      db,
    );
    await revokeLocalBrowserGrant(f.context, f.localGrant.grantId, db);
    await expect(
      startLocalBrowserOperation(f.device, { ...b.identity!, operationId }, db),
    ).rejects.toThrow();
    await recordLocalBrowserReceipt(
      f.device,
      {
        ...b.identity!,
        operationId,
        operationLeaseToken: start.operationLeaseToken!,
        receiptId: randomUUID(),
        status: 'unknown',
        networkEffect: true,
        observationId: null,
        downloadObjectId: null,
        errorCode: 'LOCAL_BROWSER_IO_UNKNOWN',
      },
      db,
    );
    expect(
      (
        await createBrowserOperationLedger(f.context, db).readOperation(
          op.snapshot.binding.task.scope,
          operationId,
        )
      ).status,
    ).toBe('unknown');
  });
  it('concurrent claims select one process, and heartbeat versus revocation settles without SQL deadlock', async () => {
    const f = await createLocalBrowserFixture(db, storageRoot, {
        claim: false,
      }),
      b = f.browser!;
    const claims = await Promise.all(
      [randomUUID(), randomUUID(), randomUUID()].map((id) =>
        claimLocalBrowserWorkspace(f.device, id, true, db),
      ),
    );
    const active = claims.filter((c) => c.lease);
    expect(active).toHaveLength(1);
    const identity = {
      workspaceId: b.w.id,
      controllerLeaseToken: active[0]!.lease!.token,
    };
    const results = await Promise.allSettled([
      heartbeatLocalBrowserWorkspace(f.device, identity, db),
      revokeLocalBrowserGrant(f.context, f.localGrant.grantId, db),
    ]);
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason?.code).not.toBe('40P01');
    expect(
      (await heartbeatLocalBrowserWorkspace(f.device, identity, db)).workspace
        .revoked,
    ).toBe(true);
  });
});
