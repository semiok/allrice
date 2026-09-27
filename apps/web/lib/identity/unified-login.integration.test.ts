import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as client from '../../../../packages/database/src/core/client.ts';
import { createAssistantFixtureDatabase } from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  initializeAccountLogin,
  login,
} from '@allrice/database';
import { POST as signIn } from '../../app/api/v1/auth/login/route';
import { POST as password } from '../../app/api/v1/auth/password/route';
import { getRequestContext } from './session';
import { resolvePortal } from '../portal/config';

const jar = vi.hoisted(() => new Map<string, { value: string }>());
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (key: string) => jar.get(key),
    set: (key: string, value: string) => jar.set(key, { value }),
  }),
}));
const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

integration('shared portal HTTP identity with real PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    vi.stubEnv('ALLRICE_PORTAL_AUTH_ENABLED', '1');
    vi.stubEnv(
      'ALLRICE_PORTAL_SESSION_SECRET',
      'synthetic-session-secret-with-more-than-thirty-two-characters',
    );
  }, 120000);
  beforeEach(() => jar.clear());
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (fixture) await fixture.close();
  });
  function request(path: string, body?: unknown, host = 'allrice.bplabs.xyz') {
    return new Request(`https://${host}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { host, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  async function employee() {
    const name = `employee-${randomUUID()}`;
    const p = await ensureBootstrapPortalPrincipal({
      organizationSlug: name,
      organizationName: name,
      workspaceSlug: 'default',
      workspaceName: 'Default',
      email: `${name}@example.test`,
      displayName: name,
      role: 'member',
    });
    await initializeAccountLogin({
      userId: p.user.id,
      username: name,
      password: 'admin@321',
    });
    return { ...p, name };
  }
  it('separates employee and admin login, rejects mismatched accounts without issuing a session, and rejects old admin cookies on the employee entry', async () => {
    const a = await employee();
    const response = await signIn(
      request('/api/v1/auth/login', {
        username: a.name,
        password: 'admin@321',
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      homePath: '/chatflow',
      user: { id: a.user.id },
    });
    expect(jar.has('allrice_portal_session')).toBe(false);
    expect(
      await getRequestContext(request('/api/v1/auth/session')),
    ).toMatchObject({ organizationId: a.organizationId });
    const employeeSession = jar.get('allrice_session')!;
    const adminHost = 'allrice-admin.bplabs.xyz';
    const portal = resolvePortal(adminHost)!;
    const adminPrincipal = await ensureBootstrapPortalPrincipal(
      portal.principal,
    );
    await initializeAccountLogin({
      userId: adminPrincipal.user.id,
      username: portal.username,
      password: 'admin-secret-password',
    });
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', portal.principal.email);
    jar.clear();
    const count = async () =>
      (await fixture.db`select count(*)::int as n from allrice_sessions`)[0]!.n;
    const before = await count();
    const wrongEntry = await signIn(
      request('/api/v1/auth/login', {
        username: portal.username,
        password: 'admin-secret-password',
      }),
    );
    expect(wrongEntry.status).toBe(403);
    expect(await count()).toBe(before);
    expect(jar.has('allrice_session')).toBe(false);
    const admin = await signIn(
      request(
        '/api/v1/auth/login',
        { username: portal.username, password: 'admin-secret-password' },
        adminHost,
      ),
    );
    expect(admin.status).toBe(200);
    expect(await admin.json()).toMatchObject({
      homePath: '/runtime-console',
      user: { id: adminPrincipal.user.id },
    });
    expect(
      await getRequestContext(
        request('/api/v1/auth/session', undefined, adminHost),
      ),
    ).toMatchObject({ actor: { id: adminPrincipal.user.id } });
    expect(await getRequestContext(request('/api/v1/auth/session'))).toBeNull();
    const adminPortalCookie = jar.get('allrice_portal_session')!;
    jar.clear();
    const beforeEmployeeAttempt = await count();
    const employeeOnAdmin = await signIn(
      request(
        '/api/v1/auth/login',
        { username: a.name, password: 'admin@321' },
        adminHost,
      ),
    );
    expect(employeeOnAdmin.status).toBe(401);
    expect(await count()).toBe(beforeEmployeeAttempt);
    expect(jar.has('allrice_session')).toBe(false);
    jar.set('allrice_session', employeeSession);
    jar.set('allrice_portal_session', adminPortalCookie);
    await expect(
      getRequestContext(request('/api/v1/auth/session', undefined, adminHost)),
    ).rejects.toMatchObject({ code: 'tenant_context_invalid' });
    expect(
      await getRequestContext(request('/api/v1/auth/session')),
    ).toMatchObject({ actor: { id: a.user.id } });
  });
  it('password changes clear browser cookies; legacy environment credentials cannot undo the change', async () => {
    const host = 'allrice-snow.bplabs.xyz';
    const portal = resolvePortal(host)!;
    vi.stubEnv('ALLRICE_SNOW_PASSWORD', 'bootstrap-old-password');
    const first = await signIn(
      request(
        '/api/v1/auth/login',
        { username: portal.username, password: 'bootstrap-old-password' },
        host,
      ),
    );
    expect(first.status).toBe(200);
    const result = await first.json();
    const signedPortal = jar.get('allrice_portal_session')!;
    const changed = await password(
      request(
        '/api/v1/auth/password',
        {
          currentPassword: 'bootstrap-old-password',
          newPassword: 'changed-password',
        },
        host,
      ),
    );
    expect(changed.status).toBe(204);
    expect(jar.get('allrice_session')?.value).toBe('');
    expect(jar.get('allrice_portal_session')?.value).toBe('');
    const old = await signIn(
      request(
        '/api/v1/auth/login',
        { username: portal.username, password: 'bootstrap-old-password' },
        host,
      ),
    );
    expect(old.status).toBe(401);
    const updated = await signIn(
      request(
        '/api/v1/auth/login',
        { username: portal.username, password: 'changed-password' },
        host,
      ),
    );
    expect(updated.status).toBe(200);
    expect((await updated.json()).user.id).toBe(result.user.id);
    // A legacy portal signature must match the DB token's subject, even when
    // another valid user belongs to the same company.
    const other = await employee();
    const context = (await getRequestContext(
      request('/api/v1/auth/session', undefined, host),
    ))!;
    await fixture.db`insert into allrice_memberships(organization_id,user_id,role,active)
      values(${context.organizationId},${other.user.id},'member',true)`;
    const session = await login({
      username: other.name,
      password: 'admin@321',
    });
    jar.set('allrice_session', { value: session.session.token });
    jar.set('allrice_portal_session', signedPortal);
    expect(
      await getRequestContext(request('/api/v1/auth/session', undefined, host)),
    ).toBeNull();
  });
  it('rejects unauthenticated password changes', async () => {
    expect(
      (
        await password(
          request('/api/v1/auth/password', {
            currentPassword: 'admin@321',
            newPassword: 'changed-password',
          }),
        )
      ).status,
    ).toBe(401);
  });
});
