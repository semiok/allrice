import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from './employee-administration.fixture.ts';
import { ensureBootstrapPortalPrincipal } from './identity.ts';
import {
  claimNextPlatformEmployeeTestRun,
  completePlatformEmployeeTestRun,
  listPlatformEmployeeWorkspaces,
  queuePlatformEmployeeTestRun,
} from './employees/platform-employees.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('isolated platform draft previews (PostgreSQL; no model)', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  let admin: Awaited<ReturnType<typeof ensureBootstrapPortalPrincipal>>;
  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    admin = await ensureBootstrapPortalPrincipal({
      organizationSlug: 'allrice-platform',
      organizationName: 'Platform',
      workspaceSlug: 'control-plane',
      workspaceName: 'Control plane',
      email: 'preview-admin@example.test',
      displayName: 'Admin',
      role: 'member',
    });
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', admin.user.email);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  });
  const complete = (id: string) =>
    completePlatformEmployeeTestRun(id, {
      answer: 'Synthetic reply',
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      threadId: null,
      usage: null,
      events: [],
      error: null,
    });

  it('defaults to the internal platform and keeps runs, jobs, policies and events out of company data', async () => {
    const f = await createEmployeeAdministrationFixture(fixture.db);
    const companyBefore =
      await fixture.db`select * from allrice_memberships where organization_id=${f.organizationId}`;
    const result = await queuePlatformEmployeeTestRun(
      f.employeeId,
      { prompt: 'Introduce yourself' },
      admin.user.id,
    );
    expect(result.queued).toBe(true);
    expect(result.testRun!.input).toMatchObject({
      environment: 'platform',
      ownerId: admin.user.id,
    });
    const claim = await claimNextPlatformEmployeeTestRun(randomUUID());
    expect(claim?.id).toBe(result.testRun!.id);
    expect(claim?.previewContext).toMatchObject({
      organizationId: admin.organizationId,
      ownerId: admin.user.id,
      workspaceName: '平台测试',
    });
    expect(claim?.previewContext.workspaceId).not.toBe(admin.workspaceId);
    expect(
      (await listPlatformEmployeeWorkspaces()).some(
        (w) => w.id === claim!.previewContext.workspaceId,
      ),
    ).toBe(false);
    for (const table of [
      'allrice_runs',
      'allrice_jobs',
      'allrice_policy_snapshots',
      'allrice_run_events',
    ]) {
      expect(
        await fixture.db`select 1 from ${fixture.db(table)} where organization_id=${f.organizationId}`,
      ).toHaveLength(0);
      expect(
        (
          await fixture.db`select 1 from ${fixture.db(table)} where organization_id=${admin.organizationId}`
        ).length,
      ).toBeGreaterThan(0);
    }
    expect(
      await fixture.db`select * from allrice_memberships where organization_id=${f.organizationId}`,
    ).toEqual(companyBefore);
    expect(
      await fixture.db`select id from allrice_chat_sessions where organization_id=${f.organizationId}`,
    ).toHaveLength(0);
    await complete(result.testRun!.id);
    const second = await queuePlatformEmployeeTestRun(
      f.employeeId,
      { prompt: 'Another preview' },
      admin.user.id,
    );
    expect(second.testRun!.input.workspaceId).toBe(
      result.testRun!.input.workspaceId,
    );
    await claimNextPlatformEmployeeTestRun(randomUUID());
    await complete(second.testRun!.id);
  });

  it('requires an explicit company employee and rejects mismatched or spoofed test scopes', async () => {
    const f = await createEmployeeAdministrationFixture(fixture.db);
    const missing = await queuePlatformEmployeeTestRun(
      f.employeeId,
      { workspaceId: f.workspaceId, prompt: 'Company preview' },
      admin.user.id,
    );
    expect(missing.queued).toBe(false);
    const mismatched = await queuePlatformEmployeeTestRun(
      f.employeeId,
      {
        environment: 'company',
        workspaceId: f.workspaceId,
        ownerId: admin.user.id,
        prompt: 'Wrong employee',
      },
      admin.user.id,
    );
    expect(mismatched.queued).toBe(false);
    const spoofed = await queuePlatformEmployeeTestRun(
      f.employeeId,
      {
        environment: 'platform',
        workspaceId: f.workspaceId,
        ownerId: f.ownerId,
        prompt: 'Not a platform scope',
      },
      admin.user.id,
    );
    expect(spoofed.queued).toBe(false);
    const ordinary = await queuePlatformEmployeeTestRun(
      f.employeeId,
      { prompt: 'No platform authority' },
      f.ownerId,
    );
    expect(ordinary.queued).toBe(false);
    const result = await queuePlatformEmployeeTestRun(
      f.employeeId,
      {
        environment: 'company',
        workspaceId: f.workspaceId,
        ownerId: f.ownerId,
        prompt: 'Explicit company context',
      },
      admin.user.id,
    );
    expect(result.queued).toBe(true);
    const claim = await claimNextPlatformEmployeeTestRun(randomUUID());
    expect(claim?.previewContext).toMatchObject({
      organizationId: f.organizationId,
      workspaceId: f.workspaceId,
      ownerId: f.ownerId,
    });
    await complete(result.testRun!.id);
  });

  it('rechecks selected membership before execution and settles invalid environments without blocking subsequent previews', async () => {
    const f = await createEmployeeAdministrationFixture(fixture.db);
    const result = await queuePlatformEmployeeTestRun(
      f.employeeId,
      {
        environment: 'company',
        workspaceId: f.workspaceId,
        ownerId: f.ownerId,
        prompt: 'Revoked before claim',
      },
      admin.user.id,
    );
    expect(result.queued).toBe(true);
    await fixture.db`update allrice_memberships set active=false where organization_id=${f.organizationId} and user_id=${f.ownerId}`;
    expect(await claimNextPlatformEmployeeTestRun(randomUUID())).toBeNull();
    const [failed] =
      await fixture.db`select status,output from allrice_platform_employee_test_runs where id=${result.testRun!.id}`;
    expect(failed).toMatchObject({
      status: 'failed',
      output: { error: { code: 'TEST_ENVIRONMENT_UNAVAILABLE' } },
    });
    expect(
      await fixture.db`select id from allrice_jobs where organization_id=${f.organizationId}`,
    ).toHaveLength(0);
    const next = await queuePlatformEmployeeTestRun(
      f.employeeId,
      { prompt: 'Platform still available' },
      admin.user.id,
    );
    expect((await claimNextPlatformEmployeeTestRun(randomUUID()))?.id).toBe(
      next.testRun!.id,
    );
    await complete(next.testRun!.id);
  });
});
