import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  BrowserProfileSchema,
  LocalBrowserRevocationSchema,
  LocalBrowserErrorCodeSchema,
  UuidSchema,
  type BridgeDevice,
  type RequestContext,
} from '@allrice/contracts';
import type postgres from 'postgres';
import { getDatabase } from './core/client.ts';
import {
  requireTenantManagementScope,
  type TenantManagementOptions,
} from './tenant-management-scope.ts';
import { browserIdentity } from './browser-control-authority.ts';
import { browserGrantOriginDenial } from './browser-control-origin.ts';
import {
  RuntimePolicyError,
  runtimePolicyDigest as digest,
  type RuntimePolicyPrincipal,
} from './runtime-policy.ts';

export const localBrowserEnabled = () =>
  process.env.ALLRICE_LOCAL_BROWSER_ENABLED === '1' &&
  process.env.ALLRICE_BROWSER_CONTROL_ENABLED === '1' &&
  process.env.ALLRICE_RUNTIME_POLICY_ENABLED === '1';
export const localBrowserPrincipal = (
  device: BridgeDevice,
): RuntimePolicyPrincipal => ({
  organizationId: device.organizationId,
  workspaceId: device.workspaceId,
  actor: { type: 'user', id: device.ownerId },
  requestId: randomUUID(),
});
export async function assertCurrentLocalBrowserDevice(
  tx: postgres.TransactionSql,
  device: BridgeDevice,
  admit = true,
) {
  if (admit) {
    if (!localBrowserEnabled())
      throw new RuntimePolicyError('local_browser_disabled');
    await browserIdentity(tx, localBrowserPrincipal(device));
  }
  const [row] = await tx`select id from allrice_bridge_devices
    where id=${device.id} and organization_id=${device.organizationId} and workspace_id=${device.workspaceId}
      and owner_id=${device.ownerId} and revoked_at is null for share`;
  if (!row) throw new RuntimePolicyError('local_browser_device_denied');
}

export const LocalBrowserGrantInputSchema = z
  .object({
    deviceId: UuidSchema,
    profile: BrowserProfileSchema,
    persistLogin: z.boolean().default(false),
  })
  .strict();
export const LocalBrowserManagementInstallSchema =
  LocalBrowserGrantInputSchema.extend({ workspaceId: UuidSchema });
export const LocalBrowserManagementRevokeSchema = z
  .object({
    workspaceId: UuidSchema,
    action: z.literal('revoke'),
    grantId: UuidSchema,
  })
  .strict();

/** An administrator can authorize only their own paired device. This grant
 * never implies a folder grant, host shell, personal Chrome or file access. */
export async function installLocalBrowserGrant(
  ctx: RequestContext,
  raw: unknown,
  db = getDatabase(),
  administration?: TenantManagementOptions,
) {
  if (!localBrowserEnabled())
    throw new RuntimePolicyError('local_browser_disabled');
  const input = LocalBrowserGrantInputSchema.parse(raw);
  for (const origin of input.profile.origins) {
    const denial = browserGrantOriginDenial(origin);
    if (denial) throw new RuntimePolicyError(denial);
  }
  const grantId = randomUUID(),
    logicalProfileId = randomUUID();
  const organizationId = administration?.organizationId ?? ctx.organizationId,
    workspaceId = administration?.workspaceId ?? ctx.workspaceId,
    ownerId = administration?.subjectId ?? ctx.actor.id;
  await db.begin(async (tx) => {
    if (administration)
      await requireTenantManagementScope(ctx, administration, tx);
    else await browserIdentity(tx, ctx, true);
    const [device] =
      await tx`select d.id,t.id as target_id from allrice_bridge_devices d
      join allrice_execution_targets t on t.organization_id=d.organization_id and t.workspace_id=d.workspace_id
        and t.target_key='bridge.'||d.id::text and t.kind='rice_bridge' and t.metadata->>'bridgeDeviceId'=d.id::text
      where d.id=${input.deviceId} and d.organization_id=${organizationId} and d.workspace_id=${workspaceId}
        and d.owner_id=${ownerId} and d.revoked_at is null for update of d`;
    if (!device) throw new RuntimePolicyError('local_browser_device_denied');
    const [count] = await tx<
      { n: number }[]
    >`select count(*)::integer as n from allrice_local_browser_grants l
      join allrice_browser_control_grants g on g.id=l.grant_id where l.device_id=${input.deviceId} and l.purpose='public' and g.enabled and g.revoked_at is null`;
    if ((count?.n ?? 0) >= 8)
      throw new RuntimePolicyError('local_browser_grant_limit');
    await tx`insert into allrice_browser_control_grants(id,organization_id,workspace_id,owner_id,target_id,version,profile,enabled,transport)
      values(${grantId},${organizationId},${workspaceId},${ownerId},${device.target_id},1,${tx.json(input.profile)},true,'local')`;
    await tx`insert into allrice_local_browser_grants(grant_id,organization_id,workspace_id,owner_id,device_id,logical_profile_id,persist_login)
      values(${grantId},${organizationId},${workspaceId},${ownerId},${input.deviceId},${logicalProfileId},${input.persistLogin})`;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
      values(${organizationId},${workspaceId},${ctx.actor.id},'local.browser.grant.installed','browser_grant',${grantId},'recorded',${administration?.reason ?? 'explicit_device_browser_grant'},
        ${tx.json({ ownerId, deviceId: input.deviceId, logicalProfileId, profileDigest: digest(input.profile), persistLogin: input.persistLogin, deviceOptInChanged: false })})`;
  });
  return { grantId, grantRevision: 1, logicalProfileId, ...input };
}

export async function listLocalBrowserGrants(
  ctx: RequestContext,
  db = getDatabase(),
) {
  return db.begin(async (tx) => {
    await browserIdentity(tx, ctx, true);
    const rows =
      await tx`select l.grant_id,l.device_id,l.logical_profile_id,l.persist_login,g.version,g.profile,g.enabled,g.revoked_at,
      l.cleanup_requested_at,l.cleanup_confirmed_at,l.cleanup_error_code,d.name as device_name,d.last_seen_at,d.revoked_at as device_revoked_at
      from allrice_local_browser_grants l join allrice_browser_control_grants g on g.id=l.grant_id
      join allrice_bridge_devices d on d.id=l.device_id and d.organization_id=l.organization_id and d.workspace_id=l.workspace_id and d.owner_id=l.owner_id
      where l.organization_id=${ctx.organizationId} and l.workspace_id=${ctx.workspaceId} and l.owner_id=${ctx.actor.id} and l.purpose='public'
      order by l.created_at desc limit 100`;
    return rows.map((r) => ({
      grantId: r.grant_id as string,
      grantRevision: r.version as number,
      deviceId: r.device_id as string,
      deviceName: r.device_name as string,
      logicalProfileId: r.logical_profile_id as string,
      persistLogin: r.persist_login as boolean,
      profile: BrowserProfileSchema.parse(r.profile),
      enabled: Boolean(r.enabled && !r.revoked_at && !r.device_revoked_at),
      cleanupRequested: r.cleanup_requested_at !== null,
      cleanupConfirmed: r.cleanup_confirmed_at !== null,
      cleanupErrorCode: r.cleanup_error_code
        ? LocalBrowserErrorCodeSchema.parse(r.cleanup_error_code)
        : null,
    }));
  });
}

export async function revokeLocalBrowserGrant(
  ctx: RequestContext,
  id: string,
  db = getDatabase(),
  administration?: TenantManagementOptions & { expectedVersion: number },
) {
  return db.begin(async (tx) => {
    const organizationId = administration?.organizationId ?? ctx.organizationId,
      workspaceId = administration?.workspaceId ?? ctx.workspaceId,
      ownerId = administration?.subjectId ?? ctx.actor.id;
    if (administration) {
      await requireTenantManagementScope(ctx, administration, tx);
      const [current] =
        await tx`select id from allrice_browser_control_grants where id=${UuidSchema.parse(id)} and organization_id=${organizationId} and workspace_id=${workspaceId} and owner_id=${ownerId} and version=${administration.expectedVersion} and enabled and revoked_at is null for update`;
      if (!current) throw new RuntimePolicyError('browser_grant_unavailable');
    } else await browserIdentity(tx, ctx, true);
    const [grant] =
      await tx`select l.grant_id from allrice_local_browser_grants l join allrice_browser_control_grants g on g.id=l.grant_id
      where l.grant_id=${UuidSchema.parse(id)} and l.organization_id=${organizationId} and l.workspace_id=${workspaceId}
        and l.owner_id=${ownerId} for update of g,l`;
    if (!grant) throw new RuntimePolicyError('local_browser_grant_denied');
    await tx`update allrice_browser_control_grants set enabled=false,revoked_at=coalesce(revoked_at,clock_timestamp()) where id=${id}`;
    await tx`update allrice_local_browser_grants set cleanup_requested_at=coalesce(cleanup_requested_at,clock_timestamp()) where grant_id=${id}`;
    await tx`update allrice_browser_workspaces set desired_control='closed',state='close_pending',control_fence=control_fence+1
      where grant_id=${id} and state not in ('closed','unknown','close_pending')`;
    // No controller ever received these workspaces: there is no physical
    // browser to stop. Claimed/unknown workspaces still require the exact device.
    await tx`update allrice_browser_workspaces w set state='closed',stopped_at=clock_timestamp()
      from allrice_local_browser_workspaces l where l.browser_workspace_id=w.id and l.grant_id=${id} and l.controller_lease_token is null`;
    await tx`update allrice_local_browser_workspaces set released_at=coalesce(released_at,clock_timestamp()) where grant_id=${id} and controller_lease_token is null`;
    await tx`update allrice_browser_direct_inputs set envelope=null,consumed_at=coalesce(consumed_at,clock_timestamp())
      where browser_workspace_id in(select id from allrice_browser_workspaces where grant_id=${id})`;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
      values(${organizationId},${workspaceId},${ctx.actor.id},'local.browser.grant.revoked','browser_grant',${id},'recorded',${administration?.reason ?? 'stop_and_profile_cleanup_requested'},${tx.json({ ownerId, physicalStopConfirmed: false })})`;
    return { requested: true, cleanupConfirmed: false };
  });
}

export async function pendingLocalBrowserRevocations(
  device: BridgeDevice,
  db = getDatabase(),
) {
  return db.begin(async (tx) => {
    await assertCurrentLocalBrowserDevice(tx, device, false);
    const rows =
      await tx`select l.*,g.version from allrice_local_browser_grants l join allrice_browser_control_grants g on g.id=l.grant_id
      where l.organization_id=${device.organizationId} and l.workspace_id=${device.workspaceId} and l.owner_id=${device.ownerId}
        and l.device_id=${device.id} and (not g.enabled or g.revoked_at is not null)
        and l.cleanup_confirmed_at is null order by l.created_at limit 100`;
    return rows.map((r) =>
      LocalBrowserRevocationSchema.parse({
        version: 1,
        scope: {
          organizationId: device.organizationId,
          workspaceId: device.workspaceId,
          projectId: null,
        },
        ownerId: device.ownerId,
        deviceId: device.id,
        grantId: r.grant_id,
        grantRevision: r.version,
        logicalProfileId: r.logical_profile_id,
      }),
    );
  });
}

export async function acknowledgeLocalBrowserRevocation(
  device: BridgeDevice,
  input: {
    grantId: string;
    grantRevision: number;
    logicalProfileId: string;
    confirmed: boolean;
    errorCode: string | null;
  },
  db = getDatabase(),
) {
  return db.begin(async (tx) => {
    await assertCurrentLocalBrowserDevice(tx, device, false);
    const [grant] =
      await tx`select l.grant_id from allrice_local_browser_grants l join allrice_browser_control_grants g on g.id=l.grant_id
      where l.grant_id=${input.grantId} and g.version=${input.grantRevision} and l.logical_profile_id=${input.logicalProfileId}
        and l.organization_id=${device.organizationId} and l.workspace_id=${device.workspaceId} and l.device_id=${device.id}
        and l.owner_id=${device.ownerId} and (not g.enabled or g.revoked_at is not null) for update of g,l`;
    if (!grant) throw new RuntimePolicyError('local_browser_grant_denied');
    if (input.confirmed) {
      const [active] =
        await tx`select id from allrice_browser_workspaces where grant_id=${input.grantId} and state not in ('closed') limit 1`;
      if (active)
        throw new RuntimePolicyError('local_browser_cleanup_unconfirmed');
    }
    await tx`update allrice_local_browser_grants set cleanup_requested_at=coalesce(cleanup_requested_at,clock_timestamp()),
      cleanup_confirmed_at=case when ${input.confirmed} then coalesce(cleanup_confirmed_at,clock_timestamp()) else cleanup_confirmed_at end,
      cleanup_error_code=${input.confirmed ? null : LocalBrowserErrorCodeSchema.parse(input.errorCode ?? 'LOCAL_BROWSER_CLEANUP_PENDING')}
      where grant_id=${input.grantId}`;
    return { cleanupConfirmed: input.confirmed };
  });
}
