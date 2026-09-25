import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalBrowserFixture } from './local-browser.fixture.ts';
import { assertRuntimeFixtureDatabase } from './runtime-fixture-database.ts';
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
  listLocalBrowserGrants,
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
  renewLocalBrowserOperations,
} from './local-browser-operations.ts';
import {
  captureLocalBrowserFile,
  takeLocalBrowserInput,
} from './local-browser-files.ts';
import { heartbeatBridgeDevice } from './bridge.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import { waitBrowserOperationResult } from '../../../apps/worker/src/browser-control/controller.js';
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
    assertRuntimeFixtureDatabase(url);
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
  it('paired member gets one prepared browser, can execute, pause and revoke without an administrator', async () => {
    const f = await createLocalBrowserFixture(db, storageRoot, { open: false });
    // Start from a freshly paired device without the legacy explicit fixture grant.
    await db`delete from allrice_local_browser_grants where grant_id=${f.localGrant.grantId}`;
    await db`delete from allrice_browser_control_grants where id=${f.localGrant.grantId}`;
    await db`update allrice_memberships set role='member' where organization_id=${f.org} and workspace_id=${f.workspace} and user_id=${f.user}`;
    const body = {
      protocolVersion: 2,
      capabilities: ['local.fs.list'],
      environment: {
        version: 1,
        clientVersion: '0.6.0-dev.1',
        paused: false,
        browser: 'ready',
        sandbox: 'unavailable',
        preview: 'unavailable',
      },
    };
    await heartbeatBridgeDevice(f.token, {
      protocolVersion: 2,
      capabilities: ['local.fs.list'],
    });
    expect(await listLocalBrowserGrants(f.context, db)).toHaveLength(0);
    await heartbeatBridgeDevice(f.token, {
      ...body,
      environment: { ...body.environment, browser: 'preparing' },
    });
    expect(await listLocalBrowserGrants(f.context, db)).toHaveLength(0);
    await Promise.all([
      heartbeatBridgeDevice(f.token, body),
      heartbeatBridgeDevice(f.token, body),
    ]);
    const grants = await listLocalBrowserGrants(f.context, db);
    expect(grants).toHaveLength(1);
    const grant = grants[0]!;
    expect(grant).toMatchObject({
      enabled: true,
      persistLogin: false,
      profile: { network: 'public_https', origins: [] },
    });
    const workspace = await f.open(randomUUID(), grant.grantId);
    expect(
      await claimLocalBrowserWorkspace(f.device, randomUUID(), true, db),
    ).toMatchObject({ workspace: { id: workspace.id } });
    await heartbeatBridgeDevice(f.token, {
      ...body,
      environment: { ...body.environment, paused: true, browser: 'paused' },
    });
    await expect(
      readCurrentBrowserWorkspace(f.context, workspace.id, db),
    ).rejects.toThrow('browser_authority_unavailable');
    await heartbeatBridgeDevice(f.token, body);
    expect((await listLocalBrowserGrants(f.context, db))[0]?.grantId).toBe(
      grant.grantId,
    );
    await revokeLocalBrowserGrant(f.context, grant.grantId, db);
    await heartbeatBridgeDevice(f.token, body);
    expect(await listLocalBrowserGrants(f.context, db)).toMatchObject([
      { grantId: grant.grantId, enabled: false },
    ]);
    await expect(f.open(randomUUID(), grant.grantId)).rejects.toThrow(
      'local_browser_grant_denied',
    );
  });

  it('a stopped preparation or old-client heartbeat stops public browser execution; old exact grants keep their scope', async () => {
    const f = await fixture();
    const body = {
      protocolVersion: 2,
      capabilities: ['local.fs.list'],
      environment: {
        version: 1,
        clientVersion: '0.6.0-dev.1',
        paused: false,
        browser: 'ready',
        sandbox: 'ready',
        preview: 'ready',
      },
    };
    await heartbeatBridgeDevice(f.token, body);
    expect(await listLocalBrowserGrants(f.context, db)).toMatchObject([
      { profile: { origins: ['https://example.com'] } },
    ]);
    await db`update allrice_browser_workspaces set profile=profile || '{"network":"public_https"}'::jsonb where id=${f.browser!.w.id}`;
    await db`update allrice_browser_control_grants set profile=profile || '{"network":"public_https"}'::jsonb where id=${f.localGrant.grantId}`;
    await readCurrentBrowserWorkspace(f.context, f.browser!.w.id, db);
    await heartbeatBridgeDevice(f.token, {
      ...body,
      environment: { ...body.environment, browser: 'unavailable' },
    });
    await expect(
      readCurrentBrowserWorkspace(f.context, f.browser!.w.id, db),
    ).rejects.toThrow('browser_authority_unavailable');
    await heartbeatBridgeDevice(f.token, body);
    await readCurrentBrowserWorkspace(f.context, f.browser!.w.id, db);
    await heartbeatBridgeDevice(f.token, {
      protocolVersion: 2,
      capabilities: ['local.fs.list'],
    });
    await expect(
      readCurrentBrowserWorkspace(f.context, f.browser!.w.id, db),
    ).rejects.toThrow('browser_authority_unavailable');
  });

  it('a pending browser-off choice stops admission before the next Bridge heartbeat', async () => {
    const f = await fixture();
    await readCurrentBrowserWorkspace(f.context, f.browser!.w.id, db);
    await db`update allrice_execution_targets set metadata=jsonb_set(metadata,'{bridgeSettings}',${db.json({ revision: 1, settings: { localCommand: true, localBrowser: false, development: true } })}) where target_key=${`bridge.${f.device.id}`}`;
    await expect(
      readCurrentBrowserWorkspace(f.context, f.browser!.w.id, db),
    ).rejects.toThrow('browser_authority_unavailable');
    await expect(f.open()).rejects.toThrow('local_browser_grant_denied');
  });

  it('heartbeat waits for browser authority without holding its device lock', async () => {
    const f = await fixture();
    let heartbeat: Promise<unknown> | undefined;
    try {
      await db.begin(async (tx) => {
        const [reader] = await tx<
          { pid: number }[]
        >`select pg_backend_pid() pid`;
        await tx`select id from allrice_execution_targets where target_key=${`bridge.${f.device.id}`} for share`;
        heartbeat = heartbeatBridgeDevice(f.token, {
          protocolVersion: 2,
          capabilities: ['local.fs.list'],
        });
        // Observe the actual wait, not an assumed scheduler delay.
        const until = Date.now() + 3000;
        let waiting = false;
        while (Date.now() < until) {
          const rows =
            await db`select pid from pg_stat_activity where ${reader!.pid}=any(pg_blocking_pids(pid))`;
          if (rows.length) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        expect(
          (await currentBrowserWorkspace(tx, f.context, f.browser!.w.id)).id,
        ).toBe(f.browser!.w.id);
      });
      await heartbeat;
    } finally {
      await heartbeat;
    }
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
                    fragments.join('?').includes('pg_advisory_xact_lock') &&
                    fragments.join('?').includes(',42)')
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
  it('MET-159 default automatic work starts an authorized local browser action once', async () => {
    const f = await fixture(),
      b = f.browser!;
    await db`delete from allrice_member_work_automation where organization_id=${f.org}`;
    const op = await createBrowserOperation(
      f.context,
      b.command,
      randomUUID(),
      db,
    );
    expect(op.snapshot.status).toBe('ready');
    const input = {
      ...b.identity!,
      operationId: op.snapshot.binding.attempt.operationId,
    };
    expect(
      (await startLocalBrowserOperation(f.device, input, db)).mayExecute,
    ).toBe(true);
    expect(
      (await startLocalBrowserOperation(f.device, input, db)).mayExecute,
    ).toBe(false);
    expect(
      await db`select id from allrice_approval_requests where resource_id=${op.snapshot.binding.attempt.operationId}`,
    ).toHaveLength(0);
  });
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
  it.each(['upload', 'download'] as const)(
    'orders %s I/O foreign-key locks before browser authority under a concurrent operation heartbeat',
    async (kind) => {
      const f = await fixture(),
        b = f.browser!;
      const uploaded =
        kind === 'upload'
          ? await f.upload(Buffer.from('synthetic-upload'), 'text/plain')
          : null;
      const command =
        kind === 'upload'
          ? {
              ...b.command,
              action: {
                type: 'upload' as const,
                elementId: 'e3',
                objectId: uploaded!.id,
                checksum: uploaded!.checksum,
                fileName: 'synthetic.txt',
              },
            }
          : {
              ...b.command,
              action: { type: 'click' as const, elementId: 'e2' },
            };
      const op = await createBrowserOperation(
        f.context,
        command,
        randomUUID(),
        db,
      );
      const operationId = op.snapshot.binding.attempt.operationId;
      await f.approve(op);
      const start = await startLocalBrowserOperation(
        f.device,
        { ...b.identity!, operationId },
        db,
      );
      let preflightDone!: () => void,
        blocked!: () => void,
        releaseIO!: () => void;
      const preflight = new Promise<void>((r) => {
        preflightDone = r;
      });
      const atLock = new Promise<void>((r) => {
        blocked = r;
      });
      const ioReady = new Promise<void>((r) => {
        releaseIO = r;
      });
      let begins = 0;
      const instrumented = new Proxy(db, {
        get(target, key) {
          if (key !== 'begin') return Reflect.get(target, key, target);
          return async (
            work: (tx: postgres.TransactionSql) => Promise<unknown>,
          ) => {
            if (++begins !== 2) return target.begin(work);
            preflightDone();
            await ioReady;
            return target.begin((tx) =>
              work(
                new Proxy(tx, {
                  apply(query, thisArg, args: unknown[]) {
                    const fragments = args[0];
                    const sql = Array.isArray(fragments)
                      ? fragments.join('?')
                      : '';
                    // Observe real SQL, never replace results. On the old code the
                    // INSERT takes an implicit operation KEY SHARE after browser;
                    // on the fixed code the root gate is requested before browser.
                    if (
                      (sql.includes('from allrice_runtime_roots') &&
                        sql.includes('for update')) ||
                      sql.includes(
                        'insert into allrice_local_browser_operation_io',
                      ) ||
                      sql.includes('insert into allrice_local_browser_captures')
                    )
                      blocked();
                    return Reflect.apply(query, thisArg, args);
                  },
                }),
              ),
            );
          };
        },
      });
      const io =
        kind === 'upload'
          ? takeLocalBrowserInput(
              f.device,
              {
                ...b.identity!,
                operationId,
                operationLeaseToken: start.operationLeaseToken!,
                inputKind: 'upload',
              },
              f.storage,
              instrumented,
            )
          : captureLocalBrowserFile(
              f.device,
              {
                ...b.identity!,
                kind: 'download',
                operationId,
                operationLeaseToken: start.operationLeaseToken!,
                fileName: 'synthetic.txt',
                mediaType: 'text/plain',
              },
              Buffer.from('synthetic-download'),
              f.storage,
              instrumented,
            );
      void io.catch(() => undefined);
      await Promise.race([
        preflight,
        io.then(() => {
          throw Error('I/O completed before publication transaction');
        }),
      ]);
      const heartbeat = db.begin(async (tx) => {
        // Exactly the ledger's root→operation locks, then its browser admission.
        await tx`select root_run_id from allrice_runtime_roots where root_run_id=${f.run} for update`;
        await tx`select id from allrice_runtime_operations where id=${operationId} for update`;
        releaseIO();
        await atLock;
        await tx`select id from allrice_browser_workspaces where id=${b.w.id} for update`;
      });
      const results = await Promise.allSettled([io, heartbeat]);
      expect(
        results.map((r) => r.status),
        JSON.stringify(
          results.map((r) =>
            r.status === 'rejected'
              ? {
                  code: r.reason?.code,
                  detail: r.reason?.detail,
                  where: r.reason?.where,
                }
              : { status: r.status },
          ),
        ),
      ).toEqual(['fulfilled', 'fulfilled']);
      if (kind === 'upload') {
        const bytes = (results[0] as PromiseFulfilledResult<Buffer>).value;
        expect(bytes.toString()).toBe('synthetic-upload');
        bytes.fill(0);
        await expect(
          takeLocalBrowserInput(
            f.device,
            {
              ...b.identity!,
              operationId,
              operationLeaseToken: start.operationLeaseToken!,
              inputKind: 'upload',
            },
            f.storage,
            db,
          ),
        ).rejects.toThrow('browser_input_already_consumed');
      } else
        expect(
          (results[0] as PromiseFulfilledResult<{ objectId: string }>).value
            .objectId,
        ).toBeTruthy();
    },
    15000,
  );
  it.each([
    'succeeded',
    'failed',
    'canceled',
    'unknown',
    'input-token-changed',
    'ledger-token-immutable',
    'attempt-immutable',
    'unapplied-receipt',
    'revoked',
    'expired-running',
  ] as const)(
    'handles only proven same-attempt completion between renewal transactions: %s',
    async (outcome) => {
      const f = await fixture(),
        b = f.browser!;
      const op = await createBrowserOperation(
        f.context,
        b.command,
        randomUUID(),
        db,
      );
      const operationId = op.snapshot.binding.attempt.operationId;
      await f.approve(op);
      const start = await startLocalBrowserOperation(
        f.device,
        { ...b.identity!, operationId },
        db,
      );
      let waiting!: () => void, resume!: () => void;
      const atHeartbeat = new Promise<void>((r) => {
        waiting = r;
      });
      const completed = new Promise<void>((r) => {
        resume = r;
      });
      let begins = 0;
      const instrumented = new Proxy(db, {
        get(target, key) {
          if (key !== 'begin') return Reflect.get(target, key, target);
          return async (
            work: (tx: postgres.TransactionSql) => Promise<unknown>,
          ) => {
            if (++begins === 2) {
              waiting();
              await completed;
            }
            return target.begin(work);
          };
        },
      });
      const renewal = renewLocalBrowserOperations(
        f.device,
        b.identity!,
        instrumented,
      );
      void renewal.catch(() => undefined);
      try {
        await Promise.race([
          atHeartbeat,
          renewal.then(() => {
            throw Error('renewal missed heartbeat transaction');
          }),
        ]);
        if (outcome === 'expired-running') {
          await db`update allrice_runtime_operations set lease_expires_at=clock_timestamp()-interval '1 second' where id=${operationId}`;
        } else if (outcome === 'canceled') {
          const ledger = createBrowserOperationLedger(f.context, db);
          await ledger.cancelRoot(
            op.snapshot.binding.task.scope,
            f.run,
            randomUUID(),
          );
          await ledger.recordReceipt({
            scope: op.snapshot.binding.task.scope,
            operationId,
            leaseToken: start.operationLeaseToken!,
            attempt: op.snapshot.binding.attempt,
            receiptId: randomUUID(),
            signal: {
              type: 'operation.stopped',
              effects: 'none',
              evidence: {
                id: randomUUID(),
                recordedAt: new Date().toISOString(),
                digest: runtimePolicyDigest('synthetic stop evidence'),
              },
            },
          });
        } else {
          await recordLocalBrowserReceipt(
            f.device,
            {
              ...b.identity!,
              operationId,
              operationLeaseToken: start.operationLeaseToken!,
              receiptId: randomUUID(),
              status: ['succeeded', 'failed', 'unknown'].includes(outcome)
                ? (outcome as 'succeeded' | 'failed' | 'unknown')
                : 'succeeded',
              networkEffect: false,
              observationId: null,
              downloadObjectId: null,
              errorCode: null,
            },
            db,
          );
        }
        if (outcome === 'input-token-changed')
          await db`update allrice_browser_operation_inputs set lease_token=${randomUUID()} where operation_id=${operationId}`;
        if (outcome === 'ledger-token-immutable')
          await expect(
            db`update allrice_runtime_operations set lease_token_hash=${'0'.repeat(64)} where id=${operationId}`,
          ).rejects.toThrow('immutable');
        if (outcome === 'attempt-immutable')
          await expect(
            db`update allrice_runtime_operations set snapshot=jsonb_set(snapshot,'{binding,attempt,attemptId}',to_jsonb(${randomUUID()}::text)) where id=${operationId}`,
          ).rejects.toThrow('immutable');
        if (outcome === 'unapplied-receipt')
          await db`update allrice_runtime_operation_receipts set disposition='stale' where operation_id=${operationId}`;
        if (outcome === 'revoked')
          await revokeLocalBrowserGrant(f.context, f.localGrant.grantId, db);
        const [before] =
          await db`select snapshot,lease_expires_at from allrice_runtime_operations where id=${operationId}`;
        resume();
        if (
          [
            'succeeded',
            'failed',
            'ledger-token-immutable',
            'attempt-immutable',
          ].includes(outcome)
        )
          await expect(renewal).resolves.toBeUndefined();
        else await expect(renewal).rejects.toBeTruthy();
        const [after] =
          await db`select snapshot,lease_expires_at from allrice_runtime_operations where id=${operationId}`;
        expect(after).toEqual(before); // No extension, retry, replay or state rewrite.
      } finally {
        resume();
        await renewal.catch(() => undefined);
      }
    },
    15000,
  );
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
  it('the shared result reader accepts the exact local receipt-bound capture without a cloud link', async () => {
    const f = await fixture(),
      b = f.browser!;
    const op = await createBrowserOperation(
      f.context,
      {
        ...b.command,
        observationId: null,
        action: { type: 'navigate', url: f.profile.origins[0] + '/' },
      },
      randomUUID(),
      db,
    );
    const operationId = op.snapshot.binding.attempt.operationId;
    await f.approve(op);
    const started = await startLocalBrowserOperation(
      f.device,
      { ...b.identity!, operationId },
      db,
    );
    const observation = await b.observation(1);
    await recordLocalBrowserReceipt(
      f.device,
      {
        ...b.identity!,
        operationId,
        operationLeaseToken: started.operationLeaseToken!,
        receiptId: randomUUID(),
        status: 'succeeded',
        networkEffect: false,
        observationId: observation.id,
        downloadObjectId: null,
        errorCode: null,
      },
      db,
    );
    const result = await waitBrowserOperationResult(
      f.context,
      b.w.id,
      operationId,
      db,
    );
    expect(result.status).toBe('succeeded');
    expect(result.observation?.id).toBe(observation.id);
    expect(result.observationRefreshRequired).toBe(false);
    const [row] =
      await db`select result_observation_id,receipt from allrice_browser_operation_inputs where operation_id=${operationId}`;
    expect(row!.result_observation_id).toBeNull();
    expect(row!.receipt.evidence.observationId).toBe(observation.id);
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
