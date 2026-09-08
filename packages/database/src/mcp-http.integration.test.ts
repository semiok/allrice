import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMcpStore } from '@allrice/database';
import { McpError, type RequestContext } from '@allrice/contracts';

import { createMcpTransport } from '../../../apps/worker/src/mcp/transport.js';
import { startMcpAcceptanceService } from '../../../apps/worker/src/mcp/test-service.js';
import {
  executeNextMcpDiscovery,
  invokeFrozenMcpTool,
} from '../../../apps/worker/src/mcp/lifecycle.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
let admin: ReturnType<typeof postgres>;
let database: ReturnType<typeof postgres>;
let service: Awaited<ReturnType<typeof startMcpAcceptanceService>>;
const schema = `p16_mcp_http_${randomUUID().replaceAll('-', '')}`;
suite('P16 real PostgreSQL → Worker → self-owned MCP HTTP', () => {
  beforeAll(async () => {
    const base = process.env.ALLRICE_TEST_DATABASE_URL;
    if (!base) throw Error('Explicit test database required');
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
    database = postgres(url.toString(), { max: 6, onnotice: () => {} });
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory))
      .filter((file) => file.endsWith('.sql'))
      .sort())
      await database.unsafe(await readFile(new URL(file, directory), 'utf8'));
    service = await startMcpAcceptanceService();
    vi.stubEnv('ALLRICE_CLOUD_MCP_ENABLED', '1');
  }, 120_000);
  afterAll(async () => {
    await service?.close();
    await database?.end({ timeout: 5 });
    if (admin && /^p16_mcp_http_[a-f0-9]{32}$/.test(schema))
      await admin.unsafe(`drop schema "${schema}" cascade`);
    await admin?.end({ timeout: 5 });
    vi.unstubAllEnvs();
  });
  it('discovers through the Worker queue, blocks unclaimed dispatch, executes an authorized synthetic write and honors revocation', async () => {
    const organizationId = randomUUID(),
      workspaceId = randomUUID(),
      actorId = randomUUID();
    await database`insert into allrice_users(id,email,display_name,password_hash) values(${actorId},${`${actorId}@example.test`},'MCP HTTP test','not-a-login')`;
    await database`insert into allrice_organizations(id,slug,name) values(${organizationId},${`p16http-${organizationId}`},'MCP HTTP test')`;
    await database`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspaceId},${organizationId},'default','MCP HTTP test')`;
    await database`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${organizationId},${workspaceId},${actorId},'admin')`;
    const context: RequestContext = {
      requestId: randomUUID(),
      sessionId: randomUUID(),
      actor: { type: 'user', id: actorId },
      organizationId,
      workspaceId,
      authenticatedAt: new Date().toISOString(),
      memberships: [
        {
          id: randomUUID(),
          userId: actorId,
          organizationId,
          workspaceId,
          role: 'admin',
          active: true,
        },
      ],
    };
    const scope = { organizationId, workspaceId, actorId };
    const store = createMcpStore({ database, credentialKey: 'ef'.repeat(32) });
    const transport = createMcpTransport({
      fetchOverride: service.fetchOverride,
    });
    const signal = AbortSignal.timeout(30_000);
    const connection = await store.create(context, {
      workspaceId,
      name: 'Self-owned MCP acceptance',
      endpoint: service.endpoint,
      bearerToken: service.state.token,
    });
    await store.queueDiscovery(context, {
      workspaceId,
      connectionId: connection.id,
    });
    expect(
      await executeNextMcpDiscovery({
        workerId: randomUUID(),
        signal,
        store,
        transport,
      }),
    ).toBe(true);
    const [discovered] = await store.list(context, workspaceId);
    expect(discovered?.discoveryState).toBe('ready');
    expect(discovered?.tools).toHaveLength(3);
    expect(await store.freeze(scope)).toEqual([]);
    const tool = discovered!.tools.find(
      (tool) => tool.name === 'records.append',
    )!;
    await store.grant(context, {
      workspaceId,
      connectionId: connection.id,
      revisionId: tool.revisionId,
      allowed: true,
      risk: 'write',
    });
    const [frozen] = await store.freeze(scope);
    const input = {
      scope,
      tool: frozen!,
      arguments: { value: 'authorized-synthetic-record' },
      signal,
      store,
      transport,
    };
    await expect(
      invokeFrozenMcpTool({
        ...input,
        assertOperationLease: async () => {
          throw new McpError('MCP_DENIED');
        },
      }),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
    expect(service.state.calls).toBe(0);
    // P16 adapter boundary only: P04/P03 exact approval+ledger integration is
    // tested by the outer dispatcher, not falsely claimed by this fixture.
    let leaseChecks = 0;
    const result = await invokeFrozenMcpTool({
      ...input,
      assertOperationLease: async () => {
        leaseChecks++;
      },
    });
    expect(leaseChecks).toBeGreaterThan(1);
    expect(service.state.rows).toEqual(['authorized-synthetic-record']);
    expect(JSON.stringify(result)).not.toContain(service.state.token);
    await store.revoke(context, { workspaceId, connectionId: connection.id });
    await expect(
      invokeFrozenMcpTool({ ...input, assertOperationLease: async () => {} }),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
    expect(service.state.calls).toBe(1);
  });
});
