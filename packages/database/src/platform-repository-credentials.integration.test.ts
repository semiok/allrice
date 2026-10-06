import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from './identity.ts';
import {
  getPlatformRepositoryCredential,
  updatePlatformRepositoryCredential,
  readPlatformRepositoryCredential,
} from './platform-repository-credentials.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'private platform repository credential persistence and current authority',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
      admin: RequestContext,
      other: RequestContext;
    const token = 'github_pat_' + 'SyntheticOnly'.repeat(7),
      replacement = 'github_pat_' + 'ReplacementOnly'.repeat(6),
      key = 'a'.repeat(64);
    beforeAll(async () => {
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      async function principal(email: string) {
        const account = await ensureBootstrapPortalPrincipal({
          organizationSlug: 'allrice-platform',
          organizationName: 'Internal',
          workspaceSlug: 'control-plane',
          workspaceName: 'Internal',
          email,
          displayName: 'Fixture',
          role: 'member',
        });
        return (await authenticateSession(
          (await createSession(account.user.id)).token,
        ))!;
      }
      admin = await principal('repository-admin@example.test');
      other = await principal('repository-other@example.test');
      vi.stubEnv(
        'ALLRICE_PLATFORM_ADMIN_EMAILS',
        'repository-admin@example.test,repository-other@example.test',
      );
      vi.stubEnv('ALLRICE_MCP_CREDENTIAL_KEY', key);
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (fixture) await fixture.close();
    });
    it('persists encrypted bytes, returns only facts, and recovers a committed write through its request ID', async () => {
      const before = await getPlatformRepositoryCredential(admin);
      expect(before.state).toBe('not_configured');
      const requestId = randomUUID();
      const result = await updatePlatformRepositoryCredential(admin, {
        action: 'replace',
        expectedRevision: before.revision,
        requestId,
        token,
      });
      expect(result).toMatchObject({
        state: 'configured',
        revision: 1,
        repository: 'semiok/allrice',
        lastWriteRequestId: requestId,
      });
      expect(JSON.stringify(result)).not.toContain(token);
      expect(await getPlatformRepositoryCredential(admin)).toEqual(result);
      expect(await readPlatformRepositoryCredential(admin, 1)).toBe(token);
      const [row] =
        await fixture.db`select value from allrice_runtime_metadata where key like ${'platform-repository-credential:' + admin.actor.id + ':%'}`;
      expect(JSON.stringify(row)).not.toContain(token);
      expect(row!.value.secret.ciphertext).toMatch(/^[a-f0-9]+$/);
      const events =
        await fixture.db`select metadata from allrice_audit_events where request_id=${requestId}`;
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toEqual({
        revision: 1,
        repositoryId: 1323769790,
      });
    });
    it('isolates other administrators, refuses stale updates and rechecks revoked logins', async () => {
      expect((await getPlatformRepositoryCredential(other)).configured).toBe(
        false,
      );
      await expect(
        readPlatformRepositoryCredential(other, 1),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        updatePlatformRepositoryCredential(admin, {
          action: 'remove',
          expectedRevision: 0,
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      await fixture.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${other.sessionId!}`;
      await expect(
        updatePlatformRepositoryCredential(other, {
          action: 'replace',
          expectedRevision: 0,
          requestId: randomUUID(),
          token,
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect((await getPlatformRepositoryCredential(admin)).revision).toBe(1);
    });
    it('serializes concurrent rotations, invalidates the old revision and permits removal without the encryption key', async () => {
      const results = await Promise.allSettled([
        updatePlatformRepositoryCredential(admin, {
          action: 'replace',
          expectedRevision: 1,
          requestId: randomUUID(),
          token: replacement,
        }),
        updatePlatformRepositoryCredential(admin, {
          action: 'replace',
          expectedRevision: 1,
          requestId: randomUUID(),
          token: replacement,
        }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      await expect(
        readPlatformRepositoryCredential(admin, 1),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(await readPlatformRepositoryCredential(admin, 2)).toBe(
        replacement,
      );
      vi.stubEnv('ALLRICE_MCP_CREDENTIAL_KEY', 'b'.repeat(64));
      expect(await getPlatformRepositoryCredential(admin)).toMatchObject({
        configured: true,
        state: 'unavailable',
      });
      await expect(
        readPlatformRepositoryCredential(admin, 2),
      ).rejects.toBeDefined();
      vi.stubEnv('ALLRICE_MCP_CREDENTIAL_KEY', '');
      expect(
        await updatePlatformRepositoryCredential(admin, {
          action: 'remove',
          expectedRevision: 2,
          requestId: randomUUID(),
        }),
      ).toMatchObject({ revision: 3, state: 'not_configured' });
      vi.stubEnv('ALLRICE_MCP_CREDENTIAL_KEY', key);
    });
    it('rejects ordinary accounts, forged sessions and caller supplied repositories before any credential write', async () => {
      await expect(
        updatePlatformRepositoryCredential(admin, {
          action: 'replace',
          expectedRevision: 3,
          requestId: randomUUID(),
          token,
          repository: 'another/repository',
        }),
      ).rejects.toThrow();
      await expect(
        getPlatformRepositoryCredential({ ...admin, sessionId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', 'nobody@example.test');
      await expect(
        getPlatformRepositoryCredential(admin),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        updatePlatformRepositoryCredential(admin, {
          action: 'replace',
          expectedRevision: 3,
          requestId: randomUUID(),
          token,
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    });
  },
);
