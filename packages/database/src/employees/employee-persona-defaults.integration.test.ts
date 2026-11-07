/** Real HTTP/service, authentication and SQL transactions in an isolated DB.
 * Publication preview completion is synthetic; no provider or real Run. */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EmployeeDetailsSchema,
  EmployeeInstanceSchema,
  type EmployeeInstanceProfile,
  type PlatformEmployeeDefinition,
} from '@allrice/contracts';
import * as client from '../core/client.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import { createRunAuthorityFixture } from '../run-authority.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from '../identity.ts';
import { getEmployeeWorkspace } from '../workspace/service.ts';
import { savePlatformEmployeeDraft } from './platform-employees.ts';
import {
  createEmployeeInstance,
  ensureGeneralEmployeeInstance,
  getEmployeeInstance,
} from './employee-instances.ts';
import {
  getEmployeeDetails,
  getOrganizationSharedEmployeeDetails,
} from './employee-content.ts';
import { OrganizationSharedReader } from '../organization-shared-reader.ts';

// Only the Next request cookie transport is supplied by the fixture. The real
// getRequestContext/authenticateSession and SQL authorization remain in use.
const requestCookies = { token: '' };

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'PERSONA current defaults and sparse profile (isolated PostgreSQL, no model)',
  () => {
    let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let nextHeadersModule: string | undefined;
    beforeAll(async () => {
      // Resolve the public entry from its actual Web consumer. This database
      // package does not own the Web package's Next dependency.
      nextHeadersModule = createRequire(
        new URL('../../../../apps/web/package.json', import.meta.url),
      ).resolve('next/headers');
      vi.doMock(nextHeadersModule, () => ({
        cookies: async () => ({
          get: (name: string) =>
            name === 'allrice_session' && requestCookies.token
              ? { value: requestCookies.token }
              : undefined,
        }),
      }));
      fixture = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    }, 120000);
    afterAll(async () => {
      requestCookies.token = '';
      if (nextHeadersModule !== undefined) vi.doUnmock(nextHeadersModule);
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture?.close();
    }, 30000);

    async function login(
      userId: string,
      organizationId: string,
      workspaceId: string,
    ) {
      const session = await createSession(userId);
      const context = await authenticateSession(session.token, {
        organizationId,
        workspaceId,
      });
      if (!context) throw Error('fixture_authentication_failed');
      return { token: session.token, context };
    }
    type Viewer = Awaited<ReturnType<typeof login>>;
    function headers(viewer: Viewer) {
      requestCookies.token = viewer.token;
      return {
        host: 'allrice.test',
        origin: 'https://allrice.test',
        'content-type': 'application/json',
        'x-allrice-organization-id': viewer.context.organizationId,
        'x-allrice-workspace-id': viewer.context.workspaceId!,
      };
    }
    async function detailResponse(
      viewer: Viewer,
      instanceId: string,
      workspaceId = viewer.context.workspaceId!,
    ) {
      const routePath =
        '../../../../apps/web/app/api/v1/employee-instances/[id]/content/route.ts';
      const { GET } = await import(routePath);
      return GET(
        new Request(
          `https://allrice.test/api/v1/employee-instances/${instanceId}/content?workspaceId=${workspaceId}`,
          { headers: headers(viewer) },
        ),
        { params: Promise.resolve({ id: instanceId }) },
      );
    }
    async function details(viewer: Viewer, instanceId: string) {
      const response = await detailResponse(viewer, instanceId);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      return EmployeeDetailsSchema.parse(await response.json());
    }
    async function patch(
      viewer: Viewer,
      instanceId: string,
      value: {
        expectedRevision: number;
        requestId: string;
        profile?: EmployeeInstanceProfile;
        operation?: 'reset_profile';
      },
    ) {
      const routePath =
        '../../../../apps/web/app/api/v1/employee-instances/[id]/route.ts';
      const { PATCH } = await import(routePath);
      return PATCH(
        new Request(
          `https://allrice.test/api/v1/employee-instances/${instanceId}`,
          {
            method: 'PATCH',
            headers: headers(viewer),
            body: JSON.stringify({
              workspaceId: viewer.context.workspaceId,
              ...value,
            }),
          },
        ),
        { params: Promise.resolve({ id: instanceId }) },
      );
    }
    async function saved(response: Response) {
      expect(response.status).toBe(200);
      const body = await response.json();
      return EmployeeInstanceSchema.parse(body.instance);
    }

    async function setup(rice = false) {
      const source = await createEmployeeAdministrationFixture(fixture.db);
      const viewer = await login(
        source.ownerId,
        source.organizationId,
        source.workspaceId,
      );
      vi.stubEnv(
        'ALLRICE_PLATFORM_ADMIN_EMAILS',
        `${source.ownerId}@example.test`,
      );
      const [riceRow] = rice
        ? await fixture.db`select id from allrice_platform_employees where employee_key='rice'`
        : [];
      const platformId = rice ? (riceRow!.id as string) : source.employeeId;
      const definition: PlatformEmployeeDefinition = {
        ...source.definition,
        key: rice ? 'rice' : source.definition.key,
        name: '平台人设一',
        appearance: {
          avatarType: 'emoji',
          avatarValue: '🍚',
          accentColor: 'green',
        },
        identity: {
          ...source.definition.identity,
          mission: '平台职责一',
          workStyle: '平台方式一',
          expressionStyle: 'structured',
        },
      };
      await savePlatformEmployeeDraft(platformId, {
        definition,
        ...(!rice ? { expectedRevisionId: source.revisionId } : {}),
      });
      await source.preview(platformId);
      expect((await source.publish(platformId)).valid).toBe(true);
      const assignment = (
        await getEmployeeWorkspace(viewer.context, source.workspaceId)
      ).employees.find(
        (employee) =>
          employee.employeeKey ===
          (rice ? 'default-assistant' : definition.key),
      );
      if (!assignment) throw Error('fixture_assignment_missing');
      await ensureGeneralEmployeeInstance(fixture.db, assignment.id);
      async function publish(
        next: PlatformEmployeeDefinition,
        workspaceIds = [source.workspaceId],
      ) {
        await savePlatformEmployeeDraft(platformId, { definition: next });
        await source.preview(platformId);
        const { publishPlatformEmployee } =
          await import('./platform-employees.ts');
        expect(
          (await publishPlatformEmployee(platformId, { workspaceIds })).valid,
        ).toBe(true);
      }
      async function custom(profile: EmployeeInstanceProfile = {}) {
        return createEmployeeInstance(viewer.context, {
          workspaceId: source.workspaceId,
          assignmentId: assignment!.id,
          requestId: randomUUID(),
          profile,
        });
      }
      return {
        source,
        viewer,
        assignment,
        definition,
        platformId,
        publish,
        custom,
      };
    }

    async function storedProfile(instanceId: string) {
      const [row] =
        await fixture.db`select profile,revision from allrice_employee_instances where id=${instanceId}`;
      return row!;
    }

    it('saves only explicit owner changes, follows the current approved default and keeps same-value expression ownership', async () => {
      const f = await setup();
      const instance = await f.custom();
      const first = await details(f.viewer, instance.id);
      expect(first.profile).toMatchObject({
        expressionStyle: 'structured',
        defaults: { mission: '平台职责一', expressionStyle: 'structured' },
        overrides: {},
        defaultSource: { kind: 'platform' },
      });
      const before = await storedProfile(instance.id);
      await details(f.viewer, instance.id);
      expect(await storedProfile(instance.id)).toEqual(before);
      // User explicitly chose structured even though it currently equals default.
      const response = await saved(
        await patch(f.viewer, instance.id, {
          expectedRevision: 1,
          requestId: randomUUID(),
          profile: {
            name: '禾',
            expressionStyle: 'structured',
            appearance: { accentColor: 'blue' },
          },
        }),
      );
      expect(response.profile).toEqual({
        name: '禾',
        expressionStyle: 'structured',
        appearance: { accentColor: 'blue' },
      });
      expect((await storedProfile(instance.id)).profile).toEqual(
        response.profile,
      );
      const next: PlatformEmployeeDefinition = {
        ...f.definition,
        name: '平台人设二',
        appearance: {
          avatarType: 'emoji',
          avatarValue: '🌾',
          accentColor: 'coral',
        },
        identity: {
          ...f.definition.identity,
          mission: '平台职责二',
          workStyle: '平台方式二',
          expressionStyle: 'concise',
        },
      };
      await savePlatformEmployeeDraft(f.platformId, { definition: next });
      const draftOnly = await details(f.viewer, instance.id);
      expect(draftOnly.profile.defaultSource).toEqual(
        first.profile.defaultSource,
      );
      expect(draftOnly.profile.defaults?.mission).toBe('平台职责一');
      // Publish into another workspace; the current owner is not implicitly deployed.
      const other = await createEmployeeAdministrationFixture(fixture.db);
      await f.publish(next, [other.workspaceId]);
      expect(
        (await details(f.viewer, instance.id)).profile.defaultSource,
      ).toEqual(first.profile.defaultSource);
      await f.publish(next);
      const current = await details(f.viewer, instance.id);
      expect(current.profile).toMatchObject({
        name: '禾',
        expressionStyle: 'structured',
        identity: { mission: '平台职责二', workStyle: '平台方式二' },
        appearance: {
          avatarType: 'emoji',
          avatarValue: '🌾',
          accentColor: 'blue',
        },
        defaults: {
          name: '平台人设二',
          expressionStyle: 'concise',
          appearance: { accentColor: 'coral' },
        },
        overrides: response.profile,
      });
      expect(current.profile.defaultSource).not.toEqual(
        first.profile.defaultSource,
      );
      expect(current.profile.source).toEqual(current.profile.defaultSource);
      expect(
        (await getEmployeeInstance(f.viewer.context, instance.id))
          .creationSource,
      ).toEqual(instance.creationSource);
      expect((await storedProfile(instance.id)).profile).toEqual(
        response.profile,
      );
    });

    it('merges only Rice appearance leaves, preserves receipts and resets the entire profile through the original operation', async () => {
      const f = await setup(true),
        id = f.assignment.id;
      const first = await saved(
        await patch(f.viewer, id, {
          expectedRevision: 1,
          requestId: randomUUID(),
          profile: {
            name: '本人 Rice',
            appearance: {
              avatarType: 'image',
              avatarValue: 'https://example.test/me.png',
              accentColor: 'blue',
            },
          },
        }),
      );
      const requestId = randomUUID();
      const change = {
        expectedRevision: first.revision,
        requestId,
        profile: { appearance: { accentColor: 'coral' as const } },
      };
      const colored = await saved(await patch(f.viewer, id, change));
      expect(colored.profile).toEqual({
        name: '本人 Rice',
        appearance: {
          avatarType: 'image',
          avatarValue: 'https://example.test/me.png',
          accentColor: 'coral',
        },
      });
      expect(await saved(await patch(f.viewer, id, change))).toEqual(colored);
      expect(
        (
          await patch(f.viewer, id, {
            ...change,
            profile: { appearance: { accentColor: 'green' } },
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await patch(f.viewer, id, {
            expectedRevision: 1,
            requestId: randomUUID(),
            profile: { name: 'stale' },
          })
        ).status,
      ).toBe(409);
      const resetRequest = {
        expectedRevision: colored.revision,
        requestId: randomUUID(),
        operation: 'reset_profile' as const,
      };
      const reset = await saved(await patch(f.viewer, id, resetRequest));
      expect(reset.profile).toEqual({});
      expect((await details(f.viewer, id)).profile).toMatchObject({
        name: f.definition.name,
        appearance: f.definition.appearance,
        expressionStyle: 'structured',
        overrides: {},
      });
      const next = { ...f.definition, name: '后来平台人设' };
      await f.publish(next);
      expect(await saved(await patch(f.viewer, id, resetRequest))).toEqual(
        reset,
      );
      expect((await details(f.viewer, id)).profile.name).toBe(next.name);
    });

    it('keeps custom replacement, real owner authorization and shared privacy instead of granting permissions from a name or source DTO', async () => {
      const f = await setup();
      const custom = await f.custom({
        name: 'Rice',
        mission: '本人职责',
        appearance: { accentColor: 'blue' },
      });
      const replacement = await saved(
        await patch(f.viewer, custom.id, {
          expectedRevision: 1,
          requestId: randomUUID(),
          profile: { expressionStyle: 'exploratory' },
        }),
      );
      expect(replacement.profile).toEqual({ expressionStyle: 'exploratory' });
      const shown = await details(f.viewer, custom.id);
      expect(shown.profile).toMatchObject({
        name: f.definition.name,
        identity: { mission: f.definition.identity.mission },
        expressionStyle: 'exploratory',
        overrides: replacement.profile,
      });
      expect(
        (
          await patch(f.viewer, custom.id, {
            expectedRevision: 2,
            requestId: randomUUID(),
            operation: 'reset_profile',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await patch(f.viewer, f.assignment.id, {
            expectedRevision: 1,
            requestId: randomUUID(),
            profile: { name: 'Rice' },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await patch(f.viewer, f.assignment.id, {
            expectedRevision: 1,
            requestId: randomUUID(),
            operation: 'reset_profile',
          })
        ).status,
      ).toBe(403);

      const peer = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: f.source.definition.key,
          organizationName: 'Synthetic publication',
          workspaceSlug: 'default',
          workspaceName: 'Synthetic publication',
          email: `${randomUUID()}@example.test`,
          displayName: 'Other owner',
          role: 'member',
        },
        fixture.db,
      );
      const peerViewer = await login(
        peer.user.id,
        peer.organizationId,
        peer.workspaceId,
      );
      expect((await detailResponse(peerViewer, custom.id)).status).not.toBe(
        200,
      );
      expect(
        (
          await patch(peerViewer, custom.id, {
            expectedRevision: 2,
            requestId: randomUUID(),
            profile: { name: 'foreign' },
          })
        ).status,
      ).not.toBe(200);
      expect((await storedProfile(custom.id)).profile).toEqual(
        replacement.profile,
      );
      expect(
        (
          await detailResponse(
            { ...f.viewer, token: 'synthetic-invalid-session' },
            custom.id,
          )
        ).status,
      ).toBe(401);

      const shared = await fixture.db.begin(async (tx) => {
        const reader = await OrganizationSharedReader.authorize(
          f.viewer.context,
          {
            organizationId: f.source.organizationId,
            workspaceId: f.source.workspaceId,
            departmentId: null,
          },
          tx,
        );
        return getOrganizationSharedEmployeeDetails(
          reader,
          replacement,
          f.assignment.employeeId,
          tx,
        );
      });
      expect(shared.profile).toMatchObject({
        name: f.definition.name,
        overrides: {},
        personalFields: [],
        canMaintainPersonal: false,
        editableFields: [],
      });
      expect(shared.profile.expressionStyle).toBeUndefined();
      expect(shared.profile.defaults?.expressionStyle).toBe('structured');
    });

    async function tenantFixture() {
      const f = await createRunAuthorityFixture(fixture.db, {
        configure: false,
      });
      const viewer = await login(f.user, f.org, f.workspace);
      await ensureGeneralEmployeeInstance(fixture.db, f.assignment);
      const custom = await createEmployeeInstance(viewer.context, {
        workspaceId: f.workspace,
        assignmentId: f.assignment,
        requestId: randomUUID(),
        profile: { name: '租户本人' },
      });
      return { f, viewer, custom };
    }

    it('keeps readable tenant_version details and raw overrides without inventing platform provenance', async () => {
      const { f, viewer, custom } = await tenantFixture();
      const actual = await details(viewer, custom.id);
      expect(actual.profile).toMatchObject({
        name: '租户本人',
        defaults: { name: f.manifest.name },
        overrides: { name: '租户本人' },
        defaultSource: { kind: 'tenant_version', employeeVersionId: f.version },
      });
      expect(actual.profile.source.kind).toBe('tenant_version');

      // INSERT a historical declaration with no explicit partnerProfile. Never
      // rewrite an old version/Run to manufacture the missing-source scenario.
      const { partnerProfile, ...withoutPartner } = f.manifest;
      void partnerProfile;
      const version = randomUUID();
      await fixture.db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
      select ${version},organization_id,workspace_id,employee_id,version+1,name,model,system_prompt,capabilities,config_checksum,${fixture.db.json(withoutPartner)},provider_snapshot from allrice_employee_versions where id=${f.version}`;
      await fixture.db`update allrice_employee_assignments set employee_version_id=${version} where id=${f.assignment}`;
      const unknownExpression = await details(viewer, custom.id);
      expect(unknownExpression.profile).not.toHaveProperty('expressionStyle');
      expect(unknownExpression.profile.defaults).not.toHaveProperty(
        'expressionStyle',
      );
      expect(unknownExpression.profile.defaultSource).toEqual({
        kind: 'tenant_version',
        employeeVersionId: version,
      });
      const updated = await saved(
        await patch(viewer, custom.id, {
          expectedRevision: 1,
          requestId: randomUUID(),
          profile: { name: '仍可编辑' },
        }),
      );
      expect(updated.profile).toEqual({ name: '仍可编辑' });
    });

    it('does not relabel an unverified platform checksum as tenant provenance or revoke an otherwise readable tenant detail', async () => {
      const { f, viewer, custom } = await tenantFixture();
      const source = await createEmployeeAdministrationFixture(fixture.db);
      const revision = randomUUID(),
        checksum = `sha256:${'0'.repeat(64)}`;
      // New deliberately inconsistent published fixture, not a mutation of any
      // historical publication. Existing platformContent accepts its structure;
      // the new defaults verifier must not call its checksum verified.
      await fixture.db`insert into allrice_platform_employee_revisions(id,employee_id,revision,status,definition,checksum)
      values(${revision},${source.employeeId},2,'published',${fixture.db.json(source.definition)},${checksum})`;
      await fixture.db`insert into allrice_employee_version_sources(employee_version_id,organization_id,workspace_id,employee_id,platform_employee_id,platform_revision_id)
      values(${f.version},${f.org},${f.workspace},${f.employee},${source.employeeId},${revision})`;
      const actual = await details(viewer, custom.id);
      expect(actual.profile.source).toMatchObject({
        kind: 'platform',
        templateChecksum: checksum,
      });
      expect(actual.profile).not.toHaveProperty('defaultSource');
      expect(actual.profile).toMatchObject({
        name: '租户本人',
        defaults: { name: f.manifest.name },
        overrides: { name: '租户本人' },
      });
      expect(
        (await getEmployeeDetails(viewer.context, custom.id)).profile.source,
      ).toEqual(actual.profile.source);
    });
  },
);
