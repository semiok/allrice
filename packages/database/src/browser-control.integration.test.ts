import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BrowserObservationSchema } from '@allrice/contracts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import {
  installBrowserControlGrant,
  createBrowserWorkspace,
  acknowledgeBrowserControl,
  createBrowserOperation,
  requestBrowserControl,
  createBrowserDirectInput,
  consumeBrowserDirectInput,
  listBrowserWorkspaces,
  revokeBrowserControlGrant,
  readCurrentBrowserWorkspace,
  recordBrowserStopped,
} from './browser-control.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import { startBrowserWorkspaceController } from '../../../apps/worker/src/browser-control/controller.js';
import { setTimeout as delay } from 'node:timers/promises';
import type * as Client from './core/client.ts';
let db: ReturnType<typeof postgres>,
  admin: ReturnType<typeof postgres>,
  storageRoot: string;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
const schema = `p21_browser_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const profile = {
  version: 1 as const,
  origins: ['https://browser.example.test'],
  allowHumanCredentials: true,
};
async function fixture() {
  const f = await createCloudExecutionFixture(db, storageRoot, {
    browserControl: true,
  });
  const grant = await installBrowserControlGrant(
    f.context,
    { targetId: f.target, ownerId: f.user, profile, enabled: true },
    db,
  );
  const [job] = await db<
    { attempt: number; lease_token: string }[]
  >`select attempt,lease_token from allrice_jobs where id=${f.execution.jobId}`;
  const w = await createBrowserWorkspace(
    {
      context: f.execution,
      callId: randomUUID(),
      url: profile.origins[0] + '/',
      jobAttempt: job!.attempt,
      jobLeaseToken: job!.lease_token,
    },
    db,
  );
  const observation = (fence: number) =>
    BrowserObservationSchema.parse({
      version: 1,
      id: randomUUID(),
      profileId: w.profile_id,
      fence,
      revision: fence,
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      url: profile.origins[0] + '/',
      title: 'Synthetic',
      text: 'untrusted',
      pageDigest: runtimePolicyDigest('synthetic'),
      elements: [
        {
          id: 'e1',
          tag: 'input',
          label: 'password',
          inputType: 'password',
          sensitive: true,
        },
        {
          id: 'e2',
          tag: 'button',
          label: 'Save',
          inputType: '',
          sensitive: false,
        },
      ],
      screenshotObjectId: null,
    });
  const obs = observation(1);
  await acknowledgeBrowserControl(f.context, w.id, 1, obs, db);
  const command = {
    version: 1 as const,
    workspaceId: w.id,
    profileId: w.profile_id,
    actor: 'agent' as const,
    fence: 1,
    observationId: obs.id,
    action: { type: 'click' as const, elementId: 'e2' },
  };
  return { ...f, w, grant, obs, observation, command };
}
suite('P21 real PostgreSQL control and exact admission', () => {
  beforeAll(async () => {
    if (!process.env.ALLRICE_TEST_DATABASE_URL)
      throw Error('dedicated DB required');
    vi.stubEnv('ALLRICE_BROWSER_CONTROL_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
    vi.stubEnv('ALLRICE_BROWSER_CONTROL_KEY', '17'.repeat(32));
    admin = postgres(process.env.ALLRICE_TEST_DATABASE_URL, {
      max: 2,
      onnotice: () => {},
    });
    await admin.unsafe(`create schema ${schema}`);
    const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    db = postgres(url.toString(), { max: 8, onnotice: () => {} });
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory))
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await db.unsafe(await readFile(new URL(file, directory), 'utf8'));
    storageRoot = await mkdtemp(join(tmpdir(), 'allrice-p21-test-'));
  }, 60000);
  afterAll(async () => {
    await db?.end();
    if (admin) {
      if (!/^p21_browser_[a-f0-9]{32}$/.test(schema))
        throw Error('unsafe schema');
      await admin.unsafe(`drop schema ${schema} cascade`);
      await admin.end();
    }
    if (storageRoot?.includes('/allrice-p21-test-'))
      await rm(storageRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  it('exact operation always asks; takeover invalidates old approval without fabricating revocation or stop', async () => {
    const f = await fixture(),
      op = await createBrowserOperation(f.context, f.command, randomUUID(), db);
    expect(op.snapshot.status).toBe('waiting_user');
    const [view] = await listBrowserWorkspaces(f.context, f.run, db),
      original = view!.operations[0]!.approval!.request;
    const take = await requestBrowserControl(
      f.context,
      f.w.id,
      {
        requestId: randomUUID(),
        expectedFence: 1,
        control: 'human',
        observationId: f.obs.id,
      },
      db,
    );
    expect(take.fence).toBe(2);
    const pending = await readCurrentBrowserWorkspace(f.context, f.w.id, db);
    expect(pending.state).toBe('takeover_pending');
    expect(pending.acknowledged_fence).toBe(1);
    expect(pending.stopped_at).toBeNull();
    const [changed] = await listBrowserWorkspaces(f.context, f.run, db);
    expect(changed!.operations[0]!.available).toBe(false);
    expect(changed!.operations[0]!.approval!.revokedAt).toBeNull();
    expect(changed!.operations[0]!.approval!.request).toEqual(original);
    await expect(f.approve(op)).rejects.toThrow();
    await acknowledgeBrowserControl(f.context, f.w.id, 2, f.observation(2), db);
    expect(
      (await readCurrentBrowserWorkspace(f.context, f.w.id, db)).state,
    ).toBe('human');
  });
  it('encrypted human input binds all scope, is consumed once, and never appears in model payload', async () => {
    const f = await fixture();
    await requestBrowserControl(
      f.context,
      f.w.id,
      {
        requestId: randomUUID(),
        expectedFence: 1,
        control: 'human',
        observationId: f.obs.id,
      },
      db,
    );
    const obs = f.observation(2);
    await acknowledgeBrowserControl(f.context, f.w.id, 2, obs, db);
    const secret = 'B4-synthetic-password',
      input = await createBrowserDirectInput(
        f.context,
        f.w.id,
        { fence: 2, observationId: obs.id, elementId: 'e1', value: secret },
        db,
      );
    const command = {
      ...f.command,
      actor: 'human' as const,
      fence: 2,
      observationId: obs.id,
      action: {
        type: 'sensitive_fill' as const,
        elementId: 'e1',
        inputId: input.inputId,
      },
    };
    const op = await createBrowserOperation(
      f.context,
      command,
      randomUUID(),
      db,
    );
    expect(JSON.stringify(op.payload)).not.toContain(secret);
    const [stored] = await db<
      { envelope: unknown }[]
    >`select envelope from allrice_browser_direct_inputs where id=${input.inputId}`;
    expect(JSON.stringify(stored)).not.toContain(secret);
    const bytes = await consumeBrowserDirectInput(
      f.context,
      f.w.id,
      command,
      db,
    );
    expect(bytes.toString()).toBe(secret);
    bytes.fill(0);
    await expect(
      consumeBrowserDirectInput(f.context, f.w.id, command, db),
    ).rejects.toThrow();
    expect(
      (
        await db`select envelope from allrice_browser_direct_inputs where id=${input.inputId}`
      )[0]!.envelope,
    ).toBeNull();
  });
  it('revoke denies old approval and shows request, not physical stop; unauthorized worker cannot erase inputs', async () => {
    const f = await fixture(),
      op = await createBrowserOperation(f.context, f.command, randomUUID(), db);
    await revokeBrowserControlGrant(f.context, f.grant.id, db);
    const [view] = await listBrowserWorkspaces(f.context, f.run, db);
    expect(view!.state).toBe('close_pending');
    expect(view!.stoppedAt).toBeNull();
    expect(view!.available).toBe(false);
    await expect(f.approve(op)).rejects.toThrow();
    await recordBrowserStopped(f.w.id, randomUUID(), randomUUID(), true, db);
    expect((await listBrowserWorkspaces(f.context, f.run, db))[0]!.state).toBe(
      'close_pending',
    );
    await recordBrowserStopped(
      f.w.id,
      f.worker,
      f.w.job_lease_token,
      false,
      db,
    );
    expect((await listBrowserWorkspaces(f.context, f.run, db))[0]!.state).toBe(
      'unknown',
    );
  });
  it('cross tenant/member/archive failures deny; history is owner-only; immutable payload rejects update', async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      listBrowserWorkspaces(other.context, f.run, db),
    ).rejects.toThrow('run_not_owned');
    await expect(
      installBrowserControlGrant(
        { ...f.context, actor: other.context.actor },
        { targetId: f.target, ownerId: f.user, profile, enabled: true },
        db,
      ),
    ).rejects.toThrow();
    const op = await createBrowserOperation(
      f.context,
      f.command,
      randomUUID(),
      db,
    );
    await expect(
      db`update allrice_browser_operation_inputs set payload='{}' where operation_id=${op.snapshot.binding.attempt.operationId}`,
    ).rejects.toThrow('immutable');
    await db`update allrice_workspaces set archived_at=clock_timestamp() where id=${f.workspace}`;
    await expect(
      readCurrentBrowserWorkspace(f.context, f.w.id, db),
    ).rejects.toThrow('membership_denied');
  });
  it('controller acknowledges takeover only AFTER native I/O settles; never restarts an uncertain action', async () => {
    const f = await fixture();
    let settle!: () => void,
      started = false,
      closed = false;
    const physical = new Promise<void>((r) => {
      settle = r;
    });
    const fake = {
      observe: async (fence: number) => ({
        observation: f.observation(fence),
        screenshot: Buffer.from('synthetic-image'),
      }),
      perform: vi.fn(async () => {
        started = true;
        await physical;
        return {};
      }),
      close: async () => {
        closed = true;
      },
    };
    const controller = startBrowserWorkspaceController(f.w, {
      storage: f.storage,
      database: db,
      driver: async () => fake,
    });
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 150; i++) {
        if (await check()) return;
        await delay(30);
      }
      throw Error('controller condition timeout');
    };
    try {
      await until(async () => {
        const [row] =
          await db`select state,observation from allrice_browser_workspaces where id=${f.w.id}`;
        return row!.state === 'agent' && row!.observation === null;
      });
      const op = await createBrowserOperation(
        f.context,
        {
          ...f.command,
          observationId: null,
          action: { type: 'navigate', url: profile.origins[0] + '/' },
        },
        randomUUID(),
        db,
      );
      await f.approve(op);
      await until(async () => started);
      await requestBrowserControl(
        f.context,
        f.w.id,
        {
          requestId: randomUUID(),
          expectedFence: 1,
          control: 'human',
          observationId: null,
        },
        db,
      );
      await delay(150);
      const pending = await readCurrentBrowserWorkspace(f.context, f.w.id, db);
      expect(pending.state).toBe('takeover_pending');
      expect(pending.acknowledged_fence).toBe(1);
      settle();
      await until(
        async () =>
          (await readCurrentBrowserWorkspace(f.context, f.w.id, db)).state ===
          'human',
      );
      const [view] = await listBrowserWorkspaces(f.context, f.run, db);
      expect(view!.operations[0]!.snapshot.status).toBe('unknown');
      expect(fake.perform).toHaveBeenCalledOnce();
      await requestBrowserControl(
        f.context,
        f.w.id,
        {
          requestId: randomUUID(),
          expectedFence: 2,
          control: 'closed',
          observationId: null,
        },
        db,
      );
      await controller.closed;
      expect(closed).toBe(true);
      expect(
        (await listBrowserWorkspaces(f.context, f.run, db))[0]!.state,
      ).toBe('closed');
    } finally {
      settle();
      await recordBrowserStopped(
        f.w.id,
        f.worker,
        f.w.job_lease_token,
        false,
        db,
      );
      await controller.closed;
    }
  }, 15000);
});
