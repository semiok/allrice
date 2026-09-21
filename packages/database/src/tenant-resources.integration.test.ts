import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createAssistantFixtureDatabase,
  assistantFixture,
} from './assistant-runtime.fixture.ts';
import * as client from './core/client.ts';
import {
  ensureBootstrapPortalPrincipal,
  createSession,
  authenticateSession,
  revokeSession,
} from './identity.ts';
import {
  getAdminTenantQuotas,
  updateAdminTenantQuota,
} from './tenant-quotas.ts';
import {
  getUserMonthlyQuota,
  resourceStatus,
  assertModelResourceAvailable,
} from './providers/model-governance.ts';
import {
  getAdminTenantEnvironments,
  mutateAdminTenantEnvironment,
} from './tenant-environments.ts';
import { createMcpStore } from './mcp-connections.ts';
import { createLocalMcpStore } from './local-mcp-connections.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET-151 PR3 tenant resources (isolated PostgreSQL)', () => {
  let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    f = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (f) await f.close();
  });
  async function principal(role: 'admin' | 'member' = 'member') {
    const slug = `r-${randomUUID()}`,
      p = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: slug,
          organizationName: slug,
          workspaceSlug: 'default',
          workspaceName: 'default',
          email: `${slug}@example.test`,
          displayName: slug,
          role,
        },
        f.db,
      ),
      session = await createSession(p.user.id),
      context = await authenticateSession(session.token, {
        organizationId: p.organizationId,
        workspaceId: p.workspaceId,
      });
    if (!context) throw Error('fixture_login');
    return { ...p, context, session };
  }
  async function setup() {
    const admin = await principal('admin'),
      user = await principal(),
      other = await principal();
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', admin.user.email);
    return {
      admin,
      user,
      other,
      target: {
        organizationId: user.organizationId,
        workspaceId: user.workspaceId,
        subjectId: user.user.id,
      },
    };
  }
  async function cloudTarget(t: Awaited<ReturnType<typeof setup>>) {
    const id = randomUUID();
    await f.db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities) values(${id},${t.target.organizationId},${t.target.workspaceId},${`cloud.${id}`},'cloud_sandbox','Synthetic cloud','online','["browser.navigate","process.execute"]')`;
    return id;
  }
  async function device(t: Awaited<ReturnType<typeof setup>>) {
    const id = randomUUID(),
      targetId = randomUUID(),
      folder = randomUUID();
    await f.db`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at) values(${id},${t.target.organizationId},${t.target.workspaceId},${t.target.subjectId},'Synthetic M5','macos-arm64',2,array['local.fs.read'],${createHash('sha256').update(id).digest('hex')},now()-interval '5 minutes')`;
    await f.db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities,metadata) values(${targetId},${t.target.organizationId},${t.target.workspaceId},${`bridge.${id}`},'rice_bridge','Synthetic M5','offline','["local.browser.workspace"]',${f.db.json({ bridgeDeviceId: id })})`;
    await f.db`insert into allrice_bridge_folder_grants(id,organization_id,workspace_id,owner_id,device_id,label,root_fingerprint) values(${folder},${t.target.organizationId},${t.target.workspaceId},${t.target.subjectId},${id},'Test folder',${'a'.repeat(64)})`;
    return { id, folder };
  }
  it('edits the actual admission quota with CAS, audit and reset; never upgrades the member', async () => {
    const t = await setup(),
      before = await getAdminTenantQuotas(t.admin.context, t.target, f.db),
      q = before.quotas.find((q) => q.scope === 'user')!;
    const input = {
      workspaceId: t.target.workspaceId,
      subjectId: t.target.subjectId,
      scope: 'user',
      expectedVersion: q.version,
      limits: { ...q.effective, monthlyTokenLimit: 5000000 },
      reason: 'Synthetic approved five million quota',
    };
    const results = await Promise.allSettled([
      updateAdminTenantQuota(
        t.admin.context,
        t.target.organizationId,
        input,
        f.db,
      ),
      updateAdminTenantQuota(
        t.admin.context,
        t.target.organizationId,
        input,
        f.db,
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      await getUserMonthlyQuota(t.user.context, t.target.workspaceId, f.db),
    ).toMatchObject({ monthlyTokenLimit: 5000000 });
    const resource = await resourceStatus(
      {
        organizationId: t.target.organizationId,
        workspaceId: t.target.workspaceId,
        scope: 'user',
        scopeId: t.target.subjectId,
      },
      f.db,
    );
    expect(() =>
      assertModelResourceAvailable({
        resources: [resource],
        requestedTokens: 5000001,
        requestedRuntimeMs: 1000,
      }),
    ).toThrow('MODEL_TOKEN_QUOTA_EXCEEDED');
    const [audit] =
      await f.db`select actor_id,metadata from allrice_audit_events where action='tenant.quota.updated' and resource_id=${t.target.subjectId}`;
    expect(audit).toMatchObject({
      actor_id: t.admin.user.id,
      metadata: {
        targetUserId: t.target.subjectId,
        ledgerChanged: false,
        officialQuotaChanged: false,
      },
    });
    expect(
      await f.db`select id from allrice_memberships where organization_id=${t.target.organizationId} and user_id=${t.admin.user.id}`,
    ).toHaveLength(0);
    const current = (
      await getAdminTenantQuotas(t.admin.context, t.target, f.db)
    ).quotas.find((q) => q.scope === 'user')!;
    await updateAdminTenantQuota(
      t.admin.context,
      t.target.organizationId,
      { ...input, expectedVersion: current.version, limits: null },
      f.db,
    );
    expect(
      await getUserMonthlyQuota(t.user.context, t.target.workspaceId, f.db),
    ).toMatchObject({ monthlyTokenLimit: 2000000 });
  });
  it('keeps the same user limits separate across tenants, and preserves cost controls on organization update', async () => {
    const t = await setup();
    await f.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${t.other.organizationId},${t.other.workspaceId},${t.target.subjectId},'member')`;
    const snap = await getAdminTenantQuotas(t.admin.context, t.target, f.db),
      user = snap.quotas.find((q) => q.scope === 'user')!;
    await updateAdminTenantQuota(
      t.admin.context,
      t.target.organizationId,
      {
        workspaceId: t.target.workspaceId,
        subjectId: t.target.subjectId,
        scope: 'user',
        expectedVersion: null,
        limits: { ...user.effective, monthlyTokenLimit: 5000000 },
        reason: 'Only this tenant quota',
      },
      f.db,
    );
    const other = {
      organizationId: t.other.organizationId,
      workspaceId: t.other.workspaceId,
      subjectId: t.target.subjectId,
    };
    expect(
      (await getAdminTenantQuotas(t.admin.context, other, f.db)).quotas.find(
        (q) => q.scope === 'user',
      )?.effective.monthlyTokenLimit,
    ).toBe(2000000);
    await f.db`insert into allrice_organization_model_quotas(organization_id,monthly_cost_limit_cents) values(${t.target.organizationId},123)`;
    const org = (await getAdminTenantQuotas(t.admin.context, t.target, f.db))
      .quotas[0]!;
    await updateAdminTenantQuota(
      t.admin.context,
      t.target.organizationId,
      {
        workspaceId: t.target.workspaceId,
        subjectId: t.target.subjectId,
        scope: 'organization',
        expectedVersion: org.version,
        limits: { ...org.effective, monthlyTokenLimit: 20000000 },
        reason: 'Keep subscription cost accounting',
      },
      f.db,
    );
    expect(
      (
        await f.db`select monthly_cost_limit_cents from allrice_organization_model_quotas where organization_id=${t.target.organizationId}`
      )[0]?.monthly_cost_limit_cents,
    ).toBe('123');
  });
  it('uses cache-inclusive receipts; unknown is not zero and old periods are excluded', async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const t = await setup(),
      a = await assistantFixture(f.db),
      target = {
        organizationId: a.context.organizationId,
        workspaceId: a.context.workspaceId!,
        subjectId: a.context.actor.id,
      };
    const [employee] =
      await f.db`select id from allrice_employees where workspace_id=${target.workspaceId}`;
    for (const [old, known] of [
      [false, true],
      [false, false],
      [true, true],
    ] as const) {
      const id = randomUUID();
      await f.db`insert into allrice_route_decisions(id,organization_id,workspace_id,actor_id,employee_id,run_id,input_checksum,candidates,selected_kind,selected_candidate_id,harness,provider,model,generation,attempt,reason_codes,created_at)
      values(${id},${target.organizationId},${target.workspaceId},${target.subjectId},${employee!.id},${a.task.runId},${`sha256:${'a'.repeat(64)}`},'[]','direct','synthetic','dsh','openai-compatible','synthetic',1,${old ? 3 : known ? 1 : 2},'[]',now())`;
      await f.db`insert into allrice_model_usage_ledger(id,organization_id,workspace_id,route_decision_id,status,input_tokens,cached_input_tokens,output_tokens,cost_cents,usage_complete,cache_usage_known,occurred_at) values(${randomUUID()},${target.organizationId},${target.workspaceId},${id},'succeeded',200,150,10,null,${known},${known},case when ${old} then date_trunc('month',now())-interval '1 second' else now() end)`;
    }
    const row = (
      await getAdminTenantQuotas(t.admin.context, target, f.db)
    ).quotas.find((q) => q.scope === 'user')!;
    expect(row).toMatchObject({
      usedTokens: 420,
      cachedInputTokens: null,
      unknownUsageRuns: 1,
      reservedTokens: 0,
    });
  });
  it('rejects non-platform administrators, stale issuer sessions and mismatched subjects before disclosure or writes', async () => {
    const t = await setup();
    await expect(
      getAdminTenantQuotas(t.user.context, t.target, f.db),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      getAdminTenantEnvironments(
        t.admin.context,
        { ...t.target, subjectId: t.other.user.id },
        f.db,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      getAdminTenantEnvironments(
        t.admin.context,
        { ...t.target, workspaceId: t.other.workspaceId },
        f.db,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await revokeSession(t.admin.session.token);
    await expect(
      getAdminTenantQuotas(t.admin.context, t.target, f.db),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });
  it('lists independent prerequisites and grants cloud without Bridge; revokes even when execution is off', async () => {
    const t = await setup(),
      id = await cloudTarget(t);
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
    const before = await getAdminTenantEnvironments(
        t.admin.context,
        t.target,
        f.db,
      ),
      local = before.prerequisites.find((a) => a[0]?.id === 'local_command')!;
    expect(local.map((r) => r.reason)).toEqual(
      expect.arrayContaining([
        'employee_missing',
        'policy_missing',
        'bridge_missing',
        'folder_missing',
        'runner_missing',
      ]),
    );
    const grantInput = {
      workspaceId: t.target.workspaceId,
      subjectId: t.target.subjectId,
      action: 'cloud_grant',
      targetId: id,
      reason: 'Synthetic cloud grant without device',
    };
    const result = await mutateAdminTenantEnvironment(
      t.admin.context,
      t.target.organizationId,
      grantInput,
      f.db,
    );
    expect(result.devices).toEqual([]);
    expect(result.grants[0]).toMatchObject({
      kind: 'cloud',
      ownerId: t.target.subjectId,
      enabled: true,
    });
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '0');
    await mutateAdminTenantEnvironment(
      t.admin.context,
      t.target.organizationId,
      {
        workspaceId: t.target.workspaceId,
        subjectId: t.target.subjectId,
        action: 'revoke',
        kind: 'cloud',
        grantId: result.grants[0]!.id,
        expectedVersion: 1,
        reason: 'Revoke despite execution flag disabled',
      },
      f.db,
    );
    expect(
      (await getAdminTenantEnvironments(t.admin.context, t.target, f.db))
        .grants[0]?.enabled,
    ).toBe(false);
  });
  it('distinguishes unused approval expiry without changing grants, replaying tasks or exposing another owner', async () => {
    const t = await setup(),
      runId = randomUUID(),
      otherRunId = randomUUID();
    for (const [id, owner] of [
      [runId, t.target.subjectId],
      [otherRunId, t.other.user.id],
    ]) {
      await f.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
        values(${id!},${t.target.organizationId},${t.target.workspaceId},${owner!},'running','{}','{}')`;
    }
    const expiredId = randomUUID();
    for (const [id, run, owner] of [
      [expiredId, runId, t.target.subjectId],
      [randomUUID(), otherRunId, t.other.user.id],
    ]) {
      await f.db`insert into allrice_approval_requests(id,organization_id,workspace_id,run_id,actor_id,
        resource_type,resource_id,action,input_digest,requested_at,runtime_request,runtime_binding_digest,runtime_control_version,runtime_expires_at)
        values(${id!},${t.target.organizationId},${t.target.workspaceId},${run!},${owner!},'runtime_operation',${randomUUID()},'process.execute',${`sha256:${'a'.repeat(64)}`},
          now()-interval '2 hours','{}',${`sha256:${'b'.repeat(64)}`},1,now()-interval '1 hour')`;
    }
    const result = await getAdminTenantEnvironments(
      t.admin.context,
      t.target,
      f.db,
    );
    expect(result.approvalDiagnostics).toEqual([
      expect.objectContaining({ id: expiredId, runId, state: 'expired' }),
    ]);
    expect(result.approvalDiagnosticsTruncated).toBe(false);
    expect(result.grants).toEqual([]);
    const [unchanged] =
      await f.db`select status,runtime_consumed_at from allrice_approval_requests where id=${expiredId}`;
    expect(unchanged).toMatchObject({
      status: 'pending',
      runtime_consumed_at: null,
    });
    await f.db`update allrice_approval_requests set runtime_expires_at=now()+interval '1 hour' where id=${expiredId}`;
    expect(
      (await getAdminTenantEnvironments(t.admin.context, t.target, f.db))
        .approvalDiagnostics[0]?.state,
    ).toBe('pending');
    await f.db`update allrice_runs set state='succeeded' where id=${runId}`;
    expect(
      (await getAdminTenantEnvironments(t.admin.context, t.target, f.db))
        .approvalDiagnostics,
    ).toEqual([]);
  });
  it('local browser platform grants retain the actual device owner and never create local folder consent', async () => {
    const t = await setup(),
      d = await device(t);
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_BROWSER_CONTROL_ENABLED', '1');
    vi.stubEnv('ALLRICE_LOCAL_BROWSER_ENABLED', '1');
    const result = await mutateAdminTenantEnvironment(
      t.admin.context,
      t.target.organizationId,
      {
        workspaceId: t.target.workspaceId,
        subjectId: t.target.subjectId,
        action: 'local_browser_grant',
        deviceId: d.id,
        profile: { version: 1, origins: ['https://example.com'] },
        reason: 'Platform browser bounds only',
      },
      f.db,
    );
    expect(result.devices[0]?.status).toBe('offline');
    expect(result.grants[0]).toMatchObject({
      ownerId: t.target.subjectId,
      deviceId: d.id,
      kind: 'local_browser',
    });
    const [audit] =
      await f.db`select actor_id,metadata from allrice_audit_events where action='local.browser.grant.installed' and resource_id=${result.grants[0]!.id}`;
    expect(audit).toMatchObject({
      actor_id: t.admin.user.id,
      metadata: {
        ownerId: t.target.subjectId,
        deviceOptInChanged: false,
        persistLogin: false,
      },
    });
    expect(
      await f.db`select id from allrice_bridge_folder_grants where device_id=${d.id}`,
    ).toHaveLength(1);
    const other = { ...t.target, subjectId: t.other.user.id };
    await expect(
      getAdminTenantEnvironments(t.admin.context, other, f.db),
    ).rejects.toMatchObject({ code: 'not_found' });
    vi.stubEnv('ALLRICE_LOCAL_BROWSER_ENABLED', '0');
    await mutateAdminTenantEnvironment(
      t.admin.context,
      t.target.organizationId,
      {
        workspaceId: t.target.workspaceId,
        subjectId: t.target.subjectId,
        action: 'revoke',
        kind: 'local_browser',
        grantId: result.grants[0]!.id,
        expectedVersion: 1,
        reason: 'Request device profile cleanup',
      },
      f.db,
    );
    expect(
      (await getAdminTenantEnvironments(t.admin.context, t.target, f.db))
        .grants[0],
    ).toMatchObject({
      enabled: false,
      cleanupRequested: true,
      cleanupConfirmed: false,
    });
  });
  it('reuses encrypted cloud MCP credentials, pins concurrent tool grants and audits the real issuer', async () => {
    const t = await setup(),
      administration = {
        ...t.target,
        issuer: t.admin.context,
        reason: 'Synthetic cloud MCP management',
      },
      options = {
        database: f.db,
        credentialKey: 'ab'.repeat(32),
        administration,
      },
      store = createMcpStore(options),
      secret = 'synthetic-never-expose-token';
    const c = await store.create(t.admin.context, {
      workspaceId: t.target.workspaceId,
      name: 'MCP fixture',
      endpoint: 'https://example.com/mcp',
      bearerToken: secret,
    });
    await store.queueDiscovery(t.admin.context, {
      workspaceId: t.target.workspaceId,
      connectionId: c.id,
    });
    const lease = await store.claimDiscovery(randomUUID());
    expect(lease?.connectionId).toBe(c.id);
    await store.completeDiscovery(lease!, {
      tools: [
        {
          name: 'records.list',
          description: 'Synthetic read',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          outputSchema: null,
        },
      ],
    });
    const current = (
        await store.list(t.admin.context, t.target.workspaceId)
      )[0]!,
      tool = current.tools[0]!;
    const managed = createMcpStore({
      ...options,
      administration: {
        ...administration,
        expectedConnection: {
          id: c.id,
          revision: current.revision,
          toolRevisionId: tool.revisionId,
          toolGrantRevision: tool.grantRevision,
        },
      },
    });
    const grant = {
      workspaceId: t.target.workspaceId,
      connectionId: c.id,
      revisionId: tool.revisionId,
      allowed: true,
      risk: 'read_only',
    };
    await managed.grant(t.admin.context, grant);
    await expect(managed.grant(t.admin.context, grant)).rejects.toMatchObject({
      code: 'MCP_BINDING_CHANGED',
    });
    const audits =
      await f.db`select actor_id,metadata from allrice_audit_events where resource_id=${c.id}`;
    expect(audits.every((a) => a.actor_id === t.admin.user.id)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(secret);
    expect(JSON.stringify(current)).not.toContain(secret);
    await expect(
      store.list(t.user.context, t.target.workspaceId),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });
  it('registers local MCP using only the selected owner existing folder grant, not platform-owned device authority', async () => {
    const t = await setup(),
      d = await device(t);
    for (const flag of [
      'ALLRICE_LOCAL_MCP_ENABLED',
      'ALLRICE_LOCAL_COMMAND_ENABLED',
      'ALLRICE_RUNTIME_POLICY_ENABLED',
      'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
    ])
      vi.stubEnv(flag, '1');
    const source = {
      name: 'test-mcp',
      version: '1.0.0',
      entrypoint: 'server.cjs',
      files: [{ path: 'server.cjs', sha256: `sha256:${'b'.repeat(64)}` }],
    };
    const store = createLocalMcpStore({
      database: f.db,
      administration: {
        ...t.target,
        issuer: t.admin.context,
        reason: 'Device-owned MCP configuration',
      },
    });
    const c = await store.create(t.admin.context, {
      workspaceId: t.target.workspaceId,
      name: 'Local MCP',
      deviceId: d.id,
      folderGrantId: d.folder,
      configuration: {
        path: '.',
        source: { ...source, digest: runtimePolicyDigest(source) },
        credential: null,
      },
    });
    expect(c).toMatchObject({
      deviceId: d.id,
      credentialStorage: 'device_only',
    });
    expect(
      (
        await f.db`select owner_id from allrice_local_mcp_config where binding_id=${c.id}`
      )[0]?.owner_id,
    ).toBe(t.target.subjectId);
    const [audit] =
      await f.db`select actor_id,metadata from allrice_audit_events where resource_id=${c.id} and action='local_mcp.register'`;
    expect(audit).toMatchObject({
      actor_id: t.admin.user.id,
      metadata: { targetUserId: t.target.subjectId, deviceId: d.id },
    });
    await expect(
      store.create(t.admin.context, {
        workspaceId: t.target.workspaceId,
        name: 'Unowned',
        deviceId: d.id,
        folderGrantId: randomUUID(),
        configuration: c.configuration,
      }),
    ).rejects.toMatchObject({ code: 'MCP_DENIED' });
  });
});
