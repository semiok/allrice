import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DSH_INSTALLED_DISTRIBUTION } from '@allrice/contracts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from './identity.ts';
import {
  compilePlatformEmployee,
  getPlatformEmployee,
  listPlatformEmployees,
  materializePlatformEmployeeRevision,
  publishPlatformEmployee,
  savePlatformEmployeeDraft,
} from './employees/platform-employees.ts';
import { reviewEmployeePublication } from './employee-administration.ts';
import {
  changeAdminTenantEmployee,
  listAdminTenantEmployees,
} from './tenant-employees.ts';
import { listOrganizationAiAssignments } from './organization-employee-assignments.ts';
import { readPlatformEmployeeHistoryRevision } from './platform-employee-history.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite('unmodified Rice seed in a freshly migrated database', () => {
  let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    f = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    vi.stubEnv('ALLRICE_ENV', 'development');
  }, 60_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await f?.close();
  });

  it('lists Rice, reads its unavailable first revision, publishes a new revision and assigns it in qa-bootstrap order', async () => {
    const principal = await ensureBootstrapPortalPrincipal(
      {
        organizationSlug: `seed-${randomUUID()}`,
        organizationName: 'Seed regression',
        workspaceSlug: 'default',
        workspaceName: 'Seed regression',
        email: `seed-${randomUUID()}@example.test`,
        displayName: 'Seed admin',
        role: 'admin',
      },
      f.db,
    );
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', principal.user.email);
    const context = (await authenticateSession(
      (await createSession(principal.user.id)).token,
      {
        organizationId: principal.organizationId,
        workspaceId: principal.workspaceId,
      },
    ))!;
    const [seed] =
      await f.db`select r.* from allrice_platform_employee_revisions r
      join allrice_platform_employees e on e.current_published_revision_id=r.id where e.employee_key='rice'`;
    expect(seed!.revision).toBe(1);
    expect(seed!.runtime_profile).not.toHaveProperty('distributionGeneration');

    // The same entrypoints used by the bootstrap and admin APIs, with no seed repair.
    const rice = (await listPlatformEmployees()).find(
      (e) => e.employeeKey === 'rice',
    )!;
    expect(rice.currentPublished).toMatchObject({
      id: seed!.id,
      revision: 1,
      runtimeProfile: null,
    });
    const detail = (await getPlatformEmployee(rice.id))!;
    expect(detail.currentPublished).toEqual(rice.currentPublished);
    const history = await readPlatformEmployeeHistoryRevision(
      context,
      rice.id,
      seed!.id,
    );
    expect(history).toMatchObject({
      checksum: seed!.checksum,
      runtimeProfile: null,
    });
    const list = () =>
      listAdminTenantEmployees(
        context,
        principal.organizationId,
        principal.workspaceId,
      );
    expect(
      (await list()).employees.find((e) => e.employeeId === rice.id),
    ).toMatchObject({
      revision: 1,
      canAssign: false,
      toolNames: [],
      skills: [],
      deployment: null,
    });
    expect(
      (
        await listOrganizationAiAssignments(
          context,
          principal.organizationId,
          principal.workspaceId,
        )
      ).employees.find((e) => e.employeeId === rice.id),
    ).toMatchObject({ canAssign: false });
    await expect(
      f.db.begin((tx) =>
        materializePlatformEmployeeRevision(tx, {
          employeeId: rice.id,
          revision: seed as Parameters<
            typeof materializePlatformEmployeeRevision
          >[1]['revision'],
          definition: detail.currentPublished!.definition,
          workspaceIds: [principal.workspaceId],
          actorLabel: principal.user.id,
        }),
      ),
    ).rejects.toMatchObject({
      name: 'ZodError',
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ['distributionGeneration'] }),
      ]),
    });

    const definition = {
      ...detail.currentPublished!.definition,
      capabilities: {
        ...detail.currentPublished!.definition.capabilities,
        nativeSkillIds: [],
        toolNames: [],
        explicitToolNames: [],
      },
    };
    const saved = await savePlatformEmployeeDraft(rice.id, {
      definition,
      expectedRevisionId: detail.currentDraft?.id ?? null,
    });
    // The HTTP PUT route compiles after saving, as does the review/publication path.
    expect((await compilePlatformEmployee(rice.id)).errors).toEqual([]);
    const review = await reviewEmployeePublication(context, rice.id);
    expect(review.errors).toEqual([]);
    const published = await publishPlatformEmployee(
      rice.id,
      {
        scope: 'assigned',
        expectedRevisionId: review.revisionId,
        expectedPublishedRevisionId: review.publishedRevisionId,
        expectedPackageChecksum: review.packageChecksum,
        policyVersions: review.policyVersions,
      },
      principal.user.id,
      context,
    );
    expect(published.errors).toEqual([]);
    expect(published.revisionId).toBe(saved!.currentDraft!.id);
    expect(published.runtimeProfile?.distributionGeneration).toBe(
      DSH_INSTALLED_DISTRIBUTION.generation,
    );
    expect(
      await changeAdminTenantEmployee(context, principal.organizationId, {
        workspaceId: principal.workspaceId,
        employeeId: rice.id,
        revisionId: published.revisionId,
        action: 'assign',
        expectedVersion: null,
      }),
    ).toEqual({ changed: true });
    expect(
      (await list()).employees.find((e) => e.employeeId === rice.id),
    ).toMatchObject({
      canAssign: true,
      deployment: { active: true, revisionId: published.revisionId },
    });
    expect(
      (
        await f.db`select * from allrice_platform_employee_revisions where id=${seed!.id}`
      )[0],
    ).toEqual(seed);
    expect(
      (await readPlatformEmployeeHistoryRevision(context, rice.id, seed!.id))
        .runtimeProfile,
    ).toBeNull();
  });
});
