import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BrowserObservationSchema } from '@allrice/contracts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import { listBrowserControlManagement } from './browser-control-management.ts';
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
  recordBrowserObservation,
} from './browser-control.ts';
import {
  runtimePolicyDigest,
  decideRuntimeActionApproval,
} from './runtime-policy.ts';
import {
  startBrowserWorkspaceController,
  waitBrowserOperationResult,
} from '../../../apps/worker/src/browser-control/controller.js';
import {
  setTimeout as delay,
  setImmediate as yieldTurn,
} from 'node:timers/promises';
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
  origins: ['https://example.com'],
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
  const observation = (fence: number) => {
    const capturedAt = new Date();
    return BrowserObservationSchema.parse({
      version: 1,
      id: randomUUID(),
      profileId: w.profile_id,
      fence,
      revision: fence,
      capturedAt: capturedAt.toISOString(),
      expiresAt: new Date(capturedAt.getTime() + 60000).toISOString(),
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
  };
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
  it('cloud recording and control ACK reject the same overlong observation lifetime as local admission', async () => {
    const f = await fixture();
    const overlong = {
      ...f.obs,
      expiresAt: new Date(Date.parse(f.obs.capturedAt) + 60_001).toISOString(),
    };
    await expect(
      recordBrowserObservation(f.context, f.w.id, overlong, db),
    ).rejects.toMatchObject({ code: 'browser_observation_stale' });
    await expect(
      acknowledgeBrowserControl(f.context, f.w.id, 1, overlong, db),
    ).rejects.toMatchObject({ code: 'browser_observation_stale' });
    expect(
      (await readCurrentBrowserWorkspace(f.context, f.w.id, db)).observation,
    ).toEqual(f.obs);
  });
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
  it('management is read-only, exact tenant/admin scoped, including archived and revoked grants', async () => {
    const f = await fixture(),
      other = await fixture();
    const list = await listBrowserControlManagement(f.context, db);
    expect(list.grants.map((g) => g.id)).toEqual([f.grant.id]);
    expect(list.targets.some((t) => t.id === other.target)).toBe(false);
    const [before] =
      await db`select count(*)::int n from allrice_browser_control_grants`;
    await listBrowserControlManagement(f.context, db);
    expect(
      (await db`select count(*)::int n from allrice_browser_control_grants`)[0]!
        .n,
    ).toBe(before!.n);
    await revokeBrowserControlGrant(f.context, f.grant.id, db);
    expect(
      (await listBrowserControlManagement(f.context, db)).grants[0]!.revokedAt,
    ).not.toBeNull();
    await db`update allrice_memberships set role='member' where user_id=${f.user}`;
    await expect(listBrowserControlManagement(f.context, db)).rejects.toThrow(
      'membership_denied',
    );
    await expect(
      listBrowserControlManagement(
        { ...other.context, workspaceId: f.workspace },
        db,
      ),
    ).rejects.toThrow('membership_denied');
    await db`update allrice_workspaces set archived_at=clock_timestamp() where id=${other.workspace}`;
    await expect(
      listBrowserControlManagement(other.context, db),
    ).rejects.toThrow('membership_denied');
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
    for (const origin of [
      'https://127.0.0.1',
      'https://localhost',
      'https://[::1]',
      'https://host.internal',
    ]) {
      await expect(
        installBrowserControlGrant(
          f.context,
          {
            targetId: f.target,
            ownerId: f.user,
            profile: { ...profile, origins: [origin] },
            enabled: true,
          },
          db,
        ),
      ).rejects.toThrow('browser_public_origin_required');
    }
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
  it('does not return a prepared result before its ledger receipt and resulting observation are durable', async () => {
    const f = await fixture();
    const approved = await createBrowserOperation(
      f.context,
      {
        ...f.command,
        observationId: null,
        action: { type: 'navigate', url: profile.origins[0] + '/' },
      },
      randomUUID(),
      db,
    );
    const operationId = approved.snapshot.binding.attempt.operationId;
    await f.approve(approved);
    let prepared!: () => void,
      observedPrepared!: () => void,
      resumeReceipt!: () => void;
    let capturing!: () => void, resumeCapture!: () => void;
    const preparedResult = new Promise<void>((r) => {
      prepared = r;
    });
    const readerObserved = new Promise<void>((r) => {
      observedPrepared = r;
    });
    const receiptGate = new Promise<void>((r) => {
      resumeReceipt = r;
    });
    const captureStarted = new Promise<void>((r) => {
      capturing = r;
    });
    const captureGate = new Promise<void>((r) => {
      resumeCapture = r;
    });
    const instrumented = new Proxy(db, {
      apply(target, thisArg, args: unknown[]) {
        const fragments = args[0];
        const sql = Array.isArray(fragments) ? fragments.join('?') : '';
        const result = Reflect.apply(target, thisArg, args);
        if (sql.includes('update allrice_browser_operation_inputs set result='))
          return result.then(async (rows: unknown) => {
            // The real autocommit completed; only delivery to finish() pauses.
            // No row/receipt/ledger status or query result is manufactured.
            prepared();
            await receiptGate;
            return rows;
          });
        if (sql.includes('select i.result,o.snapshot'))
          return result.then(
            (rows: { result: unknown; snapshot: { status: string } }[]) => {
              if (rows[0]?.result && rows[0].snapshot.status === 'running')
                observedPrepared();
              return rows;
            },
          );
        return result;
      },
    });
    const fake = {
      observe: async (fence: number) => {
        capturing();
        await captureGate;
        return {
          observation: f.observation(fence),
          screenshot: Buffer.from('synthetic-image'),
        };
      },
      perform: vi.fn(async () => ({})),
      close: async () => {},
    };
    const abort = new AbortController();
    const controller = startBrowserWorkspaceController(f.w, {
      storage: f.storage,
      database: instrumented,
      driver: async () => fake,
      signal: abort.signal,
    });
    let resultTask: ReturnType<typeof waitBrowserOperationResult> | undefined;
    let returned = false;
    try {
      await preparedResult;
      const [saved] =
        await db`select i.result,o.snapshot->>'status' as status from allrice_browser_operation_inputs i join allrice_runtime_operations o on o.id=i.operation_id where o.id=${operationId}`;
      expect(saved!.result).toBeTruthy();
      expect(saved!.status).toBe('running');
      resultTask = waitBrowserOperationResult(
        f.context,
        f.w.id,
        operationId,
        instrumented,
        abort.signal,
      );
      void resultTask.then(
        () => {
          returned = true;
        },
        () => {
          returned = true;
        },
      );
      await readerObserved;
      await yieldTurn(); // Drain the read's promise continuations, not a timed completion guess.
      expect(returned).toBe(false);
      resumeReceipt();
      await captureStarted;
      const [projected] =
        await db`select snapshot->>'status' as status from allrice_runtime_operations where id=${operationId}`;
      expect(projected!.status).toBe('succeeded');
      await yieldTurn();
      expect(returned).toBe(false);
      resumeCapture();
      const result = await resultTask;
      expect(result.status).toBe('succeeded');
      expect(result.observation!.id).not.toBe(f.obs.id);
      expect(result.observationRefreshRequired).toBe(false);
      expect(fake.perform).toHaveBeenCalledOnce();
    } finally {
      resumeReceipt();
      resumeCapture();
      abort.abort();
      await resultTask?.catch(() => undefined);
      await controller.closed;
    }
  }, 15000);
  it.each(['frozen prior observation', 'no frozen observation'] as const)(
    'does not return a pre-action capture when navigate has a null observation ID: %s',
    async (baseline) => {
      const f = await fixture();
      if (baseline === 'no frozen observation')
        await acknowledgeBrowserControl(f.context, f.w.id, 1, null, db);
      const approved = await createBrowserOperation(
        f.context,
        {
          ...f.command,
          observationId: null,
          action: { type: 'navigate', url: profile.origins[0] + '/' },
        },
        randomUUID(),
        db,
      );
      const operationId = approved.snapshot.binding.attempt.operationId;
      await f.approve(approved);
      const [input] =
        await db`select payload,observation from allrice_browser_operation_inputs where operation_id=${operationId}`;
      expect(input!.payload.observationId).toBeNull();
      expect(input!.observation?.id ?? null).toBe(
        baseline === 'no frozen observation' ? null : f.obs.id,
      );
      let started!: () => void, resumeAction!: () => void;
      let capturing!: () => void, resumeCapture!: () => void;
      let observedTerminal!: () => void;
      let linking!: () => void,
        resumeLink!: () => void,
        observedUnlinked!: () => void;
      let linkRequested = false;
      const actionStarted = new Promise<void>((r) => {
        started = r;
      });
      const actionGate = new Promise<void>((r) => {
        resumeAction = r;
      });
      const captureStarted = new Promise<void>((r) => {
        capturing = r;
      });
      const captureGate = new Promise<void>((r) => {
        resumeCapture = r;
      });
      const readerObserved = new Promise<void>((r) => {
        observedTerminal = r;
      });
      const linkStarted = new Promise<void>((r) => {
        linking = r;
      });
      const linkGate = new Promise<void>((r) => {
        resumeLink = r;
      });
      const readerSawUnlinked = new Promise<void>((r) => {
        observedUnlinked = r;
      });
      const instrumented = new Proxy(db, {
        apply(target, thisArg, args: unknown[]) {
          const fragments = args[0];
          const sql = Array.isArray(fragments) ? fragments.join('?') : '';
          const result = Reflect.apply(target, thisArg, args);
          if (
            sql.includes(
              'update allrice_browser_operation_inputs set result_observation_id=',
            )
          ) {
            linkRequested = true;
            linking();
            return linkGate.then(() => result);
          }
          if (sql.includes('select i.result,o.snapshot'))
            return result.then(
              (
                rows: {
                  snapshot: { status: string };
                  result_observation_id: string | null;
                }[],
              ) => {
                if (rows[0]?.snapshot.status === 'succeeded')
                  observedTerminal();
                if (linkRequested && rows[0]?.result_observation_id === null)
                  observedUnlinked();
                return rows;
              },
            );
          return result;
        },
      });
      const after = f.observation(1);
      const driver = {
        perform: vi.fn(async () => {
          started();
          await actionGate;
          return {};
        }),
        observe: async () => {
          capturing();
          await captureGate;
          return {
            observation: after,
            screenshot: Buffer.from('synthetic-image'),
          };
        },
        close: async () => {},
      };
      const abort = new AbortController();
      const controller = startBrowserWorkspaceController(f.w, {
        storage: f.storage,
        database: instrumented,
        driver: async () => driver,
        signal: abort.signal,
      });
      let task: ReturnType<typeof waitBrowserOperationResult> | undefined;
      let returned = false;
      try {
        await actionStarted;
        // A real current observation may predate the physical action even when
        // no observation was frozen into that action (for example initial open).
        // No clock comparison or fabricated result/ledger state is involved.
        await recordBrowserObservation(f.context, f.w.id, f.obs, db);
        resumeAction();
        await captureStarted;
        task = waitBrowserOperationResult(
          f.context,
          f.w.id,
          operationId,
          instrumented,
          abort.signal,
        );
        void task.then(
          () => {
            returned = true;
          },
          () => {
            returned = true;
          },
        );
        await readerObserved;
        await yieldTurn();
        expect(returned).toBe(false);
        const [prepared] =
          await db`select result,receipt from allrice_browser_operation_inputs where operation_id=${operationId}`;
        resumeCapture();
        await linkStarted;
        await readerSawUnlinked;
        await yieldTurn();
        expect(returned).toBe(false);
        expect(
          (await readCurrentBrowserWorkspace(f.context, f.w.id, db)).observation
            ?.id,
        ).toBe(after.id);
        resumeLink();
        const result = await task;
        expect(result.status).toBe('succeeded');
        expect(result.observation?.id).toBe(after.id);
        expect(result.observationRefreshRequired).toBe(false);
        expect(driver.perform).toHaveBeenCalledOnce();
        const [linked] =
          await db`select result,receipt,result_observation_id from allrice_browser_operation_inputs where operation_id=${operationId}`;
        expect(linked!.result_observation_id).toBe(after.id);
        expect(linked!.result).toEqual(prepared!.result);
        expect(linked!.receipt).toEqual(prepared!.receipt);
        await expect(
          db`update allrice_browser_operation_inputs set result_observation_id=${randomUUID()} where operation_id=${operationId}`,
        ).rejects.toThrow('browser result observation is immutable');
        await expect(
          db`update allrice_browser_operation_inputs set result_observation_id=null where operation_id=${operationId}`,
        ).rejects.toThrow('browser result observation is immutable');
      } finally {
        resumeAction();
        resumeCapture();
        resumeLink();
        abort.abort();
        await task?.catch(() => undefined);
        await controller.closed;
      }
    },
    15000,
  );
  it('a rejected head does not starve the next approved action; result waits for a new observation', async () => {
    const f = await fixture(),
      command = {
        ...f.command,
        observationId: null,
        action: { type: 'navigate' as const, url: profile.origins[0] + '/' },
      };
    const rejected = await createBrowserOperation(
        f.context,
        command,
        randomUUID(),
        db,
      ),
      approved = await createBrowserOperation(
        f.context,
        command,
        randomUUID(),
        db,
      );
    const req = (
      await listBrowserWorkspaces(f.context, f.run, db)
    )[0]!.operations.find(
      (o) =>
        o.snapshot.binding.attempt.operationId ===
        rejected.snapshot.binding.attempt.operationId,
    )!.approval!.request;
    await decideRuntimeActionApproval(
      f.context,
      req.approvalId,
      {
        contractVersion: 1,
        direction: 'response',
        kind: 'action_approval',
        requestId: req.requestId,
        version: req.version,
        requestDigest: req.requestDigest,
        task: req.task,
        responseId: randomUUID(),
        respondedBy: f.user,
        respondedAt: new Date().toISOString(),
        approvalId: req.approvalId,
        decision: 'rejected',
      },
      db,
    );
    await f.approve(approved);
    const fake = {
      observe: async (fence: number) => {
        // A physical capture may cross the 500ms operation heartbeat interval.
        // A completed ledger operation must no longer renew a running lease.
        await delay(750);
        return {
          observation: f.observation(fence),
          screenshot: Buffer.from('synthetic-image'),
        };
      },
      perform: vi.fn(async () => ({})),
      close: async () => {},
    };
    const abort = new AbortController(),
      controller = startBrowserWorkspaceController(f.w, {
        storage: f.storage,
        database: db,
        driver: async () => fake,
        signal: abort.signal,
      });
    try {
      const result = await waitBrowserOperationResult(
        f.context,
        f.w.id,
        approved.snapshot.binding.attempt.operationId,
        db,
        abort.signal,
      );
      expect(result.status).toBe('succeeded');
      expect(result.observation).not.toBeNull();
      expect(result.observation!.id).not.toBe(f.obs.id);
      expect(result.observationRefreshRequired).toBe(false);
      await delay(250);
      expect(
        (await readCurrentBrowserWorkspace(f.context, f.w.id, db)).state,
      ).toBe('agent');
      expect(fake.perform).toHaveBeenCalledOnce();
      const denied = await waitBrowserOperationResult(
        f.context,
        f.w.id,
        rejected.snapshot.binding.attempt.operationId,
        db,
        abort.signal,
      );
      expect(denied.result).toMatchObject({
        effects: 'none',
        code: 'BROWSER_APPROVAL_UNAVAILABLE',
      });
      expect(denied.observation).toBeNull();
      expect(
        (
          await db`select version_id from allrice_workbench_artifacts where run_id=${f.run}`
        ).length,
      ).toBeGreaterThan(0);
    } finally {
      abort.abort();
      await controller.closed;
    }
  }, 15000);
});
