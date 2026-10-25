import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  BridgeSandboxNetworkGrantRefSchema,
  BridgeSandboxNetworkSettingsSchema,
  SandboxNetworkGrantSchema,
  UpdateBridgeSandboxNetworkSchema,
  UuidSchema,
  runtimeFeatureEnabled,
  runtimeContractEqual,
  type BridgeDevice,
  type BridgeSandboxNetworkGrantRef,
  type EmployeeExecutionSnapshot,
  type RequestContext,
  type RuntimeLocalCommand,
  type RuntimeLocalPythonPayload,
  type RuntimeDataScope,
  type RuntimeContentRef,
  type SandboxNetworkRequest,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { assertAutomaticSandboxNetwork } from './sandbox-network-admission.ts';
import {
  assertRuntimePolicyIdentity,
  RuntimePolicyError,
  runtimePolicyDigest as digest,
} from './runtime-policy.ts';

type Database = ReturnType<typeof getDatabase>;
type Sql = Database | TransactionSql;
type Payload = RuntimeLocalCommand | RuntimeLocalPythonPayload;
type Grant = {
  id: string;
  version: number;
  profile: unknown;
  enabled: boolean;
};

async function ownerTarget(
  tx: TransactionSql,
  context: RequestContext,
  workspaceId: string,
  deviceId: string,
) {
  await assertRuntimePolicyIdentity(tx, {
    ...context,
    workspaceId: UuidSchema.parse(workspaceId),
  });
  const [row] = await tx<{ target_id: string }[]>`
    select t.id as target_id from allrice_bridge_devices d
      join allrice_execution_targets t on t.organization_id=d.organization_id and t.workspace_id=d.workspace_id
        and t.target_key='bridge.'||d.id::text and t.kind='rice_bridge' and t.state<>'revoked'
    where d.id=${UuidSchema.parse(deviceId)} and d.organization_id=${context.organizationId}
      and d.workspace_id=${workspaceId} and d.owner_id=${context.actor.id} and d.revoked_at is null
    for update of d`;
  if (!row) throw new RuntimePolicyError('membership_denied');
  return row.target_id;
}

/** Legacy settings retained only to reconcile operations frozen before automatic
 * admission. The retired HTTP settings endpoint no longer calls this function. */
export async function updateBridgeSandboxNetwork(
  context: RequestContext,
  workspaceId: string,
  deviceId: string,
  input: unknown,
  database: Database = getDatabase(),
) {
  const change = UpdateBridgeSandboxNetworkSchema.parse(input);
  return database.begin(async (tx) => {
    const targetId = await ownerTarget(tx, context, workspaceId, deviceId);
    const [prior] = await tx<
      Grant[]
    >`select id,version,profile,enabled from allrice_bridge_sandbox_network_grants
      where device_id=${deviceId} and organization_id=${context.organizationId} and workspace_id=${workspaceId} and owner_id=${context.actor.id} for update`;
    if ((prior?.version ?? 0) !== change.expectedVersion)
      throw new RuntimePolicyError('bridge_network_settings_conflict');
    const id = prior?.id ?? randomUUID(),
      version = change.expectedVersion + 1;
    await tx`insert into allrice_bridge_sandbox_network_grants(id,organization_id,workspace_id,owner_id,device_id,target_id,version,profile,enabled)
      values(${id},${context.organizationId},${workspaceId},${context.actor.id},${deviceId},${targetId},${version},${tx.json(change.profile)},${change.enabled})
      on conflict(device_id) do update set version=excluded.version,profile=excluded.profile,enabled=excluded.enabled,target_id=excluded.target_id,updated_at=clock_timestamp()
      where allrice_bridge_sandbox_network_grants.id=excluded.id`;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
      values(${context.organizationId},${workspaceId},${context.actor.id},'bridge.sandbox_network.update','bridge_device',${deviceId},'recorded','explicit_device_owner_grant',${tx.json({ grantId: id, version, enabled: change.enabled, profile: change.profile })})`;
    return BridgeSandboxNetworkSettingsSchema.parse({
      version,
      enabled: change.enabled,
      profile: change.profile,
    });
  });
}

export async function getBridgeSandboxNetwork(
  context: RequestContext,
  workspaceId: string,
  deviceId: string,
  database: Database = getDatabase(),
) {
  return database.begin(async (tx) => {
    await ownerTarget(tx, context, workspaceId, deviceId);
    const [row] = await tx<
      Grant[]
    >`select id,version,profile,enabled from allrice_bridge_sandbox_network_grants
      where device_id=${deviceId} and organization_id=${context.organizationId} and workspace_id=${workspaceId} and owner_id=${context.actor.id}`;
    return BridgeSandboxNetworkSettingsSchema.parse(
      row
        ? { version: row.version, enabled: row.enabled, profile: row.profile }
        : { version: 0, enabled: false, profile: null },
    );
  });
}

/** New operations obtain a server-derived, request-specific network decision.
 * No device-owner address form is required. Existing execution/input approvals
 * still bind the exact payload; live device/member authority and risk screening
 * are rechecked on dispatch and heartbeat. Historical manual refs keep their
 * original semantics and can never be upgraded to broader automatic authority. */
export async function resolveBridgeSandboxNetworkGrant(
  sql: Sql,
  device: BridgeDevice,
  request: SandboxNetworkRequest,
  hasInputs: boolean,
  frozen: EmployeeExecutionSnapshot | undefined,
  expected?: BridgeSandboxNetworkGrantRef,
  lock = true,
) {
  if (
    !runtimeFeatureEnabled('ALLRICE_SANDBOX_NETWORK_ENABLED') ||
    !frozen?.capabilitySnapshot.grantedCapabilities.includes(
      'network:outbound',
    ) ||
    (frozen.employee.definition.schemaVersion === 2 &&
      frozen.employee.definition.securityPolicy.deniedCapabilities.includes(
        'network:outbound',
      ))
  )
    throw new RuntimePolicyError('sandbox_network_not_authorized');
  if (!expected || expected.id === device.id) {
    const [target] = await sql<{ id: string }[]>`
      select t.id from allrice_bridge_devices d
      join allrice_execution_targets t on t.organization_id=d.organization_id and t.workspace_id=d.workspace_id
        and t.kind='rice_bridge' and t.target_key='bridge.'||d.id::text and t.state='online'
      where d.id=${device.id} and d.organization_id=${device.organizationId} and d.workspace_id=${device.workspaceId}
        and d.owner_id=${device.ownerId} and d.revoked_at is null
        and exists(select 1 from allrice_memberships m where m.user_id=d.owner_id and m.organization_id=d.organization_id
          and m.active and (m.workspace_id is null or m.workspace_id=d.workspace_id) and m.role in ('admin','member'))
      ${lock ? sql`for share of d,t` : sql``}`;
    if (!target) throw new RuntimePolicyError('sandbox_network_not_authorized');
    const ref = BridgeSandboxNetworkGrantRefSchema.parse({
      id: device.id,
      version: 1,
      digest: digest({
        policy: 'automatic_sandbox_https_v1',
        organizationId: device.organizationId,
        workspaceId: device.workspaceId,
        ownerId: device.ownerId,
        deviceId: device.id,
        targetId: target.id,
        network: request,
      }),
    });
    if (expected && !runtimeContractEqual(ref, expected))
      throw new RuntimePolicyError('sandbox_network_grant_changed');
    await assertAutomaticSandboxNetwork(request);
    return ref;
  }
  // Only a previously frozen legacy operation may still use these retired
  // settings. A new call never creates or expands a manual grant row.
  const [row] = await sql<
    Grant[]
  >`select g.id,g.version,g.profile,g.enabled from allrice_bridge_sandbox_network_grants g
    join allrice_bridge_devices d on d.id=g.device_id and d.organization_id=g.organization_id and d.workspace_id=g.workspace_id and d.owner_id=g.owner_id and d.revoked_at is null
    join allrice_execution_targets t on t.id=g.target_id and t.organization_id=g.organization_id and t.workspace_id=g.workspace_id
      and t.kind='rice_bridge' and t.target_key='bridge.'||d.id::text and t.state='online'
    where g.device_id=${device.id} and g.organization_id=${device.organizationId} and g.workspace_id=${device.workspaceId} and g.owner_id=${device.ownerId}
    ${lock ? sql`for share of g` : sql``}`;
  const profile = SandboxNetworkGrantSchema.safeParse(row?.profile);
  if (
    !row?.enabled ||
    !profile.success ||
    request.origins.some((o) => !profile.data.origins.includes(o))
  )
    throw new RuntimePolicyError('sandbox_network_not_authorized');
  if (hasInputs && !profile.data.allowInputTransfer)
    throw new RuntimePolicyError('sandbox_network_transfer_not_authorized');
  const ref = BridgeSandboxNetworkGrantRefSchema.parse({
    id: row.id,
    version: row.version,
    digest: digest(profile.data),
  });
  if (expected && !runtimeContractEqual(ref, expected))
    throw new RuntimePolicyError('sandbox_network_grant_changed');
  return ref;
}

export function bridgeSandboxHasInputs(payload: Payload) {
  return payload.capability === 'local.python.execute'
    ? payload.arguments.inputs.length > 0
    : payload.arguments.files.length > 0;
}

/** Asset-backed inputs retain their exact existing identities. Local folder
 * files are bound by the command's file checksums, working-directory digest and
 * folder grant; do not invent cloud StorageObject identities for host files. */
export function bridgeSandboxTransferScopes(
  payload: Payload,
): RuntimeDataScope[] {
  if (payload.arguments.network === 'none') return [];
  const network = payload.arguments.network,
    ref = payload.networkGrant!;
  const content: RuntimeContentRef[] =
    payload.capability === 'local.python.execute'
      ? payload.arguments.inputs.map((f) => ({
          kind: 'storage_object',
          id: f.objectId,
          checksum: f.checksum,
        }))
      : payload.arguments.projectSource
        ? [payload.arguments.projectSource.project.snapshot]
        : payload.arguments.candidate
          ? [
              {
                kind: 'artifact',
                id: payload.arguments.candidate.artifactId,
                checksum: payload.arguments.candidate.checksum,
              },
            ]
          : [];
  return content.map((item) => ({
    content: item,
    sourceTargetId: null,
    purpose: 'execution_input',
    destination: 'external_service',
    externalNetwork: network,
    authorizationId: ref.id,
    authorizationVersion: ref.version,
  }));
}

export async function assertBridgeSandboxNetwork(
  sql: Sql,
  device: BridgeDevice,
  payload: Payload,
  frozen: EmployeeExecutionSnapshot | undefined,
  lock = true,
) {
  if (payload.arguments.network === 'none') return;
  if (!payload.networkGrant)
    throw new RuntimePolicyError('sandbox_network_not_authorized');
  await resolveBridgeSandboxNetworkGrant(
    sql,
    device,
    payload.arguments.network,
    bridgeSandboxHasInputs(payload),
    frozen,
    payload.networkGrant,
    lock,
  );
}
