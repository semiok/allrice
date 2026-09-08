import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext, McpDiscoveredTool } from '@allrice/contracts';

import { createMcpStore } from './mcp-connections.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
let admin: ReturnType<typeof postgres>;
let db: ReturnType<typeof postgres>;
const schema = `p16_mcp_${randomUUID().replaceAll('-', '')}`;
const key = 'ab'.repeat(32);
const token = 'synthetic-mcp-token-never-in-audit';
const tool: McpDiscoveredTool = {
  name: 'records.list',
  description: 'Read synthetic data',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: null,
};
async function fixture() {
  const userId = randomUUID(),
    organizationId = randomUUID(),
    workspaceId = randomUUID();
  await db`insert into allrice_users(id,email,display_name,password_hash) values(${userId},${`${userId}@example.test`},'P16 test','not-a-password')`;
  await db`insert into allrice_organizations(id,slug,name) values(${organizationId},${`p16-${organizationId}`},'P16 test')`;
  await db`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspaceId},${organizationId},'default','P16 test')`;
  await db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${organizationId},${workspaceId},${userId},'admin')`;
  const context: RequestContext = {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    actor: { type: 'user', id: userId },
    organizationId,
    workspaceId,
    authenticatedAt: new Date().toISOString(),
    memberships: [
      {
        id: randomUUID(),
        userId,
        organizationId,
        workspaceId,
        role: 'admin',
        active: true,
      },
    ],
  };
  const scope = { organizationId, workspaceId, actorId: userId };
  const store = createMcpStore({ database: db, credentialKey: key });
  const connection = await store.create(context, {
    workspaceId,
    name: 'Synthetic MCP',
    endpoint: 'https://mcp.example.test/mcp',
    bearerToken: token,
  });
  async function discover(tools = [tool]) {
    await store.queueDiscovery(context, {
      workspaceId,
      connectionId: connection.id,
    });
    const lease = await store.claimDiscovery(randomUUID());
    expect(lease?.connectionId).toBe(connection.id);
    await store.completeDiscovery(lease!, { tools });
    return (await store.list(context, workspaceId)).find(
      (row) => row.id === connection.id,
    )!;
  }
  async function grant() {
    const discovered = await discover();
    await store.grant(context, {
      workspaceId,
      connectionId: connection.id,
      revisionId: discovered.tools[0]!.revisionId,
      allowed: true,
      risk: 'read_only',
    });
    return (await store.freeze(scope))[0]!;
  }
  return { context, scope, store, connection, discover, grant };
}
suite('P16 tenant MCP authority — actual isolated PostgreSQL', () => {
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
    db = postgres(url.toString(), { max: 6, onnotice: () => {} });
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory))
      .filter((file) => file.endsWith('.sql'))
      .sort())
      await db.unsafe(await readFile(new URL(file, directory), 'utf8'));
  }, 120_000);
  afterAll(async () => {
    await db?.end({ timeout: 5 });
    if (admin && /^p16_mcp_[a-f0-9]{32}$/.test(schema))
      await admin.unsafe(`drop schema "${schema}" cascade`);
    await admin?.end({ timeout: 5 });
  });
  it('uses existing connector authority, encrypts the tenant credential and never returns it', async () => {
    const f = await fixture();
    const [binding] =
      await db`select * from allrice_connector_bindings where id=${f.connection.id}`;
    expect(binding?.connector_id).toBe(f.connection.definitionId);
    const [config] =
      await db`select credential_envelope from allrice_mcp_binding_config where binding_id=${f.connection.id}`;
    expect(JSON.stringify(config)).not.toContain(token);
    expect(
      JSON.stringify(await f.store.list(f.context, f.scope.workspaceId)),
    ).not.toContain(token);
    const audits =
      await db`select * from allrice_audit_events where resource_id=${f.connection.id}`;
    expect(JSON.stringify(audits)).not.toContain(token);
  });
  it('does not trust an old admin membership snapshot after current membership is revoked', async () => {
    const f = await fixture();
    await db`update allrice_memberships set active=false where user_id=${f.scope.actorId}`;
    await expect(
      f.store.list(f.context, f.scope.workspaceId),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
    await expect(
      f.store.rotate(f.context, {
        workspaceId: f.scope.workspaceId,
        connectionId: f.connection.id,
        bearerToken: 'new-synthetic-token',
      }),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
    await expect(
      f.store.queueDiscovery(f.context, {
        workspaceId: f.scope.workspaceId,
        connectionId: f.connection.id,
      }),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
  });
  it('defaults each discovered tool to denied and requires an exact explicit grant', async () => {
    const f = await fixture();
    const discovered = await f.discover();
    expect(discovered.tools[0]?.allowed).toBe(false);
    expect(await f.store.freeze(f.scope)).toEqual([]);
    const frozen = await f.grant();
    await expect(
      f.store.assertAuthorized(f.scope, frozen),
    ).resolves.toMatchObject({ endpoint: f.connection.endpoint });
    expect(await f.store.executionCredential(f.scope, frozen)).toBe(token);
  });
  it('rejects cross-tenant administration, frozen tools and decryption', async () => {
    const f = await fixture();
    const other = await fixture();
    const frozen = await f.grant();
    await expect(
      f.store.assertAuthorized(other.scope, frozen),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
    await expect(
      f.store.executionCredential(other.scope, frozen),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
    await expect(
      f.store.revoke(other.context, {
        workspaceId: other.scope.workspaceId,
        connectionId: f.connection.id,
      }),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
    await expect(
      f.store.list({ ...f.context, memberships: [] }, f.scope.workspaceId),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
  });
  it('fails closed when schema changes and preserves immutable old discovery evidence', async () => {
    const f = await fixture();
    const frozen = await f.grant();
    const changed = await f.discover([
      { ...tool, description: 'new revision' },
    ]);
    expect(changed.tools[0]?.allowed).toBe(false);
    await expect(
      f.store.assertAuthorized(f.scope, frozen),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
    const [old] =
      await db`select definition from allrice_mcp_tool_revisions where id=${frozen.toolRevisionId}`;
    expect(old?.definition).toEqual(tool);
  });
  it('revokes removed tools and does not restore grants when a tool reappears', async () => {
    const f = await fixture();
    const frozen = await f.grant();
    await f.discover([]);
    await expect(
      f.store.assertAuthorized(f.scope, frozen),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
    const restored = await f.discover();
    expect(restored.tools[0]?.allowed).toBe(false);
  });
  it('rotation invalidates previous snapshots and encrypts the replacement under tenant AAD', async () => {
    const f = await fixture();
    const frozen = await f.grant();
    await f.store.rotate(f.context, {
      workspaceId: f.scope.workspaceId,
      connectionId: f.connection.id,
      bearerToken: 'new-synthetic-token',
    });
    await expect(
      f.store.executionCredential(f.scope, frozen),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
    expect(await f.store.freeze(f.scope)).toEqual([]);
    const replacement = await f.grant();
    expect(await f.store.executionCredential(f.scope, replacement)).toBe(
      'new-synthetic-token',
    );
    await expect(
      createMcpStore({
        database: db,
        credentialKey: 'cd'.repeat(32),
      }).executionCredential(f.scope, replacement),
    ).rejects.toMatchObject({ code: 'MCP_CREDENTIAL_UNAVAILABLE' });
  });
  it('revoke blocks both existing tool authorization and queued discovery', async () => {
    const f = await fixture();
    const frozen = await f.grant();
    await f.store.revoke(f.context, {
      workspaceId: f.scope.workspaceId,
      connectionId: f.connection.id,
    });
    await expect(
      f.store.assertAuthorized(f.scope, frozen),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
    await expect(
      f.store.queueDiscovery(f.context, {
        workspaceId: f.scope.workspaceId,
        connectionId: f.connection.id,
      }),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
  });
  it('claims discovery once and fences revoked or stale receipts', async () => {
    const f = await fixture();
    await f.store.queueDiscovery(f.context, {
      workspaceId: f.scope.workspaceId,
      connectionId: f.connection.id,
    });
    const leases = await Promise.all([
      f.store.claimDiscovery(randomUUID()),
      f.store.claimDiscovery(randomUUID()),
    ]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    const lease = leases.find(Boolean)!;
    expect(await f.store.discoveryCredential(lease)).toBe(token);
    await f.store.revoke(f.context, {
      workspaceId: f.scope.workspaceId,
      connectionId: f.connection.id,
    });
    await expect(
      f.store.completeDiscovery(lease, { tools: [tool] }),
    ).rejects.toMatchObject({ code: 'MCP_DISCOVERY_STALE' });
  });
  it('rejects frozen schema tampering and database ciphertext transplant', async () => {
    const f = await fixture();
    const frozen = await f.grant();
    await expect(
      f.store.assertAuthorized(f.scope, {
        ...frozen,
        inputSchema: { type: 'object' },
      }),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
    const other = await fixture();
    const [otherCipher] =
      await db`select credential_envelope from allrice_mcp_binding_config where binding_id=${other.connection.id}`;
    await db`update allrice_mcp_binding_config set credential_envelope=${db.json(otherCipher!.credential_envelope)} where binding_id=${f.connection.id}`;
    await expect(
      f.store.executionCredential(f.scope, frozen),
    ).rejects.toMatchObject({ code: 'MCP_CREDENTIAL_UNAVAILABLE' });
  });
});
