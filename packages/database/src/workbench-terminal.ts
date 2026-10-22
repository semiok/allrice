import { randomUUID } from 'node:crypto';
import {
  BridgeEnvironmentSchema,
  TerminalTargetSchema,
  UuidSchema,
  type RequestContext,
  type TerminalStreamMode,
} from '@allrice/contracts';
import { bridgeDeviceStatus, BridgeDataError } from './bridge.ts';
import { getDatabase } from './core/client.ts';
import {
  assertWorkbenchSession,
  ArtifactReviewError,
} from './artifact-review.ts';
import { DataAccessError } from './data.ts';

/** A human terminal is owned by the signed-in person, independent of Agent
 * execution policy. A folder grant chooses its initial directory, not an OS
 * sandbox. No browser path, owner id or cached membership grants permission. */
export async function resolveWorkbenchTerminalTarget(
  context: RequestContext,
  input: {
    workspaceId: string;
    sessionId: string;
    deviceId: string;
    grantId: string;
  },
  db = getDatabase(),
  { requirePresence = true }: { requirePresence?: boolean } = {},
) {
  const workspaceId = UuidSchema.parse(input.workspaceId);
  const sessionId = UuidSchema.parse(input.sessionId);
  const deviceId = UuidSchema.parse(input.deviceId);
  const grantId = UuidSchema.parse(input.grantId);
  if (
    context.actor.type !== 'user' ||
    !context.sessionId ||
    (context.workspaceId && context.workspaceId !== workspaceId)
  )
    throw new DataAccessError('authorization_denied');
  const principal = { ...context, workspaceId };
  return db.begin(async (tx) => {
    try {
      await assertWorkbenchSession(tx, principal, sessionId, false, 'share');
    } catch (error) {
      if (
        error instanceof ArtifactReviewError &&
        ['identity_denied', 'artifact_not_found'].includes(error.code)
      )
        throw new DataAccessError('not_found');
      throw error;
    }
    const [target] = await tx<
      {
        label: string;
        root_fingerprint: string;
        runtime_generation: number;
        name: string;
        environment: unknown;
        present: boolean;
      }[]
    >`select g.label,g.root_fingerprint,g.runtime_generation,d.name,t.metadata->'environment' as environment,
        (d.last_seen_at<=clock_timestamp() and d.last_seen_at>clock_timestamp()-interval '90 seconds') as present
      from allrice_bridge_devices d
      join allrice_bridge_folder_grants g on g.device_id=d.id and g.organization_id=d.organization_id
        and g.workspace_id=d.workspace_id and g.owner_id=d.owner_id
      left join allrice_execution_targets t on t.organization_id=d.organization_id and t.workspace_id=d.workspace_id
        and t.kind='rice_bridge' and t.target_key='bridge.'||d.id::text
      where d.id=${deviceId} and g.id=${grantId} and d.organization_id=${context.organizationId}
        and d.workspace_id=${workspaceId} and d.owner_id=${context.actor.id}
        and d.revoked_at is null and g.revoked_at is null
        and exists(select 1 from allrice_sessions login where login.id=${context.sessionId}
          and login.user_id=d.owner_id and login.revoked_at is null and login.expires_at>clock_timestamp())
        and exists(select 1 from allrice_memberships m where m.organization_id=d.organization_id and m.user_id=d.owner_id
          and m.active and (m.workspace_id is null or m.workspace_id=d.workspace_id) and m.role in ('member','admin'))
        and exists(select 1 from allrice_chat_sessions chat where chat.id=${sessionId} and chat.organization_id=d.organization_id
          and chat.workspace_id=d.workspace_id and chat.owner_id=d.owner_id and chat.archived_at is null)
      for share of d,g`;
    const environment = BridgeEnvironmentSchema.safeParse(
      target?.environment,
    ).data;
    if (!target || environment?.paused) throw new DataAccessError('not_found');
    // An old/missing heartbeat is absence of availability evidence, not proof
    // that a retained human process was revoked. A device's authenticated
    // revalidation request itself proves current transport reachability.
    if (
      !environment ||
      (environment.humanTerminalVersion !== 1 &&
        environment.humanTerminalVersion !== 2) ||
      (requirePresence && !target.present)
    )
      throw new BridgeDataError('device_offline');
    const streamMode: TerminalStreamMode =
      environment.humanTerminalVersion === 2 ? 'push' : 'pull';
    return {
      target: TerminalTargetSchema.parse({
        organizationId: context.organizationId,
        workspaceId,
        ownerId: context.actor.id,
        loginSessionId: context.sessionId,
        sessionId,
        deviceId,
        grantId,
        grantVersion: target.runtime_generation,
        rootFingerprint: target.root_fingerprint,
        label: target.label,
      }),
      deviceName: target.name,
      streamMode,
    };
  });
}

/** Device-authenticated read-only revalidation also covers detached user
 * terminals. A transport disconnect never impersonates logout/revocation. */
export async function revalidateBridgeTerminalTarget(
  token: string,
  targetInput: unknown,
) {
  const target = TerminalTargetSchema.parse(targetInput);
  const { device } = await bridgeDeviceStatus(token);
  if (
    device.id !== target.deviceId ||
    device.organizationId !== target.organizationId ||
    device.workspaceId !== target.workspaceId ||
    device.ownerId !== target.ownerId
  )
    throw new DataAccessError('not_found');
  const current = await resolveWorkbenchTerminalTarget(
    {
      requestId: randomUUID(),
      sessionId: target.loginSessionId,
      actor: { type: 'user', id: target.ownerId },
      organizationId: target.organizationId,
      workspaceId: target.workspaceId,
      memberships: [],
      authenticatedAt: new Date().toISOString(),
    },
    target,
    getDatabase(),
    { requirePresence: false },
  );
  if (
    Object.keys(target).some(
      (key) =>
        key !== 'label' &&
        target[key as keyof typeof target] !==
          current.target[key as keyof typeof target],
    )
  )
    throw new DataAccessError('not_found');
  return current;
}
