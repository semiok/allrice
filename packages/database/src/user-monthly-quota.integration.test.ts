import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';
import { getUserMonthlyQuota } from './providers/model-governance.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration('current user monthly quota (isolated PostgreSQL)', () => {
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    database = await createAssistantFixtureDatabase();
  }, 120000);
  afterAll(async () => {
    if (database) await database.close();
    vi.unstubAllEnvs();
  });
  async function fixture() {
    const f = await assistantFixture(database.db);
    const db = database.db,
      org = f.context.organizationId,
      ws = f.context.workspaceId!,
      user = f.context.actor.id;
    const [employee] =
      await db`select id from allrice_employees where workspace_id=${ws}`;
    let attempt = 0;
    const receipt = async (
      input: number,
      output: number,
      cached: number,
      old = false,
      actor = user,
      complete = true,
    ) => {
      const id = randomUUID();
      await db`insert into allrice_route_decisions(id,organization_id,workspace_id,actor_id,employee_id,run_id,input_checksum,candidates,selected_kind,selected_candidate_id,harness,provider,model,generation,attempt,reason_codes,created_at)
        values(${id},${org},${ws},${actor},${employee!.id},${f.task.runId},${`sha256:${'a'.repeat(64)}`},'[]','direct','synthetic','dsh','openai-compatible','synthetic',1,${++attempt},'[]',now())`;
      await db`insert into allrice_model_usage_ledger(id,organization_id,workspace_id,route_decision_id,status,input_tokens,cached_input_tokens,output_tokens,cost_cents,occurred_at,usage_complete)
        values(${randomUUID()},${org},${ws},${id},'succeeded',${input},${cached},${output},0,
        case when ${old} then date_trunc('month',now())-interval '1 second' else now() end,${complete})`;
    };
    return {
      f,
      db,
      org,
      ws,
      user,
      receipt,
      read: () => getUserMonthlyQuota(f.context, ws, db),
    };
  }
  it('uses the exact admission limit and cache-inclusive receipts, excluding prior months and other users', async () => {
    const t = await fixture(),
      other = randomUUID();
    await t.db`insert into allrice_users(id,email,display_name,password_hash) values(${other},${`${other}@example.test`},'Other','not-login')`;
    await t.receipt(2000000, 824029, 1500000);
    await t.receipt(9000000, 0, 0, true);
    await t.receipt(8000000, 0, 0, false, other);
    expect(await t.read()).toMatchObject({
      monthlyTokenLimit: 2000000,
      usedTokens: 2824029,
      remainingTokens: 0,
      remainingPercent: 0,
      unknownUsageRuns: 0,
    });
    await t.db`insert into allrice_model_resource_limits(id,organization_id,scope_type,scope_id,monthly_run_limit,monthly_token_limit,concurrent_run_limit,max_runtime_ms)
      values(${randomUUID()},${t.org},'user',${t.user},2000,5000000,3,1800000)`;
    const result = await t.read();
    expect(result).toMatchObject({
      userId: t.user,
      workspaceId: t.ws,
      monthlyTokenLimit: 5000000,
      usedTokens: 2824029,
      remainingTokens: 2175971,
    });
    expect(result.remainingPercent).toBeCloseTo(43.51942);
    expect(Date.parse(result.resetsAt)).toBeGreaterThan(
      Date.parse(result.observedAt),
    );
    expect(Date.parse(result.periodStart)).toBeLessThanOrEqual(
      Date.parse(result.observedAt),
    );
    await t.receipt(100, 0, 0, false, t.user, false);
    expect(await t.read()).toMatchObject({
      usedTokens: 2824129,
      unknownUsageRuns: 1,
    });
  });
  it('permits ordinary members without cached admin claims, and rechecks revocation', async () => {
    const t = await fixture();
    await t.db`update allrice_memberships set role='member' where user_id=${t.user}`;
    expect(await t.read()).toMatchObject({
      usedTokens: 0,
      remainingPercent: 100,
    });
    await t.db`update allrice_memberships set active=false where user_id=${t.user}`;
    await expect(t.read()).rejects.toMatchObject({
      code: 'authorization_denied',
    });
  });
  it('denies other tenants, ungranted workspaces, and non-user actors', async () => {
    const a = await fixture(),
      b = await fixture(),
      ws = randomUUID();
    await expect(
      getUserMonthlyQuota(a.f.context, b.ws, a.db),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await a.db`insert into allrice_workspaces(id,organization_id,slug,name) values(${ws},${a.org},'other','Other')`;
    await expect(
      getUserMonthlyQuota(a.f.context, ws, a.db),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      getUserMonthlyQuota(
        { ...a.f.context, actor: { type: 'worker', id: randomUUID() } },
        a.ws,
        a.db,
      ),
    ).rejects.toMatchObject({ code: 'authentication_required' });
  });
});
