import { runtimeFeatureEnabled } from '@allrice/contracts';
import {
  BrowserProfileSchema,
  CloudExecutionProfileSchema,
  EmployeeManifestSchema,
  RuntimeLocalCommandProfileSchema,
  RuntimePolicyControlsSchema,
  SessionModelSnapshotSchema,
  UuidSchema,
  WorkspaceReadinessSchema,
  isLocalCommandProfileForPlatform,
  type RequestContext,
} from '@allrice/contracts';
import {
  requireTenantManagementScope,
  type TenantManagementTarget,
} from './tenant-management-scope.ts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { localCommandFeatureEnabled } from './local-command-service.ts';
import { cloudExecutionEnabled } from './cloud-authority.ts';
import { browserControlEnabled } from './browser-control-authority.ts';
import { localBrowserEnabled } from './local-browser-grants.ts';
import { mcpExecutionEnabled } from './mcp-authority.ts';
import { localMcpEnabled } from './local-mcp-connections.ts';
import { assistantRuntimeEnabled } from './assistant-runtime.ts';
import { workbenchEnabled } from './artifact-review.ts';
import { changesetFeatureEnabled } from './changeset-service.ts';
import { mcpEmployeeEligibility } from './mcp-employee-bindings.ts';
import {
  projectWorkspaceReadiness,
  type ReadinessFacts,
} from './workspace-readiness-projector.ts';

/** Read-only, actor-scoped discovery. No provisioning, secret material, network
 * probes, cached-membership authority, mutable grants or execution side effects.
 * Admission must still recheck the actual Run/target/binding/approval. */
async function readWorkspaceReadiness(
  ctx: RequestContext,
  workspaceInput: string,
  sessionInput: string | null,
  db = getDatabase(),
  management?: TenantManagementTarget,
) {
  if (ctx.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  const workspaceId = UuidSchema.parse(workspaceInput);
  const sessionId =
    sessionInput === null ? null : UuidSchema.parse(sessionInput);
  const organizationId = management?.organizationId ?? ctx.organizationId,
    subjectId = management?.subjectId ?? ctx.actor.id;
  return db.begin('isolation level repeatable read read only', async (tx) => {
    if (management) {
      if (management.workspaceId !== workspaceId || sessionId !== null)
        throw new DataAccessError('authorization_denied');
      await requireTenantManagementScope(ctx, management, tx);
    }
    const memberships = await tx<{ role: string }[]>`
      select m.role from allrice_memberships m
      join allrice_users u on u.id=m.user_id and u.status='active'
      join allrice_organizations o on o.id=m.organization_id and o.archived_at is null
      join allrice_workspaces w on w.id=${workspaceId} and w.organization_id=o.id and w.archived_at is null
      where m.organization_id=${organizationId} and m.user_id=${subjectId}
        and m.active and (m.workspace_id is null or m.workspace_id=w.id)`;
    if (!memberships.length) throw new DataAccessError('authorization_denied');
    let assignmentId: string | null = null;
    if (sessionId) {
      const [session] = await tx<{ employee_assignment_id: string | null }[]>`
        select employee_assignment_id from allrice_chat_sessions
        where id=${sessionId} and organization_id=${organizationId} and workspace_id=${workspaceId}
          and owner_id=${subjectId} and archived_at is null`;
      if (!session) throw new DataAccessError('not_found');
      assignmentId = session.employee_assignment_id;
    }
    const [employee] = await tx<{ id: string; manifest: unknown }[]>`
      select v.id,v.manifest from allrice_employee_assignments a
      join allrice_employee_versions v on v.id=a.employee_version_id and v.employee_id=a.employee_id
        and v.organization_id=a.organization_id and v.workspace_id=a.workspace_id
      join allrice_employees e on e.id=a.employee_id and e.status='active'
      where a.organization_id=${organizationId} and a.workspace_id=${workspaceId}
        and a.user_id=${subjectId} and a.active
        and not exists(select 1 from allrice_platform_employee_tenant_assignments d where d.tenant_employee_id=a.employee_id
          and d.organization_id=a.organization_id and d.workspace_id=a.workspace_id and not d.active)
        and (${sessionId}::uuid is null or a.id=${assignmentId})
      order by a.is_default desc,e.name,a.id limit 1`;
    const parsed = EmployeeManifestSchema.safeParse(employee?.manifest);
    const manifest =
      parsed.success && parsed.data.schemaVersion === 2 ? parsed.data : null;
    const [model] = sessionId
      ? await tx<{ snapshot: unknown }[]>`
      select snapshot from allrice_session_model_snapshots where session_id=${sessionId}
        and organization_id=${organizationId} and workspace_id=${workspaceId}`
      : [];
    const modelSnapshot = SessionModelSnapshotSchema.safeParse(model?.snapshot);
    const provider = model
      ? modelSnapshot.success
        ? modelSnapshot.data.provider
        : 'unknown'
      : (manifest?.runtimePolicy.provider ?? 'unknown');
    const [control] = await tx<{ version: number; controls: unknown }[]>`
      select version,controls from allrice_runtime_policy_controls
      where organization_id=${organizationId} and workspace_id=${workspaceId}`;
    const controls = RuntimePolicyControlsSchema.safeParse(control?.controls);
    const devices = await tx<
      {
        id: string;
        platform: string;
        online: boolean;
        folder: boolean;
        target_online: boolean;
        profile: unknown;
        profile_fresh: boolean;
      }[]
    >`
      select d.id,d.platform,
        coalesce(d.last_seen_at between now()-interval '90 seconds' and now(),false) as online,
        exists(select 1 from allrice_bridge_folder_grants g where g.device_id=d.id
          and g.organization_id=d.organization_id and g.workspace_id=d.workspace_id
          and g.owner_id=d.owner_id and g.revoked_at is null) as folder,
        exists(select 1 from allrice_execution_targets t where t.organization_id=d.organization_id
          and t.workspace_id=d.workspace_id and t.target_key='bridge.'||d.id::text
          and t.kind='rice_bridge' and t.state='online') as target_online,
        p.profile,coalesce(p.reported_at between now()-interval '90 seconds' and now(),false) as profile_fresh
      from allrice_bridge_devices d left join allrice_bridge_runtime_profiles p on p.device_id=d.id
        and p.organization_id=d.organization_id and p.workspace_id=d.workspace_id
      where d.organization_id=${organizationId} and d.workspace_id=${workspaceId}
        and d.owner_id=${subjectId} and d.revoked_at is null`;
    const runnerAvailable = (
      d: (typeof devices)[number],
      candidate = false,
    ) => {
      const p = RuntimeLocalCommandProfileSchema.safeParse(d.profile);
      return (
        d.online &&
        d.folder &&
        d.target_online &&
        d.profile_fresh &&
        p.success &&
        p.data.available &&
        (!candidate ||
          p.data.features?.includes('changeset_candidate') === true) &&
        isLocalCommandProfileForPlatform(d.platform, p.data)
      );
    };
    const runner = devices.some((d) => runnerAvailable(d));
    const targets = await tx<
      { id: string; state: string; capabilities: string[]; fresh: boolean }[]
    >`
      select id,state,capabilities,(metadata->>'healthManaged' is distinct from 'true' or coalesce(last_heartbeat_at between clock_timestamp()-interval '120 seconds' and clock_timestamp(),false)) fresh from allrice_execution_targets
      where organization_id=${organizationId} and workspace_id=${workspaceId} and kind='cloud_sandbox'`;
    const cloudGrants = await tx<{ target_id: string; profile: unknown }[]>`
      select target_id,profile from allrice_cloud_execution_grants
      where organization_id=${organizationId} and workspace_id=${workspaceId}
        and owner_id=${subjectId} and enabled and revoked_at is null`;
    const browserGrants = await tx<
      {
        target_id: string;
        profile: unknown;
        transport: string;
        device_id: string | null;
      }[]
    >`
      select g.target_id,g.profile,g.transport,l.device_id from allrice_browser_control_grants g
      left join allrice_local_browser_grants l on l.grant_id=g.id and l.organization_id=g.organization_id
        and l.workspace_id=g.workspace_id and l.owner_id=g.owner_id and l.purpose='public' and l.cleanup_requested_at is null
      where g.organization_id=${organizationId} and g.workspace_id=${workspaceId}
        and g.owner_id=${subjectId} and g.enabled and g.revoked_at is null`;
    function cloudStatus(
      capability: string,
      grants: { target_id: string; profile: unknown }[],
      valid: (p: unknown) => boolean,
    ): ReadinessFacts['cloud'] {
      const candidates = targets.filter(
        (t) =>
          Array.isArray(t.capabilities) && t.capabilities.includes(capability),
      );
      if (!candidates.length) return 'missing';
      const online = candidates.filter((t) => t.state === 'online' && t.fresh);
      if (!online.length) return 'unavailable';
      const own = grants.filter((g) =>
        online.some((t) => t.id === g.target_id),
      );
      if (!own.length) return 'ungranted';
      return own.some((g) => valid(g.profile)) ? 'ready' : 'invalid';
    }
    const localBrowserGrants = browserGrants.filter(
      (g) =>
        g.transport === 'local' && devices.some((d) => d.id === g.device_id),
    );
    const liveBrowser = localBrowserGrants.filter((g) =>
      devices.some((d) => d.id === g.device_id && d.online && d.target_online),
    );
    const connections = await tx<
      {
        transport: string;
        discovery_state: string;
        employee_allowed: boolean;
        tool_allowed: boolean;
        local_ready: boolean;
        local_device_id: string | null;
      }[]
    >`
      select c.transport,c.discovery_state,l.device_id as local_device_id,
        exists(select 1 from allrice_employee_mcp_bindings e where e.connector_binding_id=c.binding_id
          and e.organization_id=c.organization_id and e.workspace_id=c.workspace_id
          and e.employee_version_id=${employee?.id ?? null} and e.enabled) as employee_allowed,
        exists(select 1 from allrice_mcp_tool_grants t where t.binding_id=c.binding_id
          and t.organization_id=c.organization_id and t.workspace_id=c.workspace_id and t.allowed and t.available) as tool_allowed,
        (c.transport='streamable_http' or exists(select 1 from allrice_bridge_devices d
          join allrice_bridge_folder_grants g on g.id=l.folder_grant_id and g.device_id=d.id
            and g.organization_id=d.organization_id and g.workspace_id=d.workspace_id and g.owner_id=d.owner_id
          join allrice_bridge_runtime_profiles p on p.device_id=d.id and p.organization_id=d.organization_id and p.workspace_id=d.workspace_id
          where d.id=l.device_id and d.organization_id=c.organization_id and d.workspace_id=c.workspace_id and d.owner_id=${subjectId}
            and d.revoked_at is null and d.last_seen_at between now()-interval '90 seconds' and now()
            and g.revoked_at is null and g.runtime_generation=l.folder_grant_version
            and p.reported_at between now()-interval '90 seconds' and now() and p.profile->>'available'='true')) as local_ready
      from allrice_mcp_binding_config c join allrice_connector_bindings b on b.id=c.binding_id
        and b.organization_id=c.organization_id and b.workspace_id=c.workspace_id and b.enabled and b.identity_mode='service'
      join allrice_connector_definitions definition on definition.id=b.connector_id
        and definition.organization_id=b.organization_id and definition.workspace_id=b.workspace_id and definition.enabled
      left join allrice_local_mcp_config l on l.binding_id=c.binding_id
        and l.organization_id=c.organization_id and l.workspace_id=c.workspace_id
      where c.organization_id=${organizationId} and c.workspace_id=${workspaceId}
        and (c.transport='streamable_http' or l.owner_id=${subjectId})`;
    function mcpStatus(transport: string): ReadinessFacts['cloudMcp'] {
      const list = connections.filter((c) => c.transport === transport);
      if (!list.length) return 'missing';
      const verified = list.filter((c) => {
        if (c.discovery_state !== 'ready' || !c.local_ready) return false;
        if (transport === 'streamable_http') return true;
        const device = devices.find((d) => d.id === c.local_device_id);
        const profile = RuntimeLocalCommandProfileSchema.safeParse(
          device?.profile,
        );
        return Boolean(
          device?.online &&
          device.target_online &&
          device.profile_fresh &&
          profile.success &&
          profile.data.available &&
          profile.data.features?.includes('local_mcp') &&
          isLocalCommandProfileForPlatform(device.platform, profile.data),
        );
      });
      if (!verified.length) return 'unverified';
      return verified.some((c) => c.employee_allowed && c.tool_allowed)
        ? 'ready'
        : 'ungranted';
    }
    const [time] = await tx<
      { observed_at: Date }[]
    >`select now() as observed_at`;
    const canAdminister = memberships.some((m) => m.role === 'admin');
    const facts: ReadinessFacts = {
      canAdminister,
      canExecute: memberships.some((m) => ['admin', 'member'].includes(m.role)),
      employee: Boolean(manifest),
      tools: manifest?.capabilityBindings.toolNames ?? [],
      capabilities: manifest?.capabilities ?? [],
      deniedCapabilities: manifest?.securityPolicy.deniedCapabilities ?? [],
      provider: provider === 'codex' ? 'openai-codex' : provider,
      controls:
        controls.success && controls.data.version === control?.version
          ? controls.data
          : null,
      governedLocalReads: runtimeFeatureEnabled(
        'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
      ),
      bridge: !devices.length
        ? 'missing'
        : devices.some((d) => d.online)
          ? 'online'
          : 'offline',
      folder: devices.some((d) => d.online && d.folder),
      runner,
      developmentRunner: devices.some((d) => runnerAvailable(d, true)),
      cloud: cloudStatus(
        'process.execute',
        cloudGrants,
        (p) => CloudExecutionProfileSchema.safeParse(p).success,
      ),
      cloudBrowser: cloudStatus(
        'browser.navigate',
        browserGrants.filter((g) => g.transport === 'cloud'),
        (p) => BrowserProfileSchema.safeParse(p).success,
      ),
      localBrowser: !localBrowserGrants.length
        ? 'ungranted'
        : !liveBrowser.length
          ? 'unavailable'
          : liveBrowser.some(
                (g) => BrowserProfileSchema.safeParse(g.profile).success,
              )
            ? 'ready'
            : 'invalid',
      cloudMcp:
        mcpStatus('streamable_http') === 'ready' &&
        !/^[a-f0-9]{64}$/i.test(process.env.ALLRICE_MCP_CREDENTIAL_KEY ?? '')
          ? 'unverified'
          : mcpStatus('streamable_http'),
      localMcp: mcpStatus('local_stdio'),
      cloudMcpPolicy: mcpEmployeeEligibility(employee?.manifest).length === 0,
      localMcpPolicy:
        mcpEmployeeEligibility(employee?.manifest, 'local_stdio').length === 0,
      flags: {
        report: workbenchEnabled(),
        local_files:
          !runtimeFeatureEnabled('ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED') ||
          runtimeFeatureEnabled('ALLRICE_RUNTIME_POLICY_ENABLED'),
        changeset: changesetFeatureEnabled(),
        local_command: localCommandFeatureEnabled(),
        cloud_command: cloudExecutionEnabled(),
        cloud_browser: browserControlEnabled(),
        local_browser: localBrowserEnabled(),
        cloud_mcp: mcpExecutionEnabled(),
        local_mcp: localMcpEnabled(),
        assistants: assistantRuntimeEnabled(),
        development:
          assistantRuntimeEnabled() &&
          workbenchEnabled() &&
          changesetFeatureEnabled() &&
          localCommandFeatureEnabled(),
        boost: false,
        teamwork: false,
      },
    };
    return {
      facts,
      readiness: WorkspaceReadinessSchema.parse({
        schemaVersion: 1,
        organizationId,
        workspaceId,
        viewerId: subjectId,
        sessionId,
        employeeVersionId: employee?.id ?? null,
        observedAt: time!.observed_at.toISOString(),
        canAdminister,
        basis: 'next_task',
        capabilities: projectWorkspaceReadiness(facts),
      }),
    };
  });
}

export async function getWorkspaceReadiness(
  ctx: RequestContext,
  workspaceId: string,
  sessionId: string | null,
  db = getDatabase(),
) {
  return (await readWorkspaceReadiness(ctx, workspaceId, sessionId, db))
    .readiness;
}
export async function getAdminWorkspaceReadiness(
  ctx: RequestContext,
  target: TenantManagementTarget,
  db = getDatabase(),
) {
  return readWorkspaceReadiness(ctx, target.workspaceId, null, db, target);
}
