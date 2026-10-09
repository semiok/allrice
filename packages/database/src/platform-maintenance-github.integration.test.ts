import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  authenticateSession,
  createSession,
} from './identity.ts';
import {
  getMaintenanceGithubBot,
  updateMaintenanceGithubBot,
  readMaintenanceGithubBot,
} from './platform-maintenance-github.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('central GitHub robot credential and immutable account identity', () => {
  let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
    admin: RequestContext,
    other: RequestContext,
    ordinary: RequestContext;
  const token = 'github_pat_' + 'SyntheticOnly'.repeat(7),
    key = 'b'.repeat(64);
  const fetcher = vi.fn(async (url: string | URL | Request) =>
    Response.json(
      String(url).endsWith('/user')
        ? { id: 901, login: 'rice-maintenance' }
        : {
            id: 1323769790,
            full_name: 'semiok/allrice',
            permissions: { push: true },
          },
    ),
  ) as unknown as typeof fetch;
  beforeAll(async () => {
    f = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    async function p(email: string) {
      const a = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'allrice-platform',
        organizationName: 'Internal',
        workspaceSlug: 'control-plane',
        workspaceName: 'Internal',
        email,
        displayName: 'Synthetic only',
        role: 'member',
      });
      return (await authenticateSession(
        (await createSession(a.user.id)).token,
      ))!;
    }
    admin = await p('bot-admin@example.test');
    other = await p('bot-other@example.test');
    ordinary = await p('bot-ordinary@example.test');
    vi.stubEnv(
      'ALLRICE_PLATFORM_ADMIN_EMAILS',
      'bot-admin@example.test,bot-other@example.test',
    );
    vi.stubEnv('ALLRICE_MCP_CREDENTIAL_KEY', key);
    vi.stubEnv('ALLRICE_MAINTENANCE_CENTRAL_ENABLED', '1');
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (f) await f.close();
  });
  it('verifies fixed repository and account before saving; facts are shared but no credential leaves the server', async () => {
    expect((await getMaintenanceGithubBot(admin)).state).toBe('not_configured');
    await expect(
      updateMaintenanceGithubBot(
        admin,
        {
          action: 'replace',
          requestId: randomUUID(),
          expectedRevision: 0,
          expectedLogin: 'wrong-bot',
          token,
        },
        { fetcher },
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect((await getMaintenanceGithubBot(admin)).revision).toBe(0);
    const request = {
      action: 'replace',
      requestId: randomUUID(),
      expectedRevision: 0,
      expectedLogin: 'rice-maintenance',
      token,
    };
    const result = await updateMaintenanceGithubBot(admin, request, {
      fetcher,
    });
    expect(result).toMatchObject({
      revision: 1,
      state: 'configured',
      identity: { revision: 1, userId: 901, login: 'rice-maintenance' },
      lastWriteRequestId: request.requestId,
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(await getMaintenanceGithubBot(other)).toEqual(result);
    const calls = vi.mocked(fetcher).mock.calls.length;
    expect(
      await updateMaintenanceGithubBot(admin, request, { fetcher }),
    ).toEqual(result);
    expect(vi.mocked(fetcher).mock.calls.length).toBe(calls);
    const [r] =
      await f.db`select value from allrice_runtime_metadata where key='platform-maintenance-github-bot:1323769790'`;
    expect(JSON.stringify(r)).not.toContain(token);
    expect(r!.value.secret.ciphertext).toMatch(/^[a-f0-9]+$/);
    expect(
      (await f.db.begin((tx) => readMaintenanceGithubBot(tx, result.identity!)))
        .token,
    ).toBe(token);
    for (const intent of ['write', 'reconcile'] as const) {
      await expect(
        f.db.begin((tx) =>
          // An accidentally omitted runtime identity must never disclose a token.
          readMaintenanceGithubBot(tx, undefined as never, intent),
        ),
      ).rejects.toThrow();
    }
    await expect(
      updateMaintenanceGithubBot(
        admin,
        { ...request, token: token + 'x' },
        { fetcher },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('rotation fences writes by revision; GET reconciliation permits only the same verified robot', async () => {
    const old = (await getMaintenanceGithubBot(admin)).identity!;
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        updateMaintenanceGithubBot(
          admin,
          {
            action: 'replace',
            requestId: randomUUID(),
            expectedRevision: 1,
            expectedLogin: 'rice-maintenance',
            token,
          },
          { fetcher },
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await expect(
      f.db.begin((tx) => readMaintenanceGithubBot(tx, old, 'write')),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(
      (await f.db.begin((tx) => readMaintenanceGithubBot(tx, old, 'reconcile')))
        .identity.revision,
    ).toBe(2);
    const another = (async (url: string | URL | Request) =>
      Response.json(
        String(url).endsWith('/user')
          ? { id: 902, login: 'another-bot' }
          : {
              id: 1323769790,
              full_name: 'semiok/allrice',
              permissions: { push: true },
            },
      )) as typeof fetch;
    await updateMaintenanceGithubBot(
      admin,
      {
        action: 'replace',
        requestId: randomUUID(),
        expectedRevision: 2,
        expectedLogin: 'another-bot',
        token,
      },
      { fetcher: another },
    );
    await expect(
      f.db.begin((tx) => readMaintenanceGithubBot(tx, old, 'reconcile')),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });
  it('rejects ordinary users, revoked browser sessions and noncentral installs; removal needs no decryption key', async () => {
    await expect(getMaintenanceGithubBot(ordinary)).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    await f.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${other.sessionId!}`;
    await expect(
      updateMaintenanceGithubBot(other, {
        action: 'remove',
        requestId: randomUUID(),
        expectedRevision: 3,
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    vi.stubEnv('ALLRICE_MAINTENANCE_CENTRAL_ENABLED', '0');
    expect((await getMaintenanceGithubBot(admin)).state).toBe(
      'central_disabled',
    );
    await expect(
      updateMaintenanceGithubBot(admin, {
        action: 'remove',
        requestId: randomUUID(),
        expectedRevision: 3,
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    vi.stubEnv('ALLRICE_MAINTENANCE_CENTRAL_ENABLED', '1');
    vi.stubEnv('ALLRICE_MCP_CREDENTIAL_KEY', '');
    expect((await getMaintenanceGithubBot(admin)).state).toBe('unavailable');
    expect(
      await updateMaintenanceGithubBot(admin, {
        action: 'remove',
        requestId: randomUUID(),
        expectedRevision: 3,
      }),
    ).toMatchObject({
      revision: 4,
      state: 'not_configured',
      configured: false,
    });
  });
});
