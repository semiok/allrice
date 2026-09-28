import { randomUUID } from 'node:crypto';
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import * as client from '../core/client.ts';
import { createAssistantFixtureDatabase } from '../assistant-runtime.fixture.ts';
import { createExperienceFixture } from '../experience.fixture.ts';
import {
  listCodexSubscriptions,
  readEnabledCodexSubscription,
  requireEnabledCodexSubscription,
  selectCodexSubscription,
} from './codex-subscriptions.ts';
import { recordCodexProviderStatus, getCodexProviderStatus } from './status.ts';
import {
  startCodexAuthorization,
  cancelCodexAuthorization,
  claimCodexAuthorizationFlow,
  publishCodexAuthorizationChallenge,
  getCodexAuthorization,
  completeCodexAuthorization,
  getCodexProviderGrant,
} from './provider-auth.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('Codex slots: isolated PostgreSQL, no credentials or model calls', () => {
  let db: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  let f: Awaited<ReturnType<typeof createExperienceFixture>>;
  beforeAll(async () => {
    db = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(db.db);
    f = await createExperienceFixture(db.db);
  }, 120000);
  beforeEach(async () => {
    await db.db`delete from allrice_provider_authorization_flows`;
    await db.db`delete from allrice_provider_status`;
    await db.db`delete from allrice_jobs`;
    await db.db`update allrice_codex_subscriptions set enabled=false`;
    await db.db`update allrice_codex_subscriptions set enabled=true where slot=1`;
    for (const slot of [1, 2] as const)
      await recordCodexProviderStatus(
        {
          provider: 'codex',
          authMode: 'chatgpt_subscription',
          status: 'connected',
          checkedAt: new Date().toISOString(),
          cliVersion: null,
          detailCode: `synthetic-${slot}`,
          quota: null,
        },
        slot,
      );
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await db?.close();
  });
  it('preserves named slot 1, switches atomically, and supports all off', async () => {
    expect(await listCodexSubscriptions(f.reviewer)).toMatchObject([
      { slot: 1, label: 'metasnowsky', enabled: true },
      { slot: 2, label: 'encorealpha', enabled: false },
    ]);
    await selectCodexSubscription(f.reviewer, {
      enabledSlot: 2,
      expectedEnabledSlot: 1,
    });
    expect(await readEnabledCodexSubscription()).toBe(2);
    expect((await getCodexProviderStatus()).detailCode).toBe('synthetic-2');
    expect((await getCodexProviderStatus(1)).detailCode).toBe('synthetic-1');
    await selectCodexSubscription(f.reviewer, {
      enabledSlot: null,
      expectedEnabledSlot: 2,
    });
    expect(await readEnabledCodexSubscription()).toBeNull();
    await expect(requireEnabledCodexSubscription()).rejects.toMatchObject({
      code: 'disabled',
    });
    expect((await getCodexProviderStatus()).detailCode).toBe(
      'codex_subscriptions_disabled',
    );
    expect((await getCodexProviderStatus(1)).status).toBe('connected');
    await selectCodexSubscription(f.reviewer, {
      enabledSlot: 1,
      expectedEnabledSlot: null,
    });
    await expect(
      db.db`update allrice_codex_subscriptions set enabled=true where slot=2`,
    ).rejects.toMatchObject({ code: '23505' });
  });
  it('rejects tenant callers, unconnected slots, stale clicks and concurrent admin requests', async () => {
    await expect(
      selectCodexSubscription(f.owner, {
        enabledSlot: 2,
        expectedEnabledSlot: 1,
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await db.db`update allrice_provider_status set status='disconnected' where subscription_slot=2`;
    await expect(
      selectCodexSubscription(f.reviewer, {
        enabledSlot: 2,
        expectedEnabledSlot: 1,
      }),
    ).rejects.toMatchObject({ code: 'authorization_required' });
    await db.db`update allrice_provider_status set status='connected' where subscription_slot=2`;
    const results = await Promise.allSettled([
      selectCodexSubscription(f.reviewer, {
        enabledSlot: 2,
        expectedEnabledSlot: 1,
      }),
      selectCodexSubscription(f.reviewer, {
        enabledSlot: null,
        expectedEnabledSlot: 1,
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'conflict' },
    });
  });
  it.each(['queued', 'claimed', 'running', 'retry_wait', 'waiting_approval'])(
    'cannot switch or disable while a %s task exists',
    async (status) => {
      await db.db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload)
    values(${randomUUID()},${f.org},${f.workspace},${f.user},${f.run},${status},${randomUUID()},now()+interval '1 hour','{}')`;
      await expect(
        selectCodexSubscription(f.reviewer, {
          enabledSlot: 2,
          expectedEnabledSlot: 1,
        }),
      ).rejects.toMatchObject({ code: 'busy' });
      await expect(
        selectCodexSubscription(f.reviewer, {
          enabledSlot: null,
          expectedEnabledSlot: 1,
        }),
      ).rejects.toMatchObject({ code: 'busy' });
      expect(await readEnabledCodexSubscription()).toBe(1);
    },
  );
  it('keeps slot 2 authorization/code/grant independent and never activates on login', async () => {
    await expect(
      startCodexAuthorization(f.reviewer, { subscriptionSlot: 1 }),
    ).rejects.toMatchObject({ code: 'enabled_authorization' });
    const flow = await startCodexAuthorization(f.reviewer, {
      subscriptionSlot: 2,
    });
    expect(flow.subscriptionSlot).toBe(2);
    expect(
      (await startCodexAuthorization(f.reviewer, { subscriptionSlot: 2 })).id,
    ).toBe(flow.id);
    const worker = randomUUID();
    expect((await claimCodexAuthorizationFlow(worker))?.subscriptionSlot).toBe(
      2,
    );
    await publishCodexAuthorizationChallenge({
      flowId: flow.id,
      workerId: worker,
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: 'TEST-TWO',
    });
    expect(await getCodexAuthorization(f.reviewer, undefined, 1)).toBeNull();
    expect(await getCodexAuthorization(f.reviewer, undefined, 2)).toMatchObject(
      { userCode: 'TEST-TWO' },
    );
    await expect(
      selectCodexSubscription(f.reviewer, {
        enabledSlot: 2,
        expectedEnabledSlot: 1,
      }),
    ).rejects.toMatchObject({ code: 'authorization_required' });
    await completeCodexAuthorization({
      flowId: flow.id,
      workerId: worker,
      connected: true,
      detailCode: 'synthetic',
    });
    expect(await getCodexProviderGrant(f.reviewer, 2)).toMatchObject({
      subscriptionSlot: 2,
      status: 'connected',
    });
    expect(await readEnabledCodexSubscription()).toBe(1);
  });
  it('canceling account 2 authorization retains account 1 and records the right slot', async () => {
    const flow = await startCodexAuthorization(f.reviewer, {
      subscriptionSlot: 2,
    });
    expect(await cancelCodexAuthorization(f.reviewer, flow.id)).toMatchObject({
      subscriptionSlot: 2,
      state: 'canceled',
    });
    expect(await readEnabledCodexSubscription()).toBe(1);
    expect((await getCodexProviderStatus(1)).status).toBe('connected');
    const [audit] =
      await db.db`select metadata from allrice_audit_events where action='provider_authorization.cancel' and metadata->>'flowId'=${flow.id}`;
    expect(audit?.metadata.subscriptionSlot).toBe(2);
  });
  it('job admission waits outside the switch transaction and observes its final selection', async () => {
    let release!: () => void, locked!: () => void;
    const fence = new Promise<void>((r) => {
      locked = r;
    });
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const admission = db.db.begin(async (tx) => {
      await tx`lock table allrice_jobs in row exclusive mode`;
      locked();
      await hold;
      await tx`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload)
     values(${randomUUID()},${f.org},${f.workspace},${f.user},${f.run},'queued',${randomUUID()},now()+interval '1 hour','{}')`;
    });
    await fence;
    const select = selectCodexSubscription(f.reviewer, {
      enabledSlot: 2,
      expectedEnabledSlot: 1,
    });
    release();
    await admission;
    await expect(select).rejects.toMatchObject({ code: 'busy' });
  });
});
