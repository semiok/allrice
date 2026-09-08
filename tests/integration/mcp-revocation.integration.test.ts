import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Client from '../../packages/database/src/core/client.ts';
import {
  createMcpExecutionFixture,
  createMcpFixtureDatabase as postgres,
} from '../../packages/database/src/mcp-execution.fixture.ts';
import { createSession } from '../../packages/database/src/identity.ts';
import { listCloudRuntimeOperations } from '../../packages/database/src/cloud-operation-view.ts';
import { POST } from '../../apps/web/app/api/v1/runtime/approvals/[id]/route';
import { getRequestContext } from '../../apps/web/lib/identity/session';

let db: ReturnType<typeof postgres>, admin: ReturnType<typeof postgres>;
const routeSession = vi.hoisted(() => ({ token: '' }));
// Resolve the accessor from its owning Web package: Next is deliberately not a
// root integration-test dependency. Mocking bare next/headers from here would
// leave the Web import untouched and invoke Next without a request context.
vi.mock('../../apps/web/node_modules/next/headers.js', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'allrice_session' && routeSession.token
        ? { value: routeSession.token }
        : undefined,
  }),
}));
vi.mock('../../packages/database/src/core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
const schema = `mcp_revoke_http_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const services: Awaited<
  ReturnType<typeof createMcpExecutionFixture>
>['service'][] = [];

suite(
  'MCP connection revocation: real session, projection and HTTP approval denial',
  () => {
    beforeAll(async () => {
      const base = process.env.ALLRICE_TEST_DATABASE_URL;
      if (!base) throw Error('explicit test database required');
      vi.stubEnv('ALLRICE_CLOUD_MCP_ENABLED', '1');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      vi.stubEnv('ALLRICE_PORTAL_AUTH_ENABLED', '0');
      vi.stubEnv('ALLRICE_MCP_CREDENTIAL_KEY', 'af'.repeat(32));
      const url = new URL(base);
      url.search = '';
      admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(20260907,1)`;
        await tx`create extension if not exists vector with schema public`;
        await tx`create extension if not exists pg_trgm with schema public`;
      });
      await admin.unsafe(`create schema "${schema}"`);
      url.searchParams.set('options', `-csearch_path=${schema},public`);
      db = postgres(url.toString(), { max: 12, onnotice: () => {} });
      const directory = new URL(
        '../../packages/database/migrations/',
        import.meta.url,
      );
      for (const name of (await readdir(directory))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await db.unsafe(await readFile(new URL(name, directory), 'utf8'));
    }, 120000);
    afterAll(async () => {
      routeSession.token = '';
      for (const service of services) await service.close();
      await db?.end({ timeout: 5 });
      if (admin && /^mcp_revoke_http_[a-f0-9]{32}$/.test(schema))
        await admin.unsafe(`drop schema "${schema}" cascade`);
      await admin?.end({ timeout: 5 });
      vi.unstubAllEnvs();
    });
    it('keeps the exact request after store.revoke and returns 403 to its formerly valid approval POST', async () => {
      const f = await createMcpExecutionFixture(db);
      services.push(f.service);
      await f.create();
      const [before] = await listCloudRuntimeOperations(f.context, f.run, db);
      expect(before!.mcpAuthorization?.available).toBe(true);
      await f.store.revoke(f.context, {
        workspaceId: f.workspace,
        connectionId: f.connection.id,
      });
      const [after] = await listCloudRuntimeOperations(f.context, f.run, db);
      expect(after!.mcpAuthorization).toEqual({
        available: false,
        reason: 'connection_revoked',
      });
      expect(after!.approval).toEqual(before!.approval);
      expect(after!.approval!.revokedAt).toBeNull();
      // Official service produces a real persisted session token. The Next cookie
      // accessor is adapted only for this in-process HTTP handler test; this is not
      // browser-login or public production-transport coverage.
      routeSession.token = (await createSession(f.user)).token;
      const authenticated = await getRequestContext(
        new Request('https://allrice.test/api/v1/auth/session', {
          headers: {
            'x-allrice-organization-id': f.org,
            'x-allrice-workspace-id': f.workspace,
          },
        }),
      );
      expect(authenticated?.actor.id).toBe(f.user);
      expect(authenticated?.organizationId).toBe(f.org);
      expect(authenticated?.workspaceId).toBe(f.workspace);
      const request = before!.approval!.request;
      const response = await POST(
        new Request(
          `https://allrice.test/api/v1/runtime/approvals/${request.approvalId}`,
          {
            method: 'POST',
            headers: {
              origin: 'https://allrice.test',
              'content-type': 'application/json',
              'x-allrice-organization-id': f.org,
              'x-allrice-workspace-id': f.workspace,
            },
            body: JSON.stringify({
              contractVersion: 1,
              direction: 'response',
              kind: 'action_approval',
              requestId: request.requestId,
              version: request.version,
              requestDigest: request.requestDigest,
              task: request.task,
              responseId: randomUUID(),
              respondedBy: f.user,
              respondedAt: new Date().toISOString(),
              approvalId: request.approvalId,
              decision: 'approved',
            }),
          },
        ),
        { params: Promise.resolve({ id: request.approvalId }) },
      );
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBeTruthy();
      const [retained] = await listCloudRuntimeOperations(f.context, f.run, db);
      expect(retained!.approval).toEqual(before!.approval);
      expect(f.service.state.calls).toBe(0);
    });
  },
);
