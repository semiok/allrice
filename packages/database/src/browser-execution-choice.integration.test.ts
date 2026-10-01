import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createLocalBrowserFixture } from './local-browser.fixture.ts';
import {
  selectBrowserExecution,
  executionRequestConstraints,
} from './browser-execution-choice.ts';
import { installBrowserControlGrant } from './browser-control.ts';
import {
  createLocalBrowserWorkspace,
  recordLocalBrowserStopped,
} from './local-browser-workspaces.ts';
import { executionResourceObserver } from './execution-diagnostics.ts';
import {
  heartbeatBridgeDevice,
  listBridgeDevices,
  dispatchBridgeCommand,
} from './bridge.ts';
import { waitForLocalAdmission } from '../../../apps/worker/src/tool-broker/handlers/local-admission.ts';
import type { RiceToolExecutionInput } from '../../../apps/worker/src/tool-broker/types.ts';
import * as client from './core/client.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET164 real local choice and existing durable admission', () => {
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  let storage: string;
  beforeAll(async () => {
    for (const flag of [
      'ALLRICE_RUNTIME_POLICY_ENABLED',
      'ALLRICE_BROWSER_CONTROL_ENABLED',
      'ALLRICE_LOCAL_BROWSER_ENABLED',
      'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
      'ALLRICE_WORKBENCH_ENABLED',
      'ALLRICE_CLOUD_RUNNER_ENABLED',
    ])
      vi.stubEnv(flag, '1');
    database = await createAssistantFixtureDatabase();
    storage = await mkdtemp(join(tmpdir(), 'allrice-met164-'));
    vi.spyOn(client, 'getDatabase').mockReturnValue(database.db);
  }, 60000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await database?.close();
    if (storage) await rm(storage, { recursive: true, force: true });
  });
  const fixture = (open = false) =>
    createLocalBrowserFixture(database.db, storage, { open });
  const admission = async (
    f: Awaited<ReturnType<typeof fixture>>,
    callId = randomUUID(),
  ) => {
    const [j] = await database.db<
      { attempt: number; lease_token: string }[]
    >`select attempt,lease_token from allrice_jobs where id=${f.execution.jobId}`;
    return {
      context: f.execution,
      callId,
      url: 'https://example.com/',
      jobAttempt: j!.attempt,
      jobLeaseToken: j!.lease_token,
    };
  };
  const cloud = (f: Awaited<ReturnType<typeof fixture>>) =>
    installBrowserControlGrant(
      f.context,
      {
        targetId: f.target,
        ownerId: f.user,
        profile: f.profile,
        enabled: true,
      },
      database.db,
    );
  const environment = async (
    f: Awaited<ReturnType<typeof fixture>>,
    browser: 'ready' | 'busy' | 'preparing' | 'paused' | 'unavailable',
  ) => {
    await database.db`update allrice_execution_targets set metadata=jsonb_set(metadata,'{environment}',${database.db.json(
      {
        version: 1,
        clientVersion: 'synthetic-readiness',
        browser: browser === 'busy' ? 'ready' : browser,
        sandbox: 'unavailable',
        preview: 'unavailable',
        paused: false,
        readiness: [
          {
            capability: 'local.browser',
            state: browser === 'unavailable' ? 'unsupported' : browser,
            reason:
              browser === 'ready'
                ? 'ready'
                : browser === 'busy'
                  ? 'local_busy'
                  : `browser_${browser}`,
            missing: [],
            versions: {
              bridge: 'synthetic-readiness',
              chromium: 'synthetic-test',
            },
            observedAt: new Date().toISOString(),
          },
        ],
      },
    )}) where target_key=${`bridge.${f.device.id}`} and organization_id=${f.org} and workspace_id=${f.workspace}`;
  };
  const toolInput = (
    f: Awaited<ReturnType<typeof fixture>>,
    a: Awaited<ReturnType<typeof admission>>,
    signal?: AbortSignal,
  ): RiceToolExecutionInput => ({
    context: f.execution,
    capabilities: [],
    storageRoot: storage,
    call: { id: a.callId, name: 'local.browser.workspace', arguments: {} },
    managedBrowserJobAttempt: a.jobAttempt,
    managedBrowserJobLeaseToken: a.jobLeaseToken,
    signal,
  });
  const waitRow = async (callId: string) => {
    for (let n = 0; n < 40; n++) {
      const [row] = await database.db<
        { state: string; reason: string }[]
      >`select state,reason from allrice_task_resource_waits where call_id=${callId}`;
      if (row?.state === 'waiting') return row;
      await delay(25);
    }
    throw Error('durable local wait missing');
  };

  it('uses an existing legacy v2 browser grant, binds once, and honors explicit cloud/local', async () => {
    const f = await fixture();
    await cloud(f);
    const a = await admission(f);
    const local = await selectBrowserExecution(a, database.db);
    expect(local).toMatchObject({
      choice: { location: 'local', status: 'execute', reason: 'local_ready' },
      deviceId: f.device.id,
      grantId: f.localGrant.grantId,
    });
    await environment(f, 'paused');
    expect(await selectBrowserExecution(a, database.db)).toMatchObject({
      choice: { location: 'local', status: 'unavailable' },
    });
    expect(
      await selectBrowserExecution(
        { ...(await admission(f)), location: 'cloud' },
        database.db,
      ),
    ).toMatchObject({
      choice: { location: 'cloud', reason: 'explicit_cloud' },
    });
    expect(
      await selectBrowserExecution(
        { ...(await admission(f)), location: 'local' },
        database.db,
      ),
    ).toMatchObject({ choice: { location: 'local', status: 'unavailable' } });
    await expect(
      selectBrowserExecution(
        { ...a, url: 'https://example.com/changed' },
        database.db,
      ),
    ).rejects.toThrow('idempotency_conflict');
    expect(
      await database.db`select id from allrice_managed_browser_tasks where run_id=${f.run}`,
    ).toHaveLength(0);
  });
  it('adopts the same live local workspace without waiting on itself, while another call stays queued', async () => {
    const f = await fixture();
    await cloud(f);
    await environment(f, 'ready');
    const a = await admission(f);
    const first = await selectBrowserExecution(a, database.db);
    const w = await createLocalBrowserWorkspace(
      { ...a, grantId: first.grantId!, commonIntent: true },
      database.db,
    );
    expect(await selectBrowserExecution(a, database.db)).toMatchObject({
      choice: {
        location: 'local',
        status: 'execute',
        reason: 'bound_execution',
      },
      workspaceId: w.id,
      deviceId: f.device.id,
      grantId: f.localGrant.grantId,
    });
    await environment(f, 'busy');
    expect(await selectBrowserExecution(a, database.db)).toMatchObject({
      choice: {
        location: 'local',
        status: 'execute',
        reason: 'bound_execution',
      },
      workspaceId: w.id,
    });
    expect(
      await createLocalBrowserWorkspace(
        { ...a, grantId: f.localGrant.grantId, commonIntent: true },
        database.db,
      ),
    ).toMatchObject({ id: w.id });
    expect(
      await selectBrowserExecution(await admission(f), database.db),
    ).toMatchObject({
      choice: { location: 'local', status: 'wait', reason: 'local_busy' },
    });
    expect(
      await database.db`select id from allrice_browser_workspaces where run_id=${f.run}`,
    ).toHaveLength(1);
    expect(
      await database.db`select id from allrice_managed_browser_tasks where run_id=${f.run}`,
    ).toHaveLength(0);
  });
  it.each(['closed', 'close_pending', 'expired'])(
    'keeps a %s same-call workspace bound and unavailable rather than re-admitting it',
    async (state) => {
      const f = await fixture();
      await cloud(f);
      const a = await admission(f);
      await selectBrowserExecution(a, database.db);
      const w = await createLocalBrowserWorkspace(
        { ...a, grantId: f.localGrant.grantId, commonIntent: true },
        database.db,
      );
      if (state === 'expired')
        await database.db`update allrice_browser_workspaces set expires_at=clock_timestamp()-interval '1 second' where id=${w.id}`;
      else
        await database.db`update allrice_browser_workspaces set state=${state},desired_control='closed' where id=${w.id}`;
      expect(await selectBrowserExecution(a, database.db)).toMatchObject({
        choice: {
          location: 'local',
          status: 'unavailable',
          reason: 'bound_execution',
        },
        workspaceId: w.id,
        deviceId: f.device.id,
      });
      expect(
        await database.db`select id from allrice_browser_workspaces where run_id=${f.run}`,
      ).toHaveLength(1);
      expect(
        await database.db`select id from allrice_managed_browser_tasks where run_id=${f.run}`,
      ).toHaveLength(0);
    },
  );
  it('falls back only for missing capability/offline, and refuses local inputs even when flags are omitted', async () => {
    const f = await fixture();
    await cloud(f);
    await environment(f, 'unavailable');
    expect(
      await selectBrowserExecution(await admission(f), database.db),
    ).toMatchObject({
      choice: { location: 'cloud', reason: 'local_unsupported' },
    });
    await database.db`update allrice_bridge_devices set last_seen_at=clock_timestamp()-interval '91 seconds' where id=${f.device.id}`;
    expect(
      await selectBrowserExecution(await admission(f), database.db),
    ).toMatchObject({ choice: { location: 'cloud', reason: 'local_offline' } });
    const folder = randomUUID();
    await database.db`insert into allrice_bridge_folder_grants(id,organization_id,workspace_id,owner_id,device_id,label,root_fingerprint)
      values(${folder},${f.org},${f.workspace},${f.user},${f.device.id},'Synthetic local input',${'a'.repeat(64)})`;
    await database.db`insert into allrice_bridge_commands(organization_id,workspace_id,owner_id,device_id,folder_grant_id,capability,arguments,idempotency_key,timeout_at)
      values(${f.org},${f.workspace},${f.user},${f.device.id},${folder},'local.fs.read','{"path":"local.txt"}',${`tool:${f.run}:${randomUUID()}`},clock_timestamp()+interval '1 minute')`;
    expect(
      await selectBrowserExecution(await admission(f), database.db),
    ).toMatchObject({
      choice: {
        location: 'local',
        status: 'unavailable',
        reason: 'local_inputs_required',
      },
    });
  });
  it('enforces the stored user message over a contrary model location', async () => {
    const f = await fixture();
    await cloud(f);
    await database.db`update allrice_messages set content=jsonb_set(content,'{text}','"只在本地执行，不要上传资料"'::jsonb)
      where id=(select user_message_id from allrice_employee_runs where run_id=${f.run})`;
    expect(
      await selectBrowserExecution(
        { ...(await admission(f)), location: 'cloud' },
        database.db,
      ),
    ).toMatchObject({ choice: { location: 'local', status: 'execute' } });
    await environment(f, 'unavailable');
    expect(
      await selectBrowserExecution(await admission(f), database.db),
    ).toMatchObject({ choice: { location: 'local', status: 'unavailable' } });
    await database.db`update allrice_messages set content=jsonb_set(content,'{text}','"用我电脑上已登录的浏览器核查账单"'::jsonb)
      where id=(select user_message_id from allrice_employee_runs where run_id=${f.run})`;
    await database.db`update allrice_bridge_devices set last_seen_at=clock_timestamp()-interval '91 seconds' where id=${f.device.id}`;
    expect(
      await selectBrowserExecution(await admission(f), database.db),
    ).toMatchObject({
      choice: {
        location: 'local',
        status: 'unavailable',
        reason: 'local_inputs_required',
      },
    });
  });
  it('waits through real local preparation in the existing resource table, then admits one local workspace', async () => {
    const f = await fixture();
    await cloud(f);
    await environment(f, 'preparing');
    const a = await admission(f);
    expect(await selectBrowserExecution(a, database.db)).toMatchObject({
      choice: { location: 'local', status: 'wait', reason: 'local_preparing' },
    });
    const waiting = waitForLocalAdmission(toolInput(f, a), () =>
      createLocalBrowserWorkspace(
        { ...a, grantId: f.localGrant.grantId, commonIntent: true },
        database.db,
      ),
    );
    expect(await waitRow(a.callId)).toMatchObject({
      reason: 'local_preparing',
    });
    expect(
      await database.db`select id from allrice_managed_browser_tasks where run_id=${f.run}`,
    ).toHaveLength(0);
    await environment(f, 'ready');
    const w = await waiting;
    expect(w.transport).toBe('local');
    expect(
      await database.db`select id from allrice_browser_workspaces where id=${w.id}`,
    ).toHaveLength(1);
    expect(
      await database.db`select state from allrice_task_resource_waits where call_id=${a.callId}`,
    ).toEqual([{ state: 'completed' }]);
    expect(
      await createLocalBrowserWorkspace(
        { ...a, grantId: f.localGrant.grantId, commonIntent: true },
        database.db,
      ),
    ).toMatchObject({ id: w.id });
  });
  it('waits for real occupied profile, excludes that wait from cloud fairness, and cancels without replay', async () => {
    const f = await fixture(true);
    await cloud(f);
    const a = await admission(f);
    const controller = new AbortController();
    const waiting = waitForLocalAdmission(
      toolInput(f, a, controller.signal),
      () =>
        createLocalBrowserWorkspace(
          { ...a, grantId: f.localGrant.grantId },
          database.db,
        ),
    );
    const caught = waiting.catch((error: unknown) => error);
    expect(await waitRow(a.callId)).toMatchObject({ reason: 'local_busy' });
    const cloudObserver = executionResourceObserver(
      {
        context: f.execution,
        leaseToken: a.jobLeaseToken,
        attemptId: randomUUID(),
        callId: randomUUID(),
      },
      database.db,
    );
    await cloudObserver.observe({
      stage: 'queued',
      reason: 'sandbox_capacity',
    });
    expect(await cloudObserver.isTurn()).toBe(true);
    controller.abort();
    expect(await caught).toBeInstanceOf(Error);
    expect(
      await database.db`select state from allrice_task_resource_waits where call_id=${a.callId}`,
    ).toEqual([{ state: 'canceled' }]);
    expect(
      await database.db`select id from allrice_browser_workspaces where run_id=${f.run}`,
    ).toHaveLength(1);
    await cloudObserver.observe({ stage: 'canceled' });
    const retry = await admission(f);
    const resumed = waitForLocalAdmission(toolInput(f, retry), () =>
      createLocalBrowserWorkspace(
        { ...retry, grantId: f.localGrant.grantId },
        database.db,
      ),
    );
    await waitRow(retry.callId);
    await recordLocalBrowserStopped(
      f.device,
      { ...f.browser!.identity!, confirmed: true },
      database.db,
    );
    expect((await resumed).transport).toBe('local');
    expect(
      await database.db`select id from allrice_managed_browser_tasks where run_id=${f.run}`,
    ).toHaveLength(0);
  });
  it('reconciles an unknown bound browser instead of switching to cloud', async () => {
    const f = await fixture();
    await cloud(f);
    const a = await admission(f);
    await selectBrowserExecution(a, database.db);
    const w = await createLocalBrowserWorkspace(
      { ...a, grantId: f.localGrant.grantId, commonIntent: true },
      database.db,
    );
    await database.db`update allrice_browser_workspaces set state='unknown' where id=${w.id}`;
    expect(await selectBrowserExecution(a, database.db)).toMatchObject({
      choice: {
        location: 'local',
        status: 'reconcile',
        reason: 'outcome_unknown',
      },
    });
    expect(
      await database.db`select id from allrice_browser_workspaces where run_id=${f.run}`,
    ).toHaveLength(1);
  });
  it('returns an existing read receipt after disconnect and rejects changed inputs without another execution', async () => {
    const f = await fixture(),
      folder = randomUUID(),
      key = `tool:${f.run}:${randomUUID()}`;
    await database.db`insert into allrice_bridge_folder_grants(id,organization_id,workspace_id,owner_id,device_id,label,root_fingerprint)
      values(${folder},${f.org},${f.workspace},${f.user},${f.device.id},'Original folder',${'b'.repeat(64)})`;
    await database.db`insert into allrice_bridge_commands(organization_id,workspace_id,owner_id,device_id,folder_grant_id,capability,arguments,idempotency_key,timeout_at,status,result,summary)
      values(${f.org},${f.workspace},${f.user},${f.device.id},${folder},'local.fs.read','{"path":"local.txt","maxBytes":200000}',${key},clock_timestamp()+interval '1 minute','succeeded','{"content":"original receipt"}','Original local read')`;
    await database.db`update allrice_bridge_devices set last_seen_at=clock_timestamp()-interval '91 seconds' where id=${f.device.id}`;
    const input = {
      context: f.execution,
      payload: {
        capability: 'local.fs.read' as const,
        arguments: { path: 'local.txt', maxBytes: 200000 },
      },
      idempotencyKey: key,
    };
    expect(await dispatchBridgeCommand(input)).toMatchObject({
      output: { content: 'original receipt' },
      workspaceLabel: 'Original folder',
    });
    await expect(
      dispatchBridgeCommand({
        ...input,
        payload: {
          ...input.payload,
          arguments: { path: 'changed.txt', maxBytes: 200000 },
        },
      }),
    ).rejects.toThrow('idempotency_conflict');
    expect(
      await database.db`select id from allrice_bridge_commands where organization_id=${f.org} and idempotency_key=${key}`,
    ).toHaveLength(1);
  });
  it.each([1, 2])(
    'accepts a legacy v%s heartbeat without fabricated Office readiness',
    async (protocolVersion) => {
      const f = await fixture();
      expect(
        await heartbeatBridgeDevice(f.token, {
          protocolVersion,
          capabilities: ['local.fs.list'],
        }),
      ).toMatchObject({ protocolVersion, status: 'online' });
      expect(
        (await listBridgeDevices(f.context, f.workspace))[0]?.readiness.find(
          (r) => r.capability === 'local.office',
        ),
      ).toMatchObject({
        state: 'unsupported',
        reason: 'readiness_not_reported',
      });
    },
  );
});

it('reads only explicit location and upload restrictions from request text', () => {
  expect(executionRequestConstraints('请使用已授权的云端浏览器核查')).toEqual({
    location: 'cloud',
    localOnly: false,
  });
  expect(
    executionRequestConstraints('Use the cloud browser to check public data'),
  ).toEqual({
    location: 'cloud',
    localOnly: false,
  });
  expect(executionRequestConstraints('请在云端处理这份报告')).toEqual({
    location: 'cloud',
    localOnly: false,
  });
  expect(executionRequestConstraints('不要上传资料，检查网站')).toEqual({
    location: 'auto',
    localOnly: true,
  });
  expect(executionRequestConstraints('介绍本地文件与云端文件的差异')).toEqual({
    location: 'auto',
    localOnly: false,
  });
  expect(
    executionRequestConstraints('用我电脑上已登录的浏览器查询付款记录'),
  ).toEqual({ location: 'local', localOnly: true });
  expect(executionRequestConstraints('使用本地浏览器核查')).toEqual({
    location: 'local',
    localOnly: true,
  });
  expect(
    executionRequestConstraints('Use my logged-in browser to check expenses'),
  ).toEqual({ location: 'local', localOnly: true });
  expect(executionRequestConstraints('不要使用本地浏览器，在云端执行')).toEqual(
    { location: 'cloud', localOnly: false },
  );
});
