import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BridgeCommandPayloadSchema,
  RuntimeBridgeDispatchSchema,
  RuntimeOperationSnapshotSchema,
  canonicalRuntimeBridgeJson,
  type RequestContext,
  type RuntimeActionApprovalRequest,
  type RuntimeBridgeDispatch,
} from '@allrice/contracts';
import postgres from 'postgres';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { BridgeJournal } from '../../../../apps/rice-bridge/src/journal.js';
import { RuntimeBridgeOperationClient } from '../../../../apps/rice-bridge/src/operation-client.js';
import { BridgeDualTransport } from '../../../../apps/rice-bridge/src/dual-transport.js';
import { createBridgeConnectionAuthority } from '../bridge-connections.ts';
import { createRuntimeBridgeHttpHandler } from '../../../../apps/web/lib/bridge/operation-http.js';
import { bridgeDeviceStatus } from '../bridge.ts';
import type * as DatabaseClient from '../core/client.ts';
import { createGovernedBridgeOperationLedger } from '../runtime-governed-bridge.ts';
import {
  decideRuntimeActionApproval,
  getRuntimeActionApproval,
  requestRuntimeActionApproval,
  runtimePolicyDigest,
  setRuntimePolicyControls,
} from '../runtime-policy.ts';
import { runtimeLedgerInputDigest } from './ledger.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const schema = `runtime_bridge_test_${randomUUID().replaceAll('-', '')}`;
let admin: ReturnType<typeof postgres>;
let database: ReturnType<typeof postgres>;
// Only the database connection is redirected. Authentication, policy, approval,
// operation ledger, HTTP handler, SQLite and filesystem executors are real.
vi.mock('../core/client.ts', async (original) => ({
  ...(await original<typeof DatabaseClient>()),
  getDatabase: () => database,
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanups.splice(0).reverse()) await action();
});

async function fixture(options: { wss?: boolean } = {}) {
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-b1-integration-')),
  );
  cleanups.push(() => rm(temporary, { recursive: true, force: true }));
  const workspaceRoot = join(temporary, 'workspace');
  await mkdir(workspaceRoot);
  const ids = {
    organization: randomUUID(),
    workspace: randomUUID(),
    user: randomUUID(),
    membership: randomUUID(),
    run: randomUUID(),
    policy: randomUUID(),
    target: randomUUID(),
    device: randomUUID(),
    grant: randomUUID(),
  };
  const token = `synthetic-localhost-${randomUUID()}`;
  const rootFingerprint = createHash('sha256')
    .update(workspaceRoot)
    .digest('hex');
  const policyPayload = {
    memberships: [
      {
        id: ids.membership,
        userId: ids.user,
        organizationId: ids.organization,
        workspaceId: ids.workspace,
        role: 'admin',
        active: true,
      },
    ],
    grants: [
      {
        resourceType: 'job',
        action: 'job:execute',
        workspaceId: ids.workspace,
      },
    ],
  };
  const context: RequestContext = {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    actor: { type: 'user', id: ids.user },
    organizationId: ids.organization,
    workspaceId: ids.workspace,
    memberships: [],
    authenticatedAt: new Date().toISOString(),
  };
  await database.begin(async (sql) => {
    await sql`insert into allrice_users(id,email,display_name,password_hash) values (${ids.user},${`${ids.user}@example.test`},'B1 HTTP fixture','not-a-login')`;
    await sql`insert into allrice_organizations(id,slug,name) values (${ids.organization},${`b1-${ids.organization}`},'B1 HTTP fixture')`;
    await sql`insert into allrice_workspaces(id,organization_id,slug,name) values (${ids.workspace},${ids.organization},'test','B1 HTTP fixture')`;
    await sql`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values (${ids.membership},${ids.organization},${ids.workspace},${ids.user},'admin')`;
    await sql`insert into allrice_policy_snapshots(id,organization_id,subject_id,version,payload,expires_at) values (${ids.policy},${ids.organization},${ids.user},1,${sql.json(policyPayload)},clock_timestamp()+interval '1 hour')`;
    await sql`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input) values (${ids.run},${ids.organization},${ids.workspace},${ids.user},'running',${ids.policy},'{}','{}')`;
    await sql`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at) values (${ids.device},${ids.organization},${ids.workspace},${ids.user},'B1 synthetic device','macos-x64',2,array['local.fs.write','local.fs.read'],${createHash('sha256').update(token).digest('hex')},clock_timestamp())`;
    await sql`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities,concurrency_limit,timeout_seconds,metadata,last_heartbeat_at) values (${ids.target},${ids.organization},${ids.workspace},${`bridge.${ids.device}`},'rice_bridge','B1 synthetic target','online',${sql.json(['files.read', 'files.write'])},1,120,${sql.json({ bridgeDeviceId: ids.device })},clock_timestamp())`;
    await sql`insert into allrice_bridge_folder_grants(id,organization_id,workspace_id,owner_id,device_id,label,root_fingerprint) values (${ids.grant},${ids.organization},${ids.workspace},${ids.user},${ids.device},'B1 synthetic folder',${rootFingerprint})`;
  });
  await setRuntimePolicyControls(
    context,
    {
      version: 1,
      enabled: true,
      mode: 'execute',
      rules: [{ action: 'local.fs.write', effect: 'ask' }],
    },
    null,
    database,
  );
  const device = (await bridgeDeviceStatus(token)).device;
  const payload = BridgeCommandPayloadSchema.parse({
    capability: 'local.fs.write',
    arguments: {
      path: 'result.txt',
      content: 'one exact approved write',
      expectedSha256: null,
    },
  });
  const snapshot = RuntimeOperationSnapshotSchema.parse({
    contractVersion: 1,
    binding: {
      task: {
        scope: {
          organizationId: ids.organization,
          workspaceId: ids.workspace,
          projectId: null,
        },
        chatSessionId: null,
        runId: ids.run,
        rootRunId: ids.run,
        parentRunId: null,
        frozenConfiguration: {
          employeeVersionId: null,
          digest: runtimePolicyDigest({}),
        },
      },
      attempt: {
        operationId: randomUUID(),
        attemptId: randomUUID(),
        attemptNumber: 1,
        generation: 0,
        fence: 1,
      },
      requestedBy: { type: 'user', id: ids.user },
      policy: {
        snapshotId: ids.policy,
        digest: runtimePolicyDigest(policyPayload),
      },
      execution: {
        targetId: ids.target,
        targetKind: 'rice_bridge',
        deviceId: ids.device,
        grantId: ids.grant,
        grantVersion: 1,
        scopeDigest: `sha256:${rootFingerprint}`,
        workCopy: { id: ids.grant, kind: 'in_place' },
      },
      action: payload.capability,
      inputDigest: runtimePolicyDigest(payload),
      dataScope: [],
      baseline: [],
      command: null,
    },
    stepId: null,
    agentInstanceId: null,
    processId: null,
    cancelRequestId: null,
    idempotencyKey: randomUUID(),
    status: 'planned',
    result: null,
  });
  const ledger = createGovernedBridgeOperationLedger(device, {
    database,
    initialOperation: { binding: snapshot.binding, payload },
  });
  const scope = snapshot.binding.task.scope;
  const operationId = snapshot.binding.attempt.operationId;
  await ledger.createRoot({
    task: snapshot.binding.task,
    deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    budgets: [
      {
        metric: 'tool_calls',
        unit: 'calls',
        currency: null,
        capacity: 10,
        source: { kind: 'bridge', sourceId: ids.device },
      },
    ],
  });
  const created = await ledger.createOperation({
    snapshot,
    bridgePayload: payload,
    reservations: [
      { metric: 'tool_calls', accountingId: randomUUID(), amount: 1 },
    ],
  });
  const approval = await requestRuntimeActionApproval(
    ledger.policyOptions,
    snapshot.binding,
    600_000,
    database,
  );
  async function approve(request: RuntimeActionApprovalRequest = approval) {
    return decideRuntimeActionApproval(
      context,
      request.approvalId,
      {
        contractVersion: 1,
        direction: 'response',
        kind: 'action_approval',
        requestId: request.requestId,
        version: request.version,
        requestDigest: request.requestDigest,
        task: request.task,
        responseId: randomUUID(),
        respondedBy: ids.user,
        respondedAt: new Date().toISOString(),
        approvalId: request.approvalId,
        decision: 'approved',
      },
      database,
    );
  }
  let before: ((action: string) => Promise<void>) | null = null;
  let loseNextResponse: 'next' | 'start' | 'receipts' | null = null;
  const handler = createRuntimeBridgeHttpHandler({
    enabled: () => true,
    authenticate: bridgeDeviceStatus,
    ledgerForDevice: async (authenticated) =>
      createGovernedBridgeOperationLedger(authenticated, { database }),
  });
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://local').pathname;
      const action = pathname.endsWith('/next')
        ? 'next'
        : pathname.endsWith('/start')
          ? 'start'
          : 'receipts';
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.from(chunk as Uint8Array));
      if (before) await before(action);
      const result = await handler(
        new Request(`http://local${pathname}`, {
          method: 'POST',
          headers: {
            authorization: String(request.headers.authorization ?? ''),
            'content-type': 'application/json',
          },
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        }),
        action,
        pathname.split('/').at(-2),
      );
      if (loseNextResponse === action && result.ok) {
        loseNextResponse = null;
        response.destroy();
        return;
      }
      response.statusCode = result.status;
      response.setHeader('content-type', 'application/json');
      response.end(await result.text());
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(
        JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : 'fixture error',
          },
        }),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('HTTP fixture not listening');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const origin = `http://127.0.0.1:${address.port}`;
  if (options.wss) {
    // Runtime import preserves the production .mjs gateway, not a test copy.
    const modulePath = '../../../../apps/web/server/bridge-socket.mjs';
    const { createBridgeSocketGateway, createBridgeLoopbackDispatch } =
      await import(modulePath);
    const gateway = await createBridgeSocketGateway({
      authority: createBridgeConnectionAuthority(database),
      enabled: () => true,
      dispatch: createBridgeLoopbackDispatch(address.port),
      heartbeatMs: 100,
    });
    server.on('upgrade', (request, socket, head) => {
      void gateway.upgrade(request, socket, head);
    });
    cleanups.push(() => gateway.close());
  }
  const config = {
    server: origin,
    deviceId: ids.device,
    deviceName: 'B1 synthetic',
    grants: [
      {
        id: ids.grant,
        label: 'B1 synthetic folder',
        rootPath: workspaceRoot,
        rootFingerprint,
      },
    ],
  };
  const journalInput = {
    directory: join(temporary, 'private-journal'),
    server: origin,
    deviceId: ids.device,
  };
  const journal = await BridgeJournal.open(journalInput);
  cleanups.push(() => journal.close());
  const transport = options.wss
    ? new BridgeDualTransport({
        server: origin,
        token,
        deviceId: ids.device,
        retryBaseMs: 1,
      })
    : undefined;
  if (transport) cleanups.push(async () => transport.close());
  const client = new RuntimeBridgeOperationClient({
    config,
    token,
    journal,
    request: transport?.request,
  });
  async function post(path: string, body?: unknown, credential = token) {
    return fetch(`${origin}/api/v1/bridge/device/operations/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function claim(): Promise<RuntimeBridgeDispatch> {
    const response = await post('next');
    const body = (await response.json()) as { dispatch?: unknown };
    if (!response.ok) throw new Error(`claim failed: ${JSON.stringify(body)}`);
    return RuntimeBridgeDispatchSchema.parse(body.dispatch);
  }
  return {
    ids,
    temporary,
    workspaceRoot,
    token,
    scope,
    operationId,
    snapshot,
    payload,
    ledger,
    created,
    approval,
    approve,
    context,
    config,
    journalInput,
    journal,
    client,
    post,
    claim,
    beforeAction(action: ((action: string) => Promise<void>) | null) {
      before = action;
    },
    loseResponse(action: 'next' | 'start' | 'receipts') {
      loseNextResponse = action;
    },
  };
}

suite(
  'B1 actual policy + PostgreSQL + authenticated HTTP + durable device execution',
  () => {
    beforeAll(async () => {
      const source = process.env.ALLRICE_TEST_DATABASE_URL;
      if (!source)
        throw new Error(
          'Explicit ALLRICE_TEST_DATABASE_URL required; never fall back to production',
        );
      const base = new URL(source);
      base.search = '';
      admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
      await admin.begin(async (sql) => {
        await sql`select pg_advisory_xact_lock(20260907, 1)`;
        await sql`create extension if not exists vector with schema public`;
        await sql`create extension if not exists pg_trgm with schema public`;
      });
      await admin.unsafe(`create schema ${schema}`);
      base.searchParams.set('options', `-csearch_path=${schema},public`);
      database = postgres(base.toString(), { max: 12, onnotice: () => {} });
      const directory = new URL('../../migrations/', import.meta.url);
      for (const name of (await readdir(directory))
        .filter((name) => name.endsWith('.sql'))
        .sort()) {
        await database.unsafe(await readFile(new URL(name, directory), 'utf8'));
      }
    }, 120_000);
    afterAll(async () => {
      await database?.end({ timeout: 5 });
      if (admin && /^runtime_bridge_test_[a-f0-9]{32}$/.test(schema))
        await admin.unsafe(`drop schema ${schema} cascade`);
      await admin?.end({ timeout: 5 });
    });

    it('persists Ask; only exact approval permits dispatch, start and real write', async () => {
      const f = await fixture();
      expect(f.created.status).toBe('waiting_user');
      expect(
        (
          await getRuntimeActionApproval(
            f.context,
            f.approval.approvalId,
            database,
          )
        ).response,
      ).toBeNull();
      expect(
        (await f.ledger.readOperation(f.scope, f.operationId)).status,
      ).toBe('waiting_user');
      expect(await f.client.pollOnce()).toBe(false);
      expect(await f.ledger.readReceipts(f.scope, f.operationId)).toEqual([]);
      await expect(
        readFile(join(f.workspaceRoot, 'result.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await f.approve();
      expect(await f.client.pollOnce()).toBe(true);
      expect(await readFile(join(f.workspaceRoot, 'result.txt'), 'utf8')).toBe(
        'one exact approved write',
      );
      const state = await f.ledger.readOperation(f.scope, f.operationId);
      expect(state).toMatchObject({
        status: 'succeeded',
        result: { status: 'succeeded', effects: 'applied' },
      });
      const approval = await getRuntimeActionApproval(
        f.context,
        f.approval.approvalId,
        database,
      );
      expect(approval.consumedAt).not.toBeNull();
      const evidence = await f.ledger.readReceipts(f.scope, f.operationId);
      expect(evidence).toHaveLength(2); // one execution preflight + one outcome
      expect(
        (await f.ledger.readEvents(f.scope, f.operationId)).filter(
          (event) => event.signal.type === 'operation.outcome',
        ),
      ).toHaveLength(1);
      expect(await f.journal.pending()).toEqual([]);
    });

    it('P12 lost claim response resumes the exact unstarted lease without another approval/event/effect', async () => {
      const f = await fixture();
      await f.approve();
      f.loseResponse('next');
      await expect(f.client.pollOnce()).rejects.toThrow();
      const snapshot = await f.ledger.readOperation(f.scope, f.operationId);
      expect(snapshot.status).toBe('dispatched');
      await expect(
        readFile(join(f.workspaceRoot, 'result.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const [before] =
        await database`select lease_token_hash,lease_expires_at from allrice_runtime_operations where id=${f.operationId}`;
      // Concurrent HTTP clients (and the WSS HTTP adapter) must obtain precisely
      // the same binding/token/expiry, even with no shared request ID or memory.
      const responses = await Promise.all([
        f.post('next', { supportsClaimRecovery: true }),
        f.post('next', { supportsClaimRecovery: true }),
      ]);
      const bodies = await Promise.all(responses.map((r) => r.json()));
      expect(bodies[0]).toEqual(bodies[1]);
      const recovered = RuntimeBridgeDispatchSchema.parse(
        (bodies[0] as { dispatch: unknown }).dispatch,
      );
      expect(
        createHash('sha256').update(recovered.leaseToken).digest('hex'),
      ).toBe(before!.lease_token_hash);
      expect(recovered.leaseExpiresAt).toBe(
        (before!.lease_expires_at as Date).toISOString(),
      );
      await f.client.handle(recovered);
      await f.client.handle(recovered);
      await f.client.flush();
      expect(await readFile(join(f.workspaceRoot, 'result.txt'), 'utf8')).toBe(
        'one exact approved write',
      );
      const events = await f.ledger.readEvents(f.scope, f.operationId);
      expect(
        events.filter((e) => e.signal.type === 'operation.dispatched'),
      ).toHaveLength(1);
      expect(
        events.filter((e) => e.signal.type === 'operation.outcome'),
      ).toHaveLength(1);
      expect(
        (await f.post('next', { supportsClaimRecovery: true })).status,
      ).toBe(200);
    });

    it.each(['next', 'start', 'receipts'] as const)(
      'P12 real WSS/HTTP/PG/SQLite lost %s response does not duplicate an actual file write',
      async (stage) => {
        const f = await fixture({ wss: true });
        await f.approve();
        f.loseResponse(stage);
        expect(await f.client.pollOnce()).toBe(true);
        const state = await f.ledger.readOperation(f.scope, f.operationId);
        if (stage === 'start') {
          expect(state.status).toBe('unknown');
          await expect(
            readFile(join(f.workspaceRoot, 'result.txt')),
          ).rejects.toMatchObject({ code: 'ENOENT' });
        } else {
          expect(state.status).toBe('succeeded');
          expect(
            await readFile(join(f.workspaceRoot, 'result.txt'), 'utf8'),
          ).toBe('one exact approved write');
          expect(
            (await f.ledger.readEvents(f.scope, f.operationId)).filter(
              (e) => e.signal.type === 'operation.outcome',
            ),
          ).toHaveLength(1);
        }
        expect(await f.client.pollOnce()).toBe(false);
        expect(await f.journal.pending()).toEqual([]);
        const [connection] =
          await database`select epoch from allrice_bridge_connections where device_id=${f.ids.device}`;
        expect(Number(connection?.epoch)).toBeGreaterThan(0); // this really used WSS, not only HTTP
      },
    );

    it('P12 claim recovery cannot revive an expired or revoked dispatch or a legacy random lease', async () => {
      for (const mode of ['expired', 'revoked', 'legacy'] as const) {
        const f = await fixture();
        await f.approve();
        const response = await f.post(
          'next',
          mode === 'legacy' ? {} : { supportsClaimRecovery: true },
        );
        expect(response.ok).toBe(true);
        if (mode === 'expired')
          await database`update allrice_runtime_operations set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.operationId}`;
        if (mode === 'revoked')
          await database`update allrice_bridge_folder_grants set revoked_at=clock_timestamp() where id=${f.ids.grant}`;
        expect(
          await (await f.post('next', { supportsClaimRecovery: true })).json(),
        ).toEqual({ dispatch: null });
        await expect(
          readFile(join(f.workspaceRoot, 'result.txt')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });

    it('lost accepted result ACK survives reopening and does not repeat the write', async () => {
      const f = await fixture();
      await f.approve();
      f.loseResponse('receipts');
      await expect(f.client.pollOnce()).rejects.toThrow();
      expect(
        (await f.ledger.readOperation(f.scope, f.operationId)).status,
      ).toBe('succeeded');
      expect(await f.journal.pending()).toHaveLength(1);
      await f.journal.close();
      const reopened = await BridgeJournal.open(f.journalInput);
      cleanups.push(() => reopened.close());
      const client = new RuntimeBridgeOperationClient({
        config: f.config,
        token: f.token,
        journal: reopened,
      });
      expect(await client.pollOnce()).toBe(false);
      expect(await reopened.pending()).toEqual([]);
      expect(await readFile(join(f.workspaceRoot, 'result.txt'), 'utf8')).toBe(
        'one exact approved write',
      );
      expect(await f.ledger.readReceipts(f.scope, f.operationId)).toHaveLength(
        2,
      );
      expect(
        (await f.ledger.readEvents(f.scope, f.operationId)).filter(
          (event) => event.signal.type === 'operation.outcome',
        ),
      ).toHaveLength(1);
    });

    it('lost start ACK produces durable unknown without executing', async () => {
      const f = await fixture();
      await f.approve();
      f.loseResponse('start');
      await f.client.pollOnce();
      expect(
        (await f.ledger.readOperation(f.scope, f.operationId)).status,
      ).toBe('unknown');
      await expect(
        readFile(join(f.workspaceRoot, 'result.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await f.client.pollOnce()).toBe(false);
    });

    it('cancel between claim and start preserves cancellation intent and does not write', async () => {
      const f = await fixture();
      await f.approve();
      const cancelId = randomUUID();
      f.beforeAction(async (action) => {
        if (action === 'start')
          await f.ledger.cancelRoot(f.scope, f.ids.run, cancelId);
      });
      await f.client.pollOnce();
      expect(
        await f.ledger.readOperation(f.scope, f.operationId),
      ).toMatchObject({ status: 'unknown', cancelRequestId: cancelId });
      await expect(
        readFile(join(f.workspaceRoot, 'result.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('lease expiry before start is unknown, never a new executable attempt', async () => {
      const f = await fixture();
      await f.approve();
      const dispatch = await f.claim();
      await database`update allrice_runtime_operations set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.operationId}`;
      await f.ledger.expireLeases(f.scope, f.ids.run);
      await f.client.handle(dispatch);
      await f.client.flush();
      expect(
        (await f.ledger.readOperation(f.scope, f.operationId)).status,
      ).toBe('unknown');
      expect(await f.client.pollOnce()).toBe(false);
      await expect(
        readFile(join(f.workspaceRoot, 'result.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('revoked and reopened real grant generation cannot reuse the old exact approval', async () => {
      const f = await fixture();
      await f.approve();
      await database`update allrice_bridge_folder_grants set revoked_at=clock_timestamp() where id=${f.ids.grant}`;
      await database`update allrice_bridge_folder_grants set revoked_at=null where id=${f.ids.grant}`;
      const [grant] = await database<
        { runtime_generation: number }[]
      >`select runtime_generation from allrice_bridge_folder_grants where id=${f.ids.grant}`;
      expect(grant?.runtime_generation).toBeGreaterThan(1);
      await expect(
        f.ledger.dispatch({
          scope: f.scope,
          operationId: f.operationId,
          leaseOwner: f.ids.device,
          leaseMs: 60_000,
        }),
      ).rejects.toThrow();
      expect(
        (
          await getRuntimeActionApproval(
            f.context,
            f.approval.approvalId,
            database,
          )
        ).consumedAt,
      ).toBeNull();
      await expect(
        readFile(join(f.workspaceRoot, 'result.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('revoked device after a real write leaves its receipt locally for reconciliation', async () => {
      const f = await fixture();
      await f.approve();
      const dispatch = await f.claim();
      await f.client.handle(dispatch);
      await database`update allrice_bridge_devices set revoked_at=clock_timestamp() where id=${f.ids.device}`;
      await expect(f.client.flush()).rejects.toMatchObject({ status: 401 });
      expect(await f.journal.pending()).toHaveLength(1);
      expect(await readFile(join(f.workspaceRoot, 'result.txt'), 'utf8')).toBe(
        'one exact approved write',
      );
      // Revocation is not permission to upload using a revoked credential, nor
      // proof that an already completed file write was canceled.
      expect(
        (await f.ledger.readOperation(f.scope, f.operationId)).status,
      ).toBe('running');
    });

    it('a new tenant deny after dispatch prevents the already approved local effect', async () => {
      const f = await fixture();
      await f.approve();
      const dispatch = await f.claim();
      await setRuntimePolicyControls(
        f.context,
        {
          version: 2,
          enabled: true,
          mode: 'execute',
          rules: [{ action: 'local.fs.write', effect: 'deny' }],
        },
        1,
        database,
      );
      await f.client.handle(dispatch);
      await f.client.flush();
      expect(
        (await f.ledger.readOperation(f.scope, f.operationId)).status,
      ).toBe('unknown');
      await expect(
        readFile(join(f.workspaceRoot, 'result.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('tampered payload/evidence and stale attempt do not become current execution facts', async () => {
      const f = await fixture();
      await f.approve();
      const dispatch = await f.claim();
      const forged = structuredClone(dispatch);
      if (forged.payload.capability !== 'local.fs.write')
        throw new Error('fixture');
      forged.payload.arguments.content = 'not approved';
      await expect(f.client.handle(forged)).rejects.toThrow(
        'JOURNAL_PAYLOAD_MISMATCH',
      );
      await f.client.handle(dispatch);
      const [receipt] = await f.journal.pending();
      if (!receipt) throw new Error('missing durable receipt');
      const wrongEvidence = structuredClone(receipt);
      wrongEvidence.evidence!.summary = 'forged';
      expect(
        (await f.post(`${f.operationId}/receipts`, wrongEvidence)).status,
      ).toBe(409);
      const stale = structuredClone(receipt);
      stale.receiptId = randomUUID();
      stale.attempt.fence++;
      expect((await f.post(`${f.operationId}/receipts`, stale)).status).toBe(
        409,
      );
      expect((await f.post(`${f.operationId}/receipts`, stale)).status).toBe(
        409,
      );
      expect(
        (await f.ledger.readOperation(f.scope, f.operationId)).status,
      ).toBe('running');
      await f.client.flush();
      expect(
        (await f.ledger.readOperation(f.scope, f.operationId)).status,
      ).toBe('succeeded');
    });

    it('another tenant or another device cannot consume the operation lease', async () => {
      const f = await fixture();
      const other = await fixture();
      await f.approve();
      const dispatch = await f.claim();
      const start = {
        contractVersion: 1,
        receiptId: randomUUID(),
        leaseToken: dispatch.leaseToken,
        attempt: dispatch.snapshot.binding.attempt,
      };
      expect(
        (await f.post(`${f.operationId}/start`, start, other.token)).status,
      ).toBe(404);
      const id = randomUUID(),
        token = `other-device-${randomUUID()}`;
      // A workspace deliberately has only one active Bridge. A newly paired
      // replacement still cannot use the old device's operation/lease.
      await database`update allrice_bridge_devices set revoked_at=clock_timestamp() where id=${f.ids.device}`;
      await database`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at) values (${id},${f.ids.organization},${f.ids.workspace},${f.ids.user},'Different synthetic device','macos-x64',2,array['local.fs.write'],${createHash('sha256').update(token).digest('hex')},clock_timestamp())`;
      expect(
        (await f.post(`${f.operationId}/start`, start, token)).status,
      ).toBe(404);
      expect(
        (await f.ledger.readOperation(f.scope, f.operationId)).status,
      ).toBe('dispatched');
    });

    it('real process death after actual effect becomes unknown across PG, HTTP and SQLite', async () => {
      const f = await fixture();
      await f.approve();
      const dispatch = await f.claim();
      await f.journal.close();
      const sourceRoot = new URL('../../../../', import.meta.url);
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `
      const { BridgeJournal } = await import(${JSON.stringify(new URL('apps/rice-bridge/src/journal.ts', sourceRoot).href)});
      const { RuntimeBridgeOperationClient } = await import(${JSON.stringify(new URL('apps/rice-bridge/src/operation-client.ts', sourceRoot).href)});
      const { executeLocalCommand } = await import(${JSON.stringify(new URL('apps/rice-bridge/src/executor.ts', sourceRoot).href)});
      const journal = await BridgeJournal.open(${JSON.stringify(f.journalInput)});
      const client = new RuntimeBridgeOperationClient({ config: ${JSON.stringify(f.config)}, token: ${JSON.stringify(f.token)}, journal,
        execute: async (...args) => { await executeLocalCommand(...args); process.stdout.write('real-effect-done\\n'); await new Promise(() => { setInterval(() => {}, 1000); }); }
      });
      await client.handle(${JSON.stringify(dispatch)});
    `,
        ],
        {
          cwd: fileURLToPath(sourceRoot),
          env: {
            ...process.env,
            TSX_TSCONFIG_PATH: fileURLToPath(
              new URL('tsconfig.base.json', sourceRoot),
            ),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      cleanups.push(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
      });
      let stderr = '';
      child.stderr.on('data', (bytes: Buffer) => {
        stderr += bytes.toString();
      });
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve());
        child.once('exit', (code) =>
          reject(new Error(`child ${code}: ${stderr}`)),
        );
      });
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const recovered = await BridgeJournal.open(f.journalInput);
      cleanups.push(() => recovered.close());
      const client = new RuntimeBridgeOperationClient({
        config: f.config,
        token: f.token,
        journal: recovered,
      });
      await client.flush();
      expect(
        (await f.ledger.readOperation(f.scope, f.operationId)).status,
      ).toBe('unknown');
      expect(await readFile(join(f.workspaceRoot, 'result.txt'), 'utf8')).toBe(
        'one exact approved write',
      );
      await client.handle(dispatch);
      expect(await client.pollOnce()).toBe(false);
      expect(
        (await f.ledger.readEvents(f.scope, f.operationId)).filter(
          (event) => event.signal.type === 'operation.started',
        ),
      ).toHaveLength(1);
    }, 30_000);

    it('device, policy and ledger canonical digests agree, including numeric keys', () => {
      const value = {
        '2': 'b',
        中: 4,
        '10': 'a',
        é: 3,
        nested: [{ b: 2, a: 1 }],
      };
      const device = `sha256:${createHash('sha256').update(canonicalRuntimeBridgeJson(value)).digest('hex')}`;
      expect(runtimePolicyDigest(value)).toBe(device);
      expect(runtimeLedgerInputDigest(value)).toBe(device);
    });
  },
);
