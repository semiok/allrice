import {
  TenantEnvironmentMutationSchema,
  CloudExecutionProfileSchema,
  cloudBackendV1,
  cloudToolchainImageV1,
  type AdminTenantEnvironments,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  requireTenantManagementScope,
  type TenantManagementTarget,
} from './tenant-management-scope.ts';
import { getAdminWorkspaceReadiness } from './workspace-readiness.ts';
import { projectWorkspacePrerequisites } from './workspace-readiness-projector.ts';
import { listBridgeDevices } from './bridge.ts';
import {
  installCloudExecutionGrant,
  cloudExecutionEnabled,
} from './cloud-execution.ts';
import {
  installBrowserControlGrant,
  revokeBrowserControlGrant,
  browserControlEnabled,
} from './browser-control.ts';
import {
  installLocalBrowserGrant,
  revokeLocalBrowserGrant,
} from './local-browser-grants.ts';
import { RuntimePolicyError } from './runtime-policy.ts';
type GrantRow = {
  id: string;
  target_id: string;
  owner_id: string;
  version: number;
  enabled: boolean;
  revoked_at: Date | null;
  profile: unknown;
  transport?: string;
  device_id?: string;
  cleanup_requested_at?: Date;
  cleanup_confirmed_at?: Date;
};

export async function getAdminTenantEnvironments(
  context: RequestContext,
  target: TenantManagementTarget,
  db = getDatabase(),
): Promise<AdminTenantEnvironments> {
  await requireTenantManagementScope(context, target, db);
  const { facts, readiness } = await getAdminWorkspaceReadiness(
    context,
    target,
    db,
  );
  const { organizationId, workspaceId, subjectId } = target;
  const targets = await db<
    {
      id: string;
      label: string;
      kind: string;
      state: string;
      capabilities: string[];
    }[]
  >`select id,label,kind,state,capabilities from allrice_execution_targets where organization_id=${organizationId} and workspace_id=${workspaceId} and kind='cloud_sandbox' order by label,id`;
  const cloud = await db<
    GrantRow[]
  >`select id,target_id,owner_id,version,enabled,revoked_at,profile from allrice_cloud_execution_grants where organization_id=${organizationId} and workspace_id=${workspaceId} and owner_id=${subjectId} order by created_at desc limit 100`;
  const browser = await db<
    GrantRow[]
  >`select g.id,g.target_id,g.owner_id,g.version,g.enabled,g.revoked_at,g.profile,g.transport,l.device_id,l.cleanup_requested_at,l.cleanup_confirmed_at from allrice_browser_control_grants g
    left join allrice_local_browser_grants l on l.grant_id=g.id and l.purpose='public'
    where g.organization_id=${organizationId} and g.workspace_id=${workspaceId} and g.owner_id=${subjectId} and (g.transport='cloud' or l.grant_id is not null) order by g.created_at desc limit 100`;
  // Exact, unused operation approvals are separate from persistent environment
  // grants. Read only: an expired approval neither disables the capability nor
  // authorizes a retry, and historical completed Runs must not look blocked.
  const approvals = await db<
    {
      id: string;
      run_id: string;
      runtime_expires_at: Date;
      effective_state: AdminTenantEnvironments['approvalDiagnostics'][number]['state'];
    }[]
  >`select a.id,a.run_id,a.runtime_expires_at,
    case when a.runtime_revoked_at is not null then 'revoked'
      when a.status='rejected' then 'rejected'
      when a.status='expired' or a.runtime_expires_at<=now() then 'expired'
      else a.status end as effective_state
    from allrice_approval_requests a join allrice_runs r
      on r.id=a.run_id and r.organization_id=a.organization_id and r.workspace_id=a.workspace_id
    where a.organization_id=${organizationId} and a.workspace_id=${workspaceId}
      and a.actor_id=${subjectId} and r.owner_id=${subjectId}
      and r.state in ('created','queued','running','waiting_approval')
      and a.resource_type='runtime_operation' and a.runtime_consumed_at is null
    order by a.requested_at desc,a.id limit 101`;
  return {
    ...target,
    observedAt: readiness.observedAt,
    prerequisites: projectWorkspacePrerequisites(facts),
    devices: await listBridgeDevices(context, workspaceId, db, target),
    targets: [...targets],
    nativeConsent: 'confirm_on_device',
    approvalDiagnostics: approvals.slice(0, 100).map((a) => ({
      id: a.id,
      runId: a.run_id,
      expiresAt: a.runtime_expires_at.toISOString(),
      state: a.effective_state,
    })),
    approvalDiagnosticsTruncated: approvals.length > 100,
    grants: [
      ...cloud.map((r) => ({ ...r, kind: 'cloud' as const })),
      ...browser.map((r) => ({
        ...r,
        kind:
          r.transport === 'local'
            ? ('local_browser' as const)
            : ('browser' as const),
      })),
    ].map((r) => ({
      id: r.id as string,
      targetId: r.target_id as string,
      ownerId: r.owner_id as string,
      deviceId: (r.device_id as string) ?? null,
      kind: r.kind,
      version: r.version as number,
      enabled: !!r.enabled && !r.revoked_at,
      revokedAt: r.revoked_at ? (r.revoked_at as Date).toISOString() : null,
      profile: r.profile,
      cleanupRequested: !!r.cleanup_requested_at,
      cleanupConfirmed: !!r.cleanup_confirmed_at,
    })),
  };
}

export async function mutateAdminTenantEnvironment(
  context: RequestContext,
  organizationId: string,
  raw: unknown,
  db = getDatabase(),
) {
  const input = TenantEnvironmentMutationSchema.parse(raw),
    target = {
      organizationId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
    };
  await requireTenantManagementScope(context, target, db);
  const administration = { ...target, issuer: context, reason: input.reason };
  if (input.action === 'cloud_grant') {
    if (!cloudExecutionEnabled())
      throw new RuntimePolicyError('runtime_policy_disabled');
    await installCloudExecutionGrant(
      context,
      {
        targetId: input.targetId,
        ownerId: input.subjectId,
        enabled: true,
        profile: CloudExecutionProfileSchema.parse({
          backend: cloudBackendV1,
          imageDigest: cloudToolchainImageV1,
          architecture: 'amd64',
          runtime: 'runsc',
          runtimeVersion: 'release-20260831.0',
          runtimeChecksum:
            'sha256:1a4995a70b3c8b7d36f55d7d2dc6d15185ebe420de653b1a330b42d36c0e6b4a',
          network: 'none',
          maximumConcurrency: 1,
        }),
      },
      db,
      administration,
    );
  } else if (input.action === 'browser_grant') {
    if (!browserControlEnabled())
      throw new RuntimePolicyError('browser_control_disabled');
    await installBrowserControlGrant(
      context,
      {
        targetId: input.targetId,
        ownerId: input.subjectId,
        enabled: true,
        profile: input.profile,
      },
      db,
      administration,
    );
  } else if (input.action === 'local_browser_grant') {
    // Platform grant does not alter the device's opt-in file or personal Chrome.
    await installLocalBrowserGrant(
      context,
      { deviceId: input.deviceId, profile: input.profile, persistLogin: false },
      db,
      administration,
    );
  } else if (input.kind === 'browser')
    await revokeBrowserControlGrant(context, input.grantId, db, {
      ...administration,
      expectedVersion: input.expectedVersion,
    });
  else if (input.kind === 'local_browser')
    await revokeLocalBrowserGrant(context, input.grantId, db, {
      ...administration,
      expectedVersion: input.expectedVersion,
    });
  else
    await db.begin(async (tx) => {
      await requireTenantManagementScope(context, target, tx);
      const [grant] =
        await tx`update allrice_cloud_execution_grants set enabled=false,revoked_at=clock_timestamp() where id=${input.grantId} and organization_id=${organizationId} and workspace_id=${input.workspaceId} and owner_id=${input.subjectId} and version=${input.expectedVersion} and enabled and revoked_at is null returning id`;
      if (!grant) throw new RuntimePolicyError('cloud_grant_unavailable');
      await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata) values(${organizationId},${input.workspaceId},${context.actor.id},'cloud.grant.revoked','cloud_grant',${input.grantId},'recorded',${input.reason},${tx.json({ ownerId: input.subjectId, physicalStopConfirmed: false })})`;
    });
  return getAdminTenantEnvironments(context, target, db);
}
