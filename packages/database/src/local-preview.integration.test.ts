import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BrowserObservationSchema,
  LocalBrowserHttpRequestSchema,
  localPreviewOrigin,
} from '@allrice/contracts';
import { createLocalPreviewFixture } from './local-preview.fixture.ts';
import { assertRuntimeFixtureDatabase } from './runtime-fixture-database.ts';
import {
  requestLocalPreviewFromUser,
  requestLocalPreviewNavigation,
} from './local-preview.ts';
import {
  claimLocalBrowserWorkspace,
  heartbeatLocalBrowserWorkspace,
  recordLocalBrowserStopped,
} from './local-browser-workspaces.ts';
import {
  publishLocalBrowserObservation,
  acknowledgeLocalBrowserControl,
  startLocalBrowserOperation,
} from './local-browser-operations.ts';
import {
  listLocalBrowserGrants,
  installLocalBrowserGrant,
} from './local-browser-grants.ts';
import {
  readCurrentBrowserWorkspace,
  listBrowserWorkspaces,
  requestBrowserControl,
} from './browser-control.ts';
import { readLocalService } from './local-service-runtime.ts';
import { captureLocalBrowserFile } from './local-browser-files.ts';
import {
  runtimePolicyDigest,
  setRuntimePolicyControls,
} from './runtime-policy.ts';
import type * as Client from './core/client.ts';
let db: ReturnType<typeof postgres>,
  admin: ReturnType<typeof postgres>,
  storageRoot: string;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
const schema = `p23_preview_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const fixture = () => createLocalPreviewFixture(db, storageRoot);
async function claimed(f: Awaited<ReturnType<typeof fixture>>) {
  const w = await f.open(),
    controllerId = randomUUID();
  const claim = await claimLocalBrowserWorkspace(
    f.device,
    controllerId,
    true,
    db,
    true,
  );
  if (!claim.lease || !claim.workspace) throw Error('preview claim required');
  const identity = {
    workspaceId: w.id,
    controllerLeaseToken: claim.lease.token,
  };
  const observationId = randomUUID();
  const capture = await captureLocalBrowserFile(
    f.device,
    { ...identity, kind: 'screenshot', fence: 1, observationId },
    Buffer.from('89504e470d0a1a0a70726576696577', 'hex'),
    f.storage,
    db,
  );
  const capturedAt = Date.now();
  const obs = BrowserObservationSchema.parse({
    version: 1,
    id: observationId,
    profileId: w.profile_id,
    fence: 1,
    revision: 1,
    capturedAt: new Date(capturedAt).toISOString(),
    expiresAt: new Date(capturedAt + 60000).toISOString(),
    url: 'about:blank',
    title: '',
    text: '',
    pageDigest: runtimePolicyDigest('blank'),
    elements: [],
    screenshotObjectId: capture.objectId,
  });
  await publishLocalBrowserObservation(
    f.device,
    { ...identity, observation: obs },
    db,
  );
  await acknowledgeLocalBrowserControl(
    f.device,
    { ...identity, fence: 1, state: 'agent', observationId: obs.id },
    db,
  );
  return { w, claim, identity };
}
suite('P23 real PostgreSQL service-derived preview authority', () => {
  beforeAll(async () => {
    const source = process.env.ALLRICE_TEST_DATABASE_URL;
    if (!source) throw Error('dedicated database required');
    const url = new URL(source);
    assertRuntimeFixtureDatabase(url);
    for (const flag of [
      'ALLRICE_LOCAL_PREVIEW_ENABLED',
      'ALLRICE_LOCAL_BROWSER_ENABLED',
      'ALLRICE_BROWSER_CONTROL_ENABLED',
      'ALLRICE_LOCAL_COMMAND_ENABLED',
      'ALLRICE_LOCAL_SERVICE_ENABLED',
      'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
      'ALLRICE_RUNTIME_POLICY_ENABLED',
      'ALLRICE_CLOUD_RUNNER_ENABLED',
      'ALLRICE_WORKBENCH_ENABLED',
    ])
      vi.stubEnv(flag, '1');
    admin = postgres(source, { max: 2, onnotice: () => {} });
    await admin.unsafe(`create schema ${schema}`);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    db = postgres(url.toString(), { max: 8, onnotice: () => {} });
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory))
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await db.unsafe(await readFile(new URL(file, directory), 'utf8'));
    storageRoot = await mkdtemp(join(tmpdir(), 'allrice-p23-test-'));
  }, 60000);
  afterAll(async () => {
    await db?.end();
    if (admin) {
      if (!/^p23_preview_[a-f0-9]{32}$/.test(schema))
        throw Error('unsafe schema');
      await admin.unsafe(`drop schema ${schema} cascade`);
      await admin.end();
    }
    if (storageRoot?.includes('/allrice-p23-test-'))
      await rm(storageRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  it('derives one private endpoint from a real approved/STARTed HTTP service; old clients cannot claim it', async () => {
    const f = await fixture();
    const w = await f.open(),
      again = await f.open();
    expect(again.id).toBe(w.id);
    expect(w.preview?.target).toMatchObject({
      processId: f.processId,
      deviceId: f.device.id,
      runId: f.run,
      folderGrantId: f.folderId,
      port: 3100,
      containerId: 'c'.repeat(64),
    });
    expect(w.profile.origins).toEqual([
      localPreviewOrigin(w.preview!.target.endpointId),
    ]);
    expect(w.expires_at.getTime()).toBeLessThanOrEqual(
      Date.now() + w.profile.lifetimeMs,
    );
    expect(await listLocalBrowserGrants(f.context, db)).toEqual([]);
    const parsed = LocalBrowserHttpRequestSchema.parse({
      kind: 'claim',
      controllerId: randomUUID(),
      acceptWork: true,
    });
    expect(parsed).toMatchObject({ acceptPreview: false });
    expect(
      (await claimLocalBrowserWorkspace(f.device, randomUUID(), true, db))
        .workspace,
    ).toBeNull();
    const claim = await claimLocalBrowserWorkspace(
      f.device,
      randomUUID(),
      true,
      db,
      true,
    );
    expect(claim.workspace?.persistLogin).toBe(false);
    expect(claim.workspace?.preview?.target).toEqual(w.preview!.target);
    expect(Date.parse(claim.workspace!.preview!.expiresAt)).toBeLessThanOrEqual(
      Date.now() + 5000,
    );
    expect((await readLocalService(f.processId, db))!.preview).toMatchObject({
      workspaceId: w.id,
      pending: true,
    });
    expect(
      (await listBrowserWorkspaces(f.context, f.run, db))[0]!.preview,
    ).toMatchObject({ processId: f.processId, port: 3100 });
  });
  it('UI owner entry uses frozen DB context; ACK yields one exact navigation approval and one START', async () => {
    const f = await fixture(),
      first = await requestLocalPreviewFromUser(f.context, f.processId, db);
    expect(first.pending).toBe(true);
    const b = await claimed(f);
    const next = await requestLocalPreviewFromUser(f.context, f.processId, db),
      retry = await requestLocalPreviewNavigation(f.context, b.w.id, db);
    expect(next).toEqual(retry);
    expect(next.pending).toBe(false);
    expect(next.operationId).toBeTruthy();
    expect(
      (
        await startLocalBrowserOperation(
          f.device,
          { ...b.identity, operationId: next.operationId! },
          db,
        )
      ).mayExecute,
    ).toBe(false);
    const [op] = await db<
      { snapshot: Parameters<typeof f.approve>[0]['snapshot'] }[]
    >`select snapshot from allrice_runtime_operations where id=${next.operationId!}`;
    await f.approve(op!);
    expect(
      (
        await startLocalBrowserOperation(
          f.device,
          { ...b.identity, operationId: next.operationId! },
          db,
        )
      ).mayExecute,
    ).toBe(true);
    expect(
      (
        await startLocalBrowserOperation(
          f.device,
          { ...b.identity, operationId: next.operationId! },
          db,
        )
      ).mayExecute,
    ).toBe(false);
    expect(
      await db`select id from allrice_local_preview_endpoints where process_id=${f.processId}`,
    ).toHaveLength(1);
  });
  it('missing frozen preview, TCP-only, not-ready and wrong owner cannot create an endpoint', async () => {
    for (const options of [
      { frozen: false },
      { kind: 'tcp' as const },
      { ready: false },
    ]) {
      const f = await createLocalPreviewFixture(db, storageRoot, options);
      await expect(f.open()).rejects.toThrow(
        'local_preview_service_unavailable',
      );
      expect(
        await db`select id from allrice_local_preview_endpoints where process_id=${f.processId}`,
      ).toHaveLength(0);
    }
    const f = await fixture(),
      other = await fixture();
    await expect(
      requestLocalPreviewFromUser(other.context, f.processId, db),
    ).rejects.toThrow();
    await expect(
      installLocalBrowserGrant(
        f.context,
        {
          deviceId: f.device.id,
          profile: { version: 1, origins: [localPreviewOrigin(randomUUID())] },
        },
        db,
      ),
    ).rejects.toThrow('browser_reserved_origin_denied');
  });
  it('a failed ledger insert resumes the original navigation input instead of reporting a nonexistent approval', async () => {
    const f = await fixture(),
      b = await claimed(f);
    await db.unsafe(`create function p23_fail_browser_insert() returns trigger language plpgsql as $$ begin
      if new.snapshot->'binding'->>'action'='local.browser.act' then raise exception 'synthetic preview insert failure'; end if; return new; end; $$`);
    await db.unsafe(
      'create trigger p23_fail_browser_insert before insert on allrice_runtime_operations for each row execute function p23_fail_browser_insert()',
    );
    try {
      await expect(
        requestLocalPreviewNavigation(f.context, b.w.id, db),
      ).rejects.toThrow('synthetic preview insert failure');
    } finally {
      await db.unsafe(
        'drop trigger p23_fail_browser_insert on allrice_runtime_operations',
      );
      await db.unsafe('drop function p23_fail_browser_insert()');
    }
    const result = await requestLocalPreviewNavigation(f.context, b.w.id, db);
    expect(result.operationId).toBeTruthy();
    expect(
      await db`select id from allrice_runtime_operations where id=${result.operationId!}`,
    ).toHaveLength(1);
    expect(
      await db`select operation_id from allrice_browser_operation_inputs where browser_workspace_id=${b.w.id}`,
    ).toHaveLength(1);
  });
  it('a persisted waiting operation with a failed approval insert repairs its same approval intent', async () => {
    const f = await fixture(),
      b = await claimed(f);
    await db.unsafe(`create function p23_fail_approval_insert() returns trigger language plpgsql as $$ begin
      if new.runtime_request->'binding'->>'action'='local.browser.act' then raise exception 'synthetic preview approval failure'; end if; return new; end; $$`);
    await db.unsafe(
      'create trigger p23_fail_approval_insert before insert on allrice_approval_requests for each row execute function p23_fail_approval_insert()',
    );
    try {
      await expect(
        requestLocalPreviewNavigation(f.context, b.w.id, db),
      ).rejects.toThrow('synthetic preview approval failure');
      expect((await readLocalService(f.processId, db))?.preview).toMatchObject({
        workspaceId: b.w.id,
        pending: true,
      });
    } finally {
      await db.unsafe(
        'drop trigger p23_fail_approval_insert on allrice_approval_requests',
      );
      await db.unsafe('drop function p23_fail_approval_insert()');
    }
    const result = await requestLocalPreviewNavigation(f.context, b.w.id, db);
    expect(
      await db`select id from allrice_approval_requests where resource_id=${result.operationId!} and resource_type='runtime_operation'`,
    ).toHaveLength(1);
    expect(
      (await requestLocalPreviewNavigation(f.context, b.w.id, db)).operationId,
    ).toBe(result.operationId);
  });
  it('service stop/deadline/lease loss/folder change and container mismatch revoke existing preview admission', async () => {
    const mutations = [
      async (f: Awaited<ReturnType<typeof fixture>>) => {
        await db`update allrice_local_services set stop_requested=true where operation_id=${f.processId}`;
      },
      async (f: Awaited<ReturnType<typeof fixture>>) => {
        await db`update allrice_local_services set preview_heartbeat_at=clock_timestamp()-interval '6 seconds' where operation_id=${f.processId}`;
      },
      async (f: Awaited<ReturnType<typeof fixture>>) => {
        await db`update allrice_local_services set hard_deadline_at=clock_timestamp()-interval '1 second' where operation_id=${f.processId}`;
      },
      async (f: Awaited<ReturnType<typeof fixture>>) => {
        await db`update allrice_runtime_operations set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.processId}`;
      },
      async (f: Awaited<ReturnType<typeof fixture>>) => {
        await db`update allrice_bridge_folder_grants set revoked_at=clock_timestamp() where id=${f.folderId}`;
      },
      async (f: Awaited<ReturnType<typeof fixture>>) => {
        await db`update allrice_local_services set container_id=${'d'.repeat(64)} where operation_id=${f.processId}`;
      },
    ];
    for (const mutate of mutations) {
      const f = await fixture(),
        b = await claimed(f);
      await mutate(f);
      await expect(
        readCurrentBrowserWorkspace(f.context, b.w.id, db),
      ).rejects.toThrow();
      expect(
        (await heartbeatLocalBrowserWorkspace(f.device, b.identity, db))
          .workspace.revoked,
      ).toBe(true);
      await recordLocalBrowserStopped(
        f.device,
        { ...b.identity, confirmed: true },
        db,
      );
    }
  });
  it('current policy withdrawal denies preview even while old service lease is still live', async () => {
    const f = await fixture(),
      b = await claimed(f);
    await setRuntimePolicyControls(
      f.context,
      { version: 2, enabled: true, mode: 'execute', rules: [] },
      1,
      db,
    );
    await expect(
      readCurrentBrowserWorkspace(f.context, b.w.id, db),
    ).rejects.toThrow();
  });
  it('feature off denies execution but old device can confirm cleanup; closed intent never silently reopens', async () => {
    const f = await fixture(),
      b = await claimed(f);
    vi.stubEnv('ALLRICE_LOCAL_PREVIEW_ENABLED', '0');
    try {
      expect(
        (await heartbeatLocalBrowserWorkspace(f.device, b.identity, db))
          .workspace.revoked,
      ).toBe(true);
      await recordLocalBrowserStopped(
        f.device,
        { ...b.identity, confirmed: true },
        db,
      );
    } finally {
      vi.stubEnv('ALLRICE_LOCAL_PREVIEW_ENABLED', '1');
    }
    await expect(f.open()).rejects.toThrow();
    expect(
      await db`select id from allrice_local_preview_endpoints where process_id=${f.processId}`,
    ).toHaveLength(1);
  });
  it('immutable endpoint target and concurrent service/browser heartbeats preserve one current binding', async () => {
    const f = await fixture(),
      b = await claimed(f);
    await expect(
      db`update allrice_local_preview_endpoints set target=jsonb_set(target,'{port}','3101') where process_id=${f.processId}`,
    ).rejects.toThrow('immutable');
    for (let n = 0; n < 3; n++)
      await Promise.all([
        f.exchange(),
        heartbeatLocalBrowserWorkspace(f.device, b.identity, db),
      ]);
    await requestBrowserControl(
      f.context,
      b.w.id,
      {
        requestId: randomUUID(),
        expectedFence: 1,
        control: 'closed',
        observationId: null,
      },
      db,
    );
    await recordLocalBrowserStopped(
      f.device,
      { ...b.identity, confirmed: true },
      db,
    );
  });
});
