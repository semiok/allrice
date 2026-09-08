import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { RequestContext, Role } from '@allrice/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Client from './core/client.ts';
import { createMcpStore } from './mcp-connections.ts';
import { resolveWorkspaceId } from './workspace/service.ts';

let admin: ReturnType<typeof postgres>;
let database: ReturnType<typeof postgres>;
let reader: ReturnType<typeof postgres>;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => reader,
}));

const schema = `workspace_access_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

async function fixture(
  role: Role = 'admin',
  membershipScope: 'organization' | 'workspace' = 'organization',
) {
  const userId = randomUUID();
  const organizationId = randomUUID();
  const firstWorkspaceId = randomUUID();
  const secondWorkspaceId = randomUUID();
  const membershipId = randomUUID();
  const membershipWorkspace =
    membershipScope === 'organization' ? null : secondWorkspaceId;
  await database.begin(async (tx) => {
    await tx`insert into allrice_users(id,email,display_name,password_hash)
      values(${userId},${`${userId}@example.test`},'Workspace access fixture','not-a-login-password')`;
    await tx`insert into allrice_organizations(id,slug,name)
      values(${organizationId},${`workspace-access-${organizationId}`},'Workspace access fixture')`;
    await tx`insert into allrice_workspaces(id,organization_id,slug,name,created_at)
      values(${firstWorkspaceId},${organizationId},'first','First workspace','2026-01-01T00:00:00Z'),
      (${secondWorkspaceId},${organizationId},'second','Second workspace','2026-01-02T00:00:00Z')`;
    await tx`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role)
      values(${membershipId},${organizationId},${membershipWorkspace},${userId},${role})`;
  });
  // An email/password session has a selected organization but no workspace.
  // These fixtures mirror its current persisted membership, not a fabricated
  // runtime/approval grant. The production resolver still queries real PG.
  const context: RequestContext = {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    actor: { type: 'user', id: userId },
    organizationId,
    workspaceId: null,
    authenticatedAt: new Date().toISOString(),
    memberships: [
      {
        id: membershipId,
        userId,
        organizationId,
        workspaceId: membershipWorkspace,
        role,
        active: true,
      },
    ],
  };
  return {
    context,
    userId,
    organizationId,
    firstWorkspaceId,
    secondWorkspaceId,
    membershipId,
    store: createMcpStore({ database }),
  };
}

suite('workspace MCP page scope — actual isolated PostgreSQL', () => {
  beforeAll(async () => {
    const base = process.env.ALLRICE_TEST_DATABASE_URL;
    if (!base) throw Error('Explicit test database required');
    const url = new URL(base);
    url.search = '';
    admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
    // Reuse the explicitly supplied integration database and its existing
    // extensions. This suite never installs extensions or changes roles.
    const extensions = await admin<{ extname: string }[]>`
      select e.extname from pg_extension e
      join pg_namespace n on n.oid=e.extnamespace
      where e.extname in ('vector','pg_trgm') and n.nspname='public'`;
    expect(extensions.map((row) => row.extname).sort()).toEqual([
      'pg_trgm',
      'vector',
    ]);
    await admin.unsafe(`create schema "${schema}"`);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    database = postgres(url.toString(), { max: 3, onnotice: () => {} });
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory))
      .filter((file) => file.endsWith('.sql'))
      .sort())
      await database.unsafe(await readFile(new URL(file, directory), 'utf8'));
    url.searchParams.set(
      'options',
      `-csearch_path=${schema},public -cdefault_transaction_read_only=on`,
    );
    reader = postgres(url.toString(), { max: 1, onnotice: () => {} });
    const [mode] = await reader`show default_transaction_read_only`;
    expect(mode?.default_transaction_read_only).toBe('on');
  }, 120000);

  afterAll(async () => {
    await reader?.end({ timeout: 5 });
    await database?.end({ timeout: 5 });
    if (admin && /^workspace_access_[a-f0-9]{32}$/.test(schema))
      await admin.unsafe(`drop schema if exists "${schema}" cascade`);
    await admin?.end({ timeout: 5 });
  });

  it('resolves the first accessible workspace for an organization admin without any writes', async () => {
    const f = await fixture();
    await expect(resolveWorkspaceId(f.context)).resolves.toBe(
      f.firstWorkspaceId,
    );
    await expect(f.store.list(f.context, f.firstWorkspaceId)).resolves.toEqual(
      [],
    );
    expect(f.context.workspaceId).toBeNull();
    const [assignments] = await database`
      select count(*)::int as count from allrice_employee_assignments
      where organization_id=${f.organizationId}`;
    expect(assignments?.count).toBe(0);
  });

  it('resolves only a workspace admin’s membership and preserves an explicit authorized workspace', async () => {
    const f = await fixture('admin', 'workspace');
    await expect(resolveWorkspaceId(f.context)).resolves.toBe(
      f.secondWorkspaceId,
    );
    await expect(
      resolveWorkspaceId({ ...f.context, workspaceId: f.secondWorkspaceId }),
    ).resolves.toBe(f.secondWorkspaceId);
    await expect(f.store.list(f.context, f.secondWorkspaceId)).resolves.toEqual(
      [],
    );
    await expect(
      resolveWorkspaceId(f.context, f.firstWorkspaceId),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      f.store.list(f.context, f.firstWorkspaceId),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
  });

  it.each(['member', 'viewer'] as const)(
    'allows %s workspace access without granting MCP administration',
    async (role) => {
      const f = await fixture(role, 'workspace');
      await expect(resolveWorkspaceId(f.context)).resolves.toBe(
        f.secondWorkspaceId,
      );
      await expect(
        f.store.list(f.context, f.secondWorkspaceId),
      ).rejects.toMatchObject({ code: 'MCP_DENIED' });
    },
  );

  it('does not resolve or administer another tenant’s workspace, even for an organization admin', async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(
      resolveWorkspaceId(f.context, other.firstWorkspaceId),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      resolveWorkspaceId({
        ...f.context,
        organizationId: other.organizationId,
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      f.store.list(f.context, other.firstWorkspaceId),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
  });

  it('excludes archived workspaces from fallback and explicit selection', async () => {
    const f = await fixture();
    await database`update allrice_workspaces set archived_at=now() where id=${f.firstWorkspaceId}`;
    await expect(resolveWorkspaceId(f.context)).resolves.toBe(
      f.secondWorkspaceId,
    );
    await expect(
      resolveWorkspaceId({ ...f.context, workspaceId: f.firstWorkspaceId }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await database`update allrice_workspaces set archived_at=now() where id=${f.secondWorkspaceId}`;
    await expect(resolveWorkspaceId(f.context)).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    await expect(
      f.store.list(f.context, f.secondWorkspaceId),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
  });

  it('does not use a stale membership to choose a workspace after access is revoked', async () => {
    const f = await fixture('admin', 'workspace');
    await database`update allrice_memberships set active=false where id=${f.membershipId}`;
    await expect(resolveWorkspaceId(f.context)).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    await expect(
      f.store.list(f.context, f.secondWorkspaceId),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
  });
});
