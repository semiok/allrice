import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from './core/client.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import {
  authenticateSession,
  changePassword,
  ensureBootstrapPortalPrincipal,
  getLegacyPortalAccount,
  initializeAccountLogin,
  login,
} from './identity.ts';
import { isPlatformAdmin } from './platform-authority.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration('MET-161 unified account login (isolated PostgreSQL)', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  beforeAll(async () => {
    fixture = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (fixture) await fixture.close();
  });

  async function account() {
    const username = `employee-${randomUUID()}`;
    const input = {
      organizationSlug: username,
      organizationName: 'Company',
      workspaceSlug: 'default',
      workspaceName: 'Default',
      email: `${username}@example.test`,
      displayName: '员工',
      role: 'member' as const,
    };
    const principal = await ensureBootstrapPortalPrincipal(input);
    await initializeAccountLogin({
      userId: principal.user.id,
      username,
      password: 'admin@321',
    });
    return { ...principal, username, input };
  }

  it('bootstraps a first login in one transaction and never changes an existing account', async () => {
    const name = `first-${randomUUID()}`;
    const input = {
      organizationSlug: name,
      organizationName: 'First company',
      workspaceSlug: 'default',
      workspaceName: 'Default',
      email: `${name}@example.test`,
      displayName: 'Administrator',
      role: 'member' as const,
    };
    const first = await ensureBootstrapPortalPrincipal({
      ...input,
      login: { username: name, password: 'first-password' },
    });
    expect(first.created).toBe(true);
    expect(
      (await login({ username: name, password: 'first-password' })).user.id,
    ).toBe(first.user.id);
    const again = await ensureBootstrapPortalPrincipal({
      ...input,
      login: { username: `${name}-other`, password: 'second-password' },
    });
    expect(again).toMatchObject({
      created: false,
      user: { id: first.user.id },
    });
    await expect(
      login({ email: input.email, password: 'second-password' }),
    ).rejects.toMatchObject({ code: 'authentication_failed' });
    expect(
      (await login({ email: input.email, password: 'first-password' })).user
        .username,
    ).toBe(name);

    // A taken username rolls back the company, workspace and account together.
    const clash = `clash-${randomUUID()}`;
    await expect(
      ensureBootstrapPortalPrincipal({
        ...input,
        organizationSlug: clash,
        email: `${clash}@example.test`,
        login: { username: name, password: 'clash-password' },
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(
      await fixture.db`select id from allrice_organizations where slug=${clash}`,
    ).toHaveLength(0);
    expect(
      await fixture.db`select id from allrice_users where email=${`${clash}@example.test`}`,
    ).toHaveLength(0);
    await expect(
      ensureBootstrapPortalPrincipal({
        ...input,
        organizationSlug: `${clash}-short`,
        email: `${clash}-short@example.test`,
        login: { username: `${clash}-short`, password: 'short' },
      }),
    ).rejects.toThrow();
    expect(
      await fixture.db`select id from allrice_organizations where slug=${`${clash}-short`}`,
    ).toHaveLength(0);
  });

  it('logs two employees into their own companies on the same entry; tenant admin is not platform admin', async () => {
    const a = await account(),
      b = await account();
    const signed = await login({
      username: ` ${a.username.toUpperCase()} `,
      password: 'admin@321',
    });
    const context = await authenticateSession(signed.session.token);
    expect(context).toMatchObject({
      actor: { id: a.user.id },
      organizationId: a.organizationId,
    });
    await expect(
      authenticateSession(signed.session.token, {
        organizationId: b.organizationId,
      }),
    ).rejects.toMatchObject({ code: 'tenant_context_invalid' });
    await expect(
      authenticateSession(signed.session.token, { workspaceId: b.workspaceId }),
    ).rejects.toMatchObject({ code: 'tenant_context_invalid' });
    await expect(
      login({ username: a.username, password: 'admin@321' }, b.input.email),
    ).rejects.toMatchObject({ code: 'authentication_failed' });
    await fixture.db`update allrice_memberships set role='admin' where user_id=${a.user.id}`;
    expect(await isPlatformAdmin(context!)).toBe(false);
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', a.user.email);
    expect(await isPlatformAdmin(context!)).toBe(true);
  });

  it('changes password, revokes every old session, and a repeated bootstrap cannot overwrite it', async () => {
    const a = await account();
    const first = await login({ username: a.username, password: 'admin@321' });
    const second = await login({ email: a.user.email, password: 'admin@321' });
    const context = (await authenticateSession(first.session.token))!;
    await expect(
      changePassword(context, {
        currentPassword: 'wrongpass',
        newPassword: 'changed-password',
      }),
    ).rejects.toMatchObject({ code: 'authentication_failed' });
    expect(await authenticateSession(second.session.token)).not.toBeNull();
    await changePassword(context, {
      currentPassword: 'admin@321',
      newPassword: 'changed-password',
    });
    expect(await authenticateSession(first.session.token)).toBeNull();
    expect(await authenticateSession(second.session.token)).toBeNull();
    await ensureBootstrapPortalPrincipal(a.input);
    expect(
      await initializeAccountLogin({
        userId: a.user.id,
        username: a.username,
        password: 'admin@321',
      }),
    ).toEqual({ username: a.username, initialized: false });
    await expect(
      login({ username: a.username, password: 'admin@321' }),
    ).rejects.toMatchObject({ code: 'authentication_failed' });
    expect(
      (await login({ username: a.username, password: 'changed-password' })).user
        .id,
    ).toBe(a.user.id);
    expect(await getLegacyPortalAccount(a.input)).toMatchObject({
      id: a.user.id,
      username: a.username,
    });
    await expect(
      changePassword(context, {
        currentPassword: 'changed-password',
        newPassword: 'stale-session',
      }),
    ).rejects.toMatchObject({ code: 'authentication_failed' });
  });

  it('serializes concurrent old-password login with password changes', async () => {
    const a = await account();
    const first = await login({ username: a.username, password: 'admin@321' });
    const context = (await authenticateSession(first.session.token))!;
    const [changed, racing] = await Promise.allSettled([
      changePassword(context, {
        currentPassword: 'admin@321',
        newPassword: 'changed-password',
      }),
      login({ username: a.username, password: 'admin@321' }),
    ]);
    expect(changed.status).toBe('fulfilled');
    if (racing.status === 'fulfilled')
      expect(await authenticateSession(racing.value.session.token)).toBeNull();
    else expect(racing.reason).toMatchObject({ code: 'authentication_failed' });
    expect(
      await fixture.db`select id from allrice_sessions where user_id=${a.user.id} and revoked_at is null`,
    ).toHaveLength(0);
  });

  it('keeps usernames unique, retains display identity, and blocks disabled/removed/archived accounts', async () => {
    const a = await account(),
      b = await account();
    await expect(
      fixture.db`update allrice_users set username=${a.username} where id=${b.user.id}`,
    ).rejects.toMatchObject({ code: '23505' });
    const session = (
      await login({ username: a.username, password: 'admin@321' })
    ).session;
    await fixture.db`update allrice_users set display_name='新的名字' where id=${a.user.id}`;
    expect(
      (await login({ username: a.username, password: 'admin@321' })).user,
    ).toMatchObject({ id: a.user.id, displayName: '新的名字' });
    await fixture.db`update allrice_users set status='disabled' where id=${a.user.id}`;
    expect(await authenticateSession(session.token)).toBeNull();
    await expect(
      login({ username: a.username, password: 'admin@321' }),
    ).rejects.toMatchObject({ code: 'authentication_failed' });
    await fixture.db`update allrice_users set status='active' where id=${a.user.id}`;
    await fixture.db`update allrice_memberships set active=false where user_id=${a.user.id}`;
    await expect(
      login({ username: a.username, password: 'admin@321' }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(ensureBootstrapPortalPrincipal(a.input)).rejects.toMatchObject(
      { code: 'authorization_denied' },
    );
    await fixture.db`update allrice_organizations set archived_at=now() where id=${b.organizationId}`;
    await expect(
      login({ username: b.username, password: 'admin@321' }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });
});
