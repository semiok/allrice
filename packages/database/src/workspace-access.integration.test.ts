import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import {
  localCommandToolchainImageV1,
  workspaceCapabilityIds,
  type RequestContext,
  type Role,
} from '@allrice/contracts';
import postgres from 'postgres';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type * as Client from './core/client.ts';
import { createMcpStore } from './mcp-connections.ts';
import { resolveWorkspaceId } from './workspace/service.ts';
import { getWorkspaceReadiness } from './workspace-readiness.ts';
import { employeeManifest } from './employees/employee-config.ts';

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
  afterEach(() => vi.unstubAllEnvs());
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

  it('UX01-B discovery is read-only and rejects forged scopes, revoked membership and other-owner sessions', async () => {
    const f = await fixture('member', 'workspace'),
      other = await fixture();
    const read = () =>
      getWorkspaceReadiness(f.context, f.secondWorkspaceId, null);
    const value = await read();
    expect(value.canAdminister).toBe(false);
    expect(value.capabilities.map((capability) => capability.id)).toEqual([
      ...workspaceCapabilityIds,
    ]);
    expect(
      value.capabilities.find((capability) => capability.id === 'development'),
    ).toMatchObject({ state: 'not_released' });
    expect(value.viewerId).toBe(f.userId);
    expect(JSON.stringify(value)).not.toMatch(
      /credential|envelope|token_hash|root_fingerprint|endpoint/,
    );
    await expect(
      getWorkspaceReadiness(f.context, f.firstWorkspaceId, null),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      getWorkspaceReadiness(f.context, other.firstWorkspaceId, null),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    const session = randomUUID(),
      employee = randomUUID(),
      version = randomUUID();
    await database`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name) values(${employee},${f.organizationId},${f.secondWorkspaceId},'private-fixture','Private fixture')`;
    await database`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest) values(${version},${f.organizationId},${f.secondWorkspaceId},${employee},1,'Fixture','synthetic','test','[]',${'sha256:' + 'a'.repeat(64)},'{}')`;
    await database`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_version_id) values(${session},${f.organizationId},${f.secondWorkspaceId},${other.userId},'Private readiness fixture',${version})`;
    await expect(
      getWorkspaceReadiness(f.context, f.secondWorkspaceId, session),
    ).rejects.toMatchObject({ code: 'not_found' });
    await database`update allrice_memberships set active=false where id=${f.membershipId}`;
    await expect(read()).rejects.toMatchObject({
      code: 'authorization_denied',
    });
  });

  it('MET159 separates member application availability from scoped connection readiness without writes', async () => {
    vi.stubEnv('ALLRICE_CLOUD_MCP_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_MCP_CREDENTIAL_KEY', '');
    const f = await fixture('member'),
      org = f.organizationId,
      ws = f.firstWorkspaceId,
      user = f.userId;
    const employee = randomUUID(),
      version = randomUUID(),
      assignment = randomUUID();
    const manifest = employeeManifest({
      key: 'apps-fixture',
      name: 'Apps fixture',
      description: 'Isolated test',
      toolNames: ['cloud.mcp.call'],
      securityPolicy: {
        dataScopes: ['workspace', 'user'],
        connectorIdentityModes: ['service'],
        approvalPolicy: 'confirm_external',
        deniedCapabilities: [],
      },
    });
    await database.begin(async (tx) => {
      await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name) values(${employee},${org},${ws},'apps-fixture','Fixture')`;
      await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest) values(${version},${org},${ws},${employee},1,'Fixture','synthetic','test','[]',${'sha256:' + 'a'.repeat(64)},${tx.json(manifest)})`;
      await tx`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id) values(${assignment},${org},${ws},${employee},${version},${user})`;
      await tx`insert into allrice_runtime_policy_controls(organization_id,workspace_id,version,controls) values(${org},${ws},1,${tx.json({ version: 1, enabled: true, mode: 'execute', rules: [{ action: 'cloud.mcp.call', effect: 'allow' }] })})`;
    });
    const status = async () =>
      (await getWorkspaceReadiness(f.context, ws, null)).capabilities.find(
        (c) => c.id === 'cloud_mcp',
      )!;
    expect(await status()).toMatchObject({
      state: 'ready',
      reason: 'connection_on_demand',
      action: 'compose',
    });
    const store = createMcpStore({ database, memberManaged: true });
    const connection = await store.create(f.context, {
      workspaceId: ws,
      name: 'Public fixture',
      endpoint: 'https://mcp.example.test/mcp',
    });
    const lease = await store.claimDiscovery(randomUUID());
    expect(lease?.connectionId).toBe(connection.id);
    await store.completeDiscovery(lease!, {
      tools: [
        {
          name: 'records.list',
          description: 'Synthetic',
          inputSchema: { type: 'object', properties: {} },
          outputSchema: null,
        },
      ],
    });
    await database`insert into allrice_employee_mcp_bindings(organization_id,workspace_id,employee_id,employee_version_id,connector_binding_id,enabled,granted_by) values(${org},${ws},${employee},${version},${connection.id},true,${user})`;
    // Anonymous connections do not depend on a private-credential encryption key.
    expect(await status()).toMatchObject({ state: 'ready', reason: 'ready' });
    await store.setMemberConnected(f.context, {
      workspaceId: ws,
      connectionId: connection.id,
      connected: false,
    });
    expect(await status()).toMatchObject({
      state: 'ready',
      reason: 'connection_on_demand',
    });
    await store.setMemberConnected(f.context, {
      workspaceId: ws,
      connectionId: connection.id,
      connected: true,
    });
    const other = await fixture('member');
    await database`update allrice_mcp_binding_config set managed_by=${other.userId} where binding_id=${connection.id}`;
    expect(await status()).toMatchObject({
      state: 'ready',
      reason: 'connection_on_demand',
    });
    await database`update allrice_mcp_binding_config set managed_by=${user},auth_kind='bearer' where binding_id=${connection.id}`;
    expect(await status()).toMatchObject({
      state: 'ready',
      reason: 'connection_on_demand',
    });
    await database`update allrice_memberships set role='viewer' where id=${f.membershipId}`;
    expect(await status()).toMatchObject({
      state: 'needs_authorization',
      reason: 'read_only',
    });
    const [operations] =
      await database`select count(*)::int as n from allrice_runtime_operations where organization_id=${org}`;
    expect(operations?.n).toBe(0);
  });

  it('UX01-B reports real folder/sandbox freshness without cloud dependence or writes', async () => {
    for (const flag of [
      'ALLRICE_WORKBENCH_ENABLED',
      'ALLRICE_LOCAL_COMMAND_ENABLED',
      'ALLRICE_RUNTIME_POLICY_ENABLED',
      'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
    ])
      vi.stubEnv(flag, '1');
    const f = await fixture(),
      org = f.organizationId,
      ws = f.firstWorkspaceId,
      user = f.userId;
    const employee = randomUUID(),
      version = randomUUID(),
      assignment = randomUUID(),
      session = randomUUID(),
      device = randomUUID(),
      folder = randomUUID();
    const manifest = employeeManifest({
      key: 'readiness-fixture',
      name: 'Readiness fixture',
      description: 'Isolated test only',
      toolNames: [
        'workspace.export.create',
        'local.fs.list',
        'local.fs.read',
        'local.process.execute',
      ],
    });
    const policy = {
      version: 1,
      enabled: true,
      mode: 'execute',
      rules: ['local.fs.list', 'local.fs.read', 'local.process.execute'].map(
        (action) => ({ action, effect: 'allow' }),
      ),
    };
    await database.begin(async (tx) => {
      await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name) values(${employee},${org},${ws},'readiness-fixture','Fixture')`;
      await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest) values(${version},${org},${ws},${employee},1,'Fixture','synthetic','test','[]',${'sha256:' + 'a'.repeat(64)},${tx.json(manifest)})`;
      await tx`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id) values(${assignment},${org},${ws},${employee},${version},${user})`;
      await tx`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id) values(${session},${org},${ws},${user},'Readiness',${assignment},${version})`;
      await tx`insert into allrice_runtime_policy_controls(organization_id,workspace_id,version,controls) values(${org},${ws},1,${tx.json(policy)})`;
      await tx`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at) values(${device},${org},${ws},${user},'Isolated Bridge','macos-arm64',2,array['local.fs.list','local.fs.read'],${'b'.repeat(64)},now())`;
      await tx`insert into allrice_execution_targets(organization_id,workspace_id,target_key,kind,label,state,capabilities) values(${org},${ws},${'bridge.' + device},'rice_bridge','Fixture','online','["files.read"]')`;
    });
    const read = () => getWorkspaceReadiness(f.context, ws, session);
    const capability = async (id: string) =>
      (await read()).capabilities.find((c) => c.id === id)!;
    expect((await capability('local_files')).reason).toBe('folder_missing');
    expect((await capability('report')).state).toBe('ready');
    await database`insert into allrice_bridge_folder_grants(id,organization_id,workspace_id,owner_id,device_id,label,root_fingerprint) values(${folder},${org},${ws},${user},${device},'Private path not exposed',${'c'.repeat(64)})`;
    expect((await capability('local_files')).state).toBe('ready');
    expect((await capability('local_command')).reason).toBe('runner_missing');
    const profile = {
      contractVersion: 1,
      backend: 'local-vm-container-v1',
      imageDigest: localCommandToolchainImageV1,
      architecture: 'arm64',
      available: true,
    };
    await database`insert into allrice_bridge_runtime_profiles(device_id,organization_id,workspace_id,profile) values(${device},${org},${ws},${database.json(profile)})`;
    expect((await capability('local_command')).state).toBe('ready');
    await database`update allrice_bridge_runtime_profiles set reported_at=now()-interval '91 seconds' where device_id=${device}`;
    expect((await capability('local_command')).reason).toBe('runner_missing');
    await database`update allrice_bridge_runtime_profiles set reported_at=now(),profile=${database.json({ ...profile, architecture: 'amd64' })} where device_id=${device}`;
    expect((await capability('local_command')).reason).toBe('runner_missing');
    await database`update allrice_bridge_devices set last_seen_at=now()-interval '91 seconds' where id=${device}`;
    expect((await capability('local_files')).state).toBe('device_offline');
    expect((await capability('report')).state).toBe('ready');
    expect(JSON.stringify(await read())).not.toContain('Private path');
    vi.stubEnv('ALLRICE_LOCAL_COMMAND_ENABLED', '0');
    expect((await capability('local_command')).state).toBe('not_released');
    const [writes] =
      await database`select count(*)::int as n from allrice_runtime_operations where organization_id=${org}`;
    expect(writes?.n).toBe(0);
    // A legacy/missing assignment must not quietly switch this session to the
    // user's otherwise valid default employee and claim its permissions.
    await database`update allrice_chat_sessions set employee_assignment_id=null where id=${session}`;
    expect((await capability('report')).reason).toBe('employee_missing');
    expect((await read()).employeeVersionId).toBeNull();
    expect(
      (await getWorkspaceReadiness(f.context, ws, null)).employeeVersionId,
    ).toBe(version);
  });
});
