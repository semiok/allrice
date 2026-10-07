import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import type {
  InvestmentBaseline,
  InvestmentWork,
  InvestmentExpense,
  InvestmentStatement,
  RequestContext,
} from '@allrice/contracts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { tenantValidationFixture } from './tenant-validation.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from './identity.ts';
import {
  listInvestmentEntries,
  saveInvestmentEntry,
  readInvestmentReport,
} from './investment.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('human-confirmed investment evidence (private PostgreSQL schema)', () => {
  let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
    a: Awaited<ReturnType<typeof tenantValidationFixture>>,
    b: typeof a,
    admin: RequestContext,
    owner: RequestContext;
  const from = '2026-10-01T00:00:00Z',
    to = '2026-11-01T00:00:00Z',
    range = { range: 'custom', from, to, timeZone: 'Asia/Shanghai' };
  const baseline = (
    extra: Partial<InvestmentBaseline> = {},
  ): InvestmentBaseline => ({
    kind: 'baseline',
    key: randomUUID(),
    title: '报告',
    taskType: '运营',
    unit: '份',
    minutesPerUnit: 120,
    hourlyRateMinor: 12000,
    currency: 'CNY',
    source: '计时依据',
    ...extra,
  });
  const work = (extra: Partial<InvestmentWork> = {}): InvestmentWork => ({
    kind: 'work',
    key: randomUUID(),
    title: '报告',
    units: 1,
    sourceRunIds: [a.task.runId],
    sourceVersionId: a.artifact.artifactId,
    baselineRevisionId: null,
    adoptedAt: new Date().toISOString(),
    humanMinutes: 30,
    humanScope: 'complete',
    source: '采用及投入确认',
    ...extra,
  });
  const expense = (
    extra: Partial<InvestmentExpense> = {},
  ): InvestmentExpense => ({
    kind: 'expense',
    receiptKey: randomUUID(),
    title: '订阅',
    from,
    to,
    currency: 'CNY',
    amountMinor: 60000,
    allocations: [
      { organizationId: a.context.organizationId, amountMinor: 36000 },
      { organizationId: b.context.organizationId, amountMinor: 24000 },
    ],
    source: '真实账单声明（合成验收）',
    ...extra,
  });
  const statement = (
    extra: Partial<InvestmentStatement> = {},
  ): InvestmentStatement => ({
    kind: 'statement',
    title: '投入',
    from,
    to,
    currency: 'CNY',
    modelMinor: 3000,
    otherMinor: 2000,
    subscriptionKnown: true,
    subscriptionRevisionIds: [],
    coverage: 'complete',
    standardHours: 160,
    source: '明确费用依据',
    ...extra,
  });
  const save = (
    ctx: RequestContext,
    org: string,
    content:
      | InvestmentBaseline
      | InvestmentWork
      | InvestmentExpense
      | InvestmentStatement,
    id: string = randomUUID(),
    n = 0,
    administration = true,
  ) =>
    saveInvestmentEntry(
      ctx,
      org,
      { entryId: id, expectedRevision: n, content },
      administration,
      f.db,
    );
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    f = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    a = await tenantValidationFixture(f.db);
    b = await tenantValidationFixture(f.db);
    const p = await ensureBootstrapPortalPrincipal(
      {
        organizationSlug: 'allrice-platform',
        organizationName: 'Platform',
        workspaceSlug: 'default',
        workspaceName: 'Default',
        email: 'investment-admin@example.test',
        displayName: 'Admin',
        role: 'member',
      },
      f.db,
    );
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', p.user.email);
    admin = (await authenticateSession(
      (await createSession(p.user.id)).token,
    ))!;
    owner = {
      ...(await authenticateSession(
        (await createSession(a.context.actor.id)).token,
      ))!,
      workspaceId: a.context.workspaceId,
    };
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await f?.close();
  });
  it('admin does not need company membership; adopted business source and baseline revision freeze', async () => {
    const before =
      await f.db`select * from allrice_employee_runs where run_id=${a.task.runId}`;
    const r1 = await save(admin, a.context.organizationId, baseline());
    const w = await save(
      owner,
      a.context.organizationId,
      work({ baselineRevisionId: r1.id }),
      undefined,
      0,
      false,
    );
    await save(
      admin,
      a.context.organizationId,
      { ...(r1.content as InvestmentBaseline), minutesPerUnit: 240 },
      r1.entryId,
      1,
    );
    await save(admin, a.context.organizationId, statement());
    const r = await readInvestmentReport(
      admin,
      a.context.organizationId,
      range,
      f.db,
    );
    expect(r).toMatchObject({
      candidateWorks: 1,
      includedWorks: 1,
      savedMinutes: 90,
    });
    expect(r.samples[0]?.baseline?.id).toBe(r1.id);
    expect(r.samples[0]?.revision.facts.sourceVersion).toMatchObject({
      id: a.artifact.artifactId,
      checksum: a.artifact.digest,
    });
    expect(r.groups[0]).toMatchObject({
      valueMinor: 18000,
      ratio: 3.6,
      roi: 2.6,
    });
    expect(
      await f.db`select * from allrice_employee_runs where run_id=${a.task.runId}`,
    ).toEqual(before);
    expect(
      (
        await listInvestmentEntries(
          owner,
          a.context.organizationId,
          { entryId: w.entryId, history: true },
          f.db,
        )
      ).entries,
    ).toHaveLength(1);
  });
  it('work duplicates cannot count the same version twice and read-only history is immutable', async () => {
    await expect(
      save(owner, a.context.organizationId, work(), undefined, 0, false),
    ).rejects.toMatchObject({ code: 'business_work_exists' });
    const [r] = await f.db`select id from allrice_investment_revisions limit 1`;
    await expect(
      f.db`update allrice_investment_revisions set facts='{}' where id=${r!.id}`,
    ).rejects.toThrow('immutable');
  });
  it('competing revisions save once, preserve old evidence and reject admin impersonation', async () => {
    const [w] = (
      await listInvestmentEntries(
        owner,
        a.context.organizationId,
        { kind: 'work' },
        f.db,
      )
    ).entries;
    const content = { ...(w!.content as InvestmentWork), humanMinutes: 40 };
    const attempts = await Promise.allSettled([
      save(
        owner,
        a.context.organizationId,
        content,
        w!.entryId,
        w!.number,
        false,
      ),
      save(
        owner,
        a.context.organizationId,
        content,
        w!.entryId,
        w!.number,
        false,
      ),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (attempts.find((r) => r.status === 'rejected') as PromiseRejectedResult)
        .reason.code,
    ).toBe('version_conflict');
    expect(
      (
        await listInvestmentEntries(
          owner,
          a.context.organizationId,
          { entryId: w!.entryId, history: true },
          f.db,
        )
      ).entries
        .map((r) => r.number)
        .sort(),
    ).toEqual([1, 2]);
    await expect(
      save(admin, a.context.organizationId, work()),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });
  it('explicitly merges multiple formal Runs and formats into one business unit', async () => {
    const root = randomUUID(),
      q = randomUUID(),
      answer = randomUUID();
    await f.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state) values(${root},${a.context.organizationId},${a.context.workspaceId},${owner.actor.id},'succeeded')`;
    await f.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content) values(${q},${a.context.organizationId},${a.context.workspaceId},${a.task.chatSessionId},${owner.actor.id},'user','{"text":"same business","citations":[]}'),(${answer},${a.context.organizationId},${a.context.workspaceId},${a.task.chatSessionId},${owner.actor.id},'assistant','{"text":"another format","citations":[]}')`;
    await f.db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot) select ${root},organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,${q},${answer},provider_snapshot,prompt_snapshot from allrice_employee_runs where run_id=${a.task.runId}`;
    const nextArtifact = await a.createArtifact(
      root,
      '# Another format of the same business work',
    );
    const w = (
      await listInvestmentEntries(
        owner,
        a.context.organizationId,
        { kind: 'work' },
        f.db,
      )
    ).entries[0]!;
    await save(
      owner,
      a.context.organizationId,
      {
        ...(w.content as InvestmentWork),
        sourceRunIds: [a.task.runId, root],
        sourceVersionId: nextArtifact.artifactId,
      },
      w.entryId,
      w.number,
      false,
    );
    const report = await readInvestmentReport(
      admin,
      a.context.organizationId,
      range,
      f.db,
    );
    expect(report).toMatchObject({
      candidateWorks: 1,
      includedWorks: 1,
      savedMinutes: 80,
    });
    expect(report.samples[0]?.revision.facts.sourceRunIds).toHaveLength(2);
  });
  it('ordinary users cannot read another company or mutate baselines or access cost declarations', async () => {
    await expect(
      listInvestmentEntries(owner, b.context.organizationId, {}, f.db),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      save(owner, a.context.organizationId, baseline(), undefined, 0, false),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      listInvestmentEntries(
        owner,
        a.context.organizationId,
        { kind: 'expense' },
        f.db,
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      readInvestmentReport(owner, a.context.organizationId, range, f.db),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });
  it('rejects cross-company Run/version/baseline sources', async () => {
    const cross = await save(admin, b.context.organizationId, baseline());
    for (const c of [
      work({ sourceRunIds: [b.task.runId] }),
      work({ sourceVersionId: b.artifact.artifactId }),
      work({
        baselineRevisionId: cross.id,
        sourceVersionId: null,
        adoptedAt: null,
      }),
    ])
      await expect(
        save(owner, a.context.organizationId, c, undefined, 0, false),
      ).rejects.toMatchObject({
        code: c.baselineRevisionId
          ? 'baseline_unavailable'
          : 'source_unavailable',
      });
  });
  it('serializes cross-company allocations and prevents exceeding a receipt across frozen versions', async () => {
    const fee = await save(admin, a.context.organizationId, expense());
    const current = (
      await listInvestmentEntries(
        admin,
        a.context.organizationId,
        { administration: true, kind: 'statement' },
        f.db,
      )
    ).entries[0]!;
    const results = await Promise.allSettled([
      save(
        admin,
        a.context.organizationId,
        statement({ subscriptionRevisionIds: [fee.id] }),
        current.entryId,
        current.number,
      ),
      save(
        admin,
        b.context.organizationId,
        statement({ subscriptionRevisionIds: [fee.id] }),
      ),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(
      (await readInvestmentReport(admin, a.context.organizationId, range, f.db))
        .groups[0]?.subscriptionMinor,
    ).toBe(36000);
    const next = await save(
      admin,
      a.context.organizationId,
      {
        ...(fee.content as InvestmentExpense),
        allocations: [
          { organizationId: a.context.organizationId, amountMinor: 60000 },
        ],
      },
      fee.entryId,
      1,
    );
    await expect(
      save(
        admin,
        a.context.organizationId,
        statement({ subscriptionRevisionIds: [next.id] }),
        current.entryId,
        current.number + 1,
      ),
    ).rejects.toMatchObject({ code: 'allocation_exceeded' });
    await expect(
      save(
        admin,
        a.context.organizationId,
        {
          ...(next.content as InvestmentExpense),
          amountMinor: 50000,
          allocations: [],
        },
        fee.entryId,
        2,
      ),
    ).rejects.toMatchObject({ code: 'allocation_exceeded' });
    expect(
      (await readInvestmentReport(admin, a.context.organizationId, range, f.db))
        .groups[0]?.subscriptionMinor,
    ).toBe(36000);
  });
  it('rejects stale expense versions, mismatched periods, currencies and repeated receipt identity', async () => {
    const fee = await save(admin, a.context.organizationId, expense());
    await save(
      admin,
      a.context.organizationId,
      { ...(fee.content as InvestmentExpense), title: '补充凭据' },
      fee.entryId,
      1,
    );
    const same = (
      await listInvestmentEntries(
        admin,
        a.context.organizationId,
        { administration: true, kind: 'statement' },
        f.db,
      )
    ).entries[0]!;
    await expect(
      save(
        admin,
        a.context.organizationId,
        statement({ subscriptionRevisionIds: [fee.id] }),
        same.entryId,
        same.number,
      ),
    ).rejects.toMatchObject({ code: 'expense_revision_changed' });
    await expect(
      save(
        admin,
        a.context.organizationId,
        expense({ receiptKey: (fee.content as InvestmentExpense).receiptKey }),
      ),
    ).rejects.toMatchObject({ code: 'business_work_exists' });
    await expect(
      save(
        admin,
        a.context.organizationId,
        statement({ currency: 'USD', subscriptionRevisionIds: [fee.id] }),
      ),
    ).rejects.toMatchObject({ code: 'expense_revision_changed' });
  });
  it('reports unavailable sources without substituting zero and rechecks current access', async () => {
    await f.db`update allrice_workspaces set archived_at=now() where id=${a.context.workspaceId}`;
    const r = await readInvestmentReport(
      admin,
      a.context.organizationId,
      range,
      f.db,
    );
    expect(r.missing.source_unavailable).toBe(1);
    expect(r.savedMinutes).toBeNull();
    expect(r.groups[0]?.roi).toBeNull();
    await expect(
      listInvestmentEntries(owner, a.context.organizationId, {}, f.db),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await f.db`update allrice_workspaces set archived_at=null where id=${a.context.workspaceId}`;
    await f.db`update allrice_memberships set active=false where user_id=${owner.actor.id}`;
    await expect(
      save(
        owner,
        a.context.organizationId,
        work({ sourceVersionId: null, adoptedAt: null }),
        undefined,
        0,
        false,
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });
});
