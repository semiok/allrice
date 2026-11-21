import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TransactionSql } from 'postgres';
import {
  DEntryIdentitySchema,
  DEntrySelectionInputSchema,
  UuidSchema,
  sameDEntryIdentity,
  selectDEntryGeneration,
  type DEntryIdentity,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { requireDEntryNativeIdentity } from './d-entry.ts';
import { readDEntryReleasePolicy } from './d-entry-release-policy.ts';
import { resolveEmployeeSessionInstance } from './employees/employee-instances.ts';

const hostSchema = z
  .object({
    binding: z
      .object({
        organizationId: UuidSchema,
        personId: UuidSchema,
        vmId: z.string().min(1),
        instanceId: z.string().min(1),
        leaseEpoch: z.number().int().positive(),
      })
      .strict(),
    bindingRef: z.string().min(1),
    rosterDigest: z.string().min(1),
  })
  .strict();
const claimSchema = z
  .object({
    schemaVersion: z.literal(1),
    identity: DEntryIdentitySchema.extend({ threadId: UuidSchema }),
    host: hostSchema,
    operationId: UuidSchema,
    releaseRevision: z.string().min(1),
  })
  .strict();
const pinSchema = claimSchema.extend({ nativeSessionId: z.string().min(1) });
/** Trusted host invocation result, never HTTP JSON. The owner must issue it
 * only from the actual generated session/create reply on its exact profile.
 * Temporary binding is immutable birth provenance, not a current lease grant. */
export type DEntryNativeRootCreation = Readonly<{
  nativeSessionId: string;
  host: z.infer<typeof hostSchema>;
}>;
const deny = (): never => {
  throw new DataAccessError('authorization_denied');
};
type Sql = ReturnType<typeof getDatabase>;

function projectPin(raw: unknown, identity: DEntryIdentity) {
  const pin = pinSchema.parse(raw);
  const birth = pin.identity;
  // Revision/version/release/instance/epoch at birth remain provenance. Current
  // employee authority is resolved separately; a restart never rewrites this
  // persistent employee-profile/native-root identity.
  if (
    !(
      [
        'organizationId',
        'workspaceId',
        'personId',
        'employeeInstanceId',
        'threadId',
      ] as const
    ).every((key) => birth[key] === identity[key]) ||
    pin.host.binding.organizationId !== identity.organizationId ||
    pin.host.binding.personId !== identity.personId
  )
    return deny();
  return {
    identity,
    rootNativeSessionId: pin.nativeSessionId,
    rootOriginDigest:
      'sha256:' +
      createHash('sha256').update(JSON.stringify(pin)).digest('hex'),
    rootBindingRef: pin.operationId,
    vmId: pin.host.binding.vmId,
  };
}
async function readPin(sql: Sql | TransactionSql, identity: DEntryIdentity) {
  const [row] = await sql`select d_entry_native_root from allrice_chat_sessions
    where id=${identity.threadId} and organization_id=${identity.organizationId}
      and workspace_id=${identity.workspaceId} and owner_id=${identity.personId}
      and coalesce(employee_instance_id,employee_assignment_id)=${identity.employeeInstanceId}
      and execution_generation='4.0' and archived_at is null`;
  if (!row) return deny();
  return row.d_entry_native_root == null
    ? null
    : projectPin(row.d_entry_native_root, identity);
}

/** Pure current-authority read; no catalog root selection, boot or repair. */
export async function getDEntryNativeRootPin(
  context: RequestContext,
  input: unknown,
) {
  const identity = await requireDEntryNativeIdentity(context, input);
  if (!identity.threadId) return deny();
  const pin = await readPin(getDatabase(), identity);
  if (!pin) throw Error('NATIVE_QUERY_BINDING_UNAVAILABLE');
  return pin;
}

/** Host-only storage producer. Commit an immutable at-most-once claim BEFORE
 * dispatch. A missing result is unknown, never permission to create again,
 * including the same operationId after a lost commit/reply ACK. No Agent
 * lifecycle, retry, TTL, Run/Job or recovery policy is introduced. */
export async function ensureDEntryNativeRoot(
  context: RequestContext,
  input: unknown,
  expected: DEntryIdentity,
  creation: {
    operationId: string;
    host: DEntryNativeRootCreation['host'];
    signal: AbortSignal;
    create(signal: AbortSignal): Promise<DEntryNativeRootCreation>;
  },
) {
  const selection = DEntrySelectionInputSchema.extend({
    threadId: UuidSchema,
  }).parse(input);
  const operationId = UuidSchema.parse(creation.operationId);
  const host = hostSchema.parse(creation.host);
  const scope = { ...context, workspaceId: selection.workspaceId };
  const current = await requireDEntryNativeIdentity(scope, selection);
  if (
    !sameDEntryIdentity(current, expected) ||
    host.binding.organizationId !== current.organizationId ||
    host.binding.personId !== current.personId
  )
    return deny();
  const active = creation.signal;
  active.throwIfAborted();
  const identity = await requireDEntryNativeIdentity(scope, selection);
  if (!sameDEntryIdentity(identity, expected)) return deny();
  const existing = await readPin(getDatabase(), identity);
  if (existing) {
    if (existing.vmId !== host.binding.vmId) return deny();
    return existing;
  }
  // Current identity → assignment → instance → Session → release locks.
  // Both short transactions recheck authority; neither holds a business
  // pool slot/identity lock across the native call or its real close join.
  const lockCurrent = async (tx: TransactionSql) => {
    const [before] =
      await tx`select employee_assignment_id from allrice_chat_sessions
  where id=${identity.threadId} and organization_id=${identity.organizationId}
    and workspace_id=${identity.workspaceId} and owner_id=${identity.personId}`;
    if (!before) return deny();
    const instance = await resolveEmployeeSessionInstance(
      scope,
      before.employee_assignment_id,
      identity.employeeInstanceId,
      tx,
    );
    if (
      instance.revision !== identity.employeeRevision ||
      instance.source.employeeVersionId !== identity.employeeVersionId
    )
      return deny();
    const [thread] =
      await tx`select id,d_entry_native_root_claim,d_entry_native_root from allrice_chat_sessions
  where id=${identity.threadId} and organization_id=${identity.organizationId}
    and workspace_id=${identity.workspaceId} and owner_id=${identity.personId}
    and employee_assignment_id=${instance.assignmentId}
    and coalesce(employee_instance_id,employee_assignment_id)=${identity.employeeInstanceId}
    and execution_generation='4.0' and native_root_origin is null and archived_at is null
  for update`;
    if (!thread) return deny();
    const policy = await readDEntryReleasePolicy(tx, true);
    if (selectDEntryGeneration(policy, identity) !== '4.0') return deny();
    active.throwIfAborted();
    return { thread, policy };
  };
  // A begin/COMMIT rejection is not proof of rollback. Never dispatch
  // unless this very transaction's success ACK has reached the caller.
  const claim = await getDatabase().begin(async (tx) => {
    const { thread, policy } = await lockCurrent(tx);
    if (thread.d_entry_native_root_claim != null)
      throw Error('D_ENTRY_ROOT_CREATION_UNCONFIRMED');
    const value = claimSchema.parse({
      schemaVersion: 1,
      identity,
      host,
      operationId,
      releaseRevision: policy.revision,
    });
    const [written] =
      await tx`update allrice_chat_sessions set d_entry_native_root_claim=${tx.json(value)}
      where id=${identity.threadId} and d_entry_native_root_claim is null returning id`;
    if (!written) return deny();
    return value;
  });
  active.throwIfAborted();
  // Only this original callback can supply the actual host creation fact.
  // An equal JSON claim on a later request is NOT a creation receipt.
  const receipt = await creation.create(active);
  active.throwIfAborted();
  if (
    JSON.stringify(hostSchema.parse(receipt.host)) !==
    JSON.stringify(claim.host)
  )
    return deny();
  return getDatabase().begin(async (tx) => {
    const { thread, policy } = await lockCurrent(tx);
    if (thread.d_entry_native_root != null) return deny();
    const pin = pinSchema.parse({
      ...claim,
      nativeSessionId: receipt.nativeSessionId,
    });
    projectPin(pin, identity); // Also binds the receipt's person/organization.
    const [written] =
      await tx`update allrice_chat_sessions set d_entry_native_root=${tx.json(pin)}
  where id=${identity.threadId} and d_entry_native_root is null
    and d_entry_native_root_claim=${tx.json(claim)} returning id`;
    if (!written) return deny();
    await tx`insert into allrice_audit_events
  (organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
  values(${identity.organizationId},${identity.workspaceId},${identity.personId},'d_entry_root.bind',
    'chat_session',${identity.threadId},'recorded','host_native_create',${context.requestId},
    ${tx.json({ operationId, releaseRevision: policy.revision })})`;
    return projectPin(pin, identity);
  });
}
