import type { RequestContext } from '@allrice/contracts';

export const PERSON_VM_CONTRACT_VERSION = 1 as const;
export const PERSON_VM_MEMORY_MIB = 2048 as const;
export const PERSON_VM_IDLE_MS = 20 * 60 * 1000;
export const PERSON_VM_COLD_MS = 7 * 24 * 60 * 60 * 1000;

/** Host-only. Never accept this object, or RequestContext, from guest JSON. */
export type PersonVmBinding = Readonly<{
  vmId: string;
  personId: string;
  organizationId: string;
  instanceId: string;
  leaseEpoch: number;
}>;

/** Prepared by MET-269's trusted host provider before ANY native boot. */
export type PersonVmEgressReceipt = Readonly<{
  binding: PersonVmBinding;
  bindingId: string;
  /** Host gateway listeners only. Arbitrary public CIDRs/domains are not accepted. */
  gatewayPorts: readonly number[];
}>;

export interface PersonVmEgressPort {
  prepare(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<PersonVmEgressReceipt>;
  assertActive(
    receipt: PersonVmEgressReceipt,
    signal: AbortSignal,
  ): Promise<void>;
  /** Idempotent for this exact epoch. Revoke external capabilities/routes. */
  revoke(
    receipt: PersonVmEgressReceipt,
    reason: 'stop' | 'failure' | 'takeover' | 'delete',
    signal: AbortSignal,
  ): Promise<void>;
}

export type PersonVmAction =
  'read' | 'create' | 'start' | 'stop' | 'delete' | 'delete-disk';
export interface PersonVmAuthority {
  /** Recheck current server-side identity/membership on EVERY call. */
  authorize(
    context: RequestContext,
    action: PersonVmAction,
    signal: AbortSignal,
  ): Promise<{
    /** Globally stable allrice_users identity, normally context.actor.id. */
    personId: string;
    organizationId: string;
  }>;
}

export type PersonVmActivity = Readonly<{
  binding: PersonVmBinding;
  observedAt: string;
  /** Native facts; unknown/stale/disconnected must never be interpreted as idle. */
  state: 'known' | 'unknown';
  activeTurns: number;
  activeJobs: number;
  activeSubtasks: number;
  pendingApprovals: number;
}>;

export interface PersonVmRuntimePort {
  /** DSH startup/configuration stays with the native runtime owner. */
  start(binding: PersonVmBinding, signal: AbortSignal): Promise<void>;
  activity(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<PersonVmActivity>;
  /** 401/reachable is NOT ready. Must prove authenticated editor + send capability. */
  readiness(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<{
    binding: PersonVmBinding;
    authenticated: boolean;
    editorReady: boolean;
    canSend: boolean;
  }>;
}

export type PersonVmView = Readonly<{
  vmId: string;
  personId: string;
  organizationId: string;
  phase: 'stopped' | 'starting' | 'running' | 'cold' | 'failed' | 'deleted';
  ready: boolean;
  diskRetained: boolean;
  lastActivityAt: string;
  /** No ownerToken, key material, mount paths, or egress credentials. */
}>;

export type PersonVmErrorCode =
  | 'AUTHORIZATION_DENIED'
  | 'ORGANIZATION_CONFLICT'
  | 'LEASE_CONFLICT'
  | 'LEASE_LOST'
  | 'EGRESS_UNAVAILABLE'
  | 'EGRESS_BINDING_INVALID'
  | 'RUNTIME_NOT_READY'
  | 'ACTIVITY_UNKNOWN'
  | 'VM_ACTIVE'
  | 'PROVIDER_FAILED'
  | 'CLEANUP_INCOMPLETE'
  | 'DISK_DELETE_NOT_AUTHORIZED'
  | 'NOT_FOUND';

export class PersonVmError extends Error {
  constructor(
    readonly code: PersonVmErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'PersonVmError';
  }
}

/** Only a trusted server/BFF receives this port. There is no guest MCP restart tool. */
export interface PersonVmPort {
  create(context: RequestContext, signal: AbortSignal): Promise<PersonVmView>;
  start(context: RequestContext, signal: AbortSignal): Promise<PersonVmView>;
  prewarm(
    context: RequestContext,
    input: { trigger: 'page' | 'input' },
    signal: AbortSignal,
  ): Promise<PersonVmView>;
  read(
    context: RequestContext,
    signal: AbortSignal,
  ): Promise<PersonVmView | null>;
  stop(context: RequestContext, signal: AbortSignal): Promise<PersonVmView>;
  /** Default keeps the encrypted disk. Employee deletion must not call this. */
  delete(
    context: RequestContext,
    input: { deleteDisk?: boolean },
    signal: AbortSignal,
  ): Promise<PersonVmView>;
  /** Host gateway only: resolve current authority; never cache as lasting permission. */
  resolve(
    context: RequestContext,
    signal: AbortSignal,
  ): Promise<PersonVmBinding>;
  assertCurrentBinding(
    context: RequestContext,
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<void>;
}

export type PersonVmHoldKind =
  'turn' | 'job' | 'subtask' | 'approval' | 'host-operation';
/** Trusted host orchestration only. No hold/fencing handle is granted to the guest. */
export interface PersonVmHostPort extends PersonVmPort {
  reconcileIdle(
    context: RequestContext,
    signal: AbortSignal,
  ): Promise<PersonVmView>;
  recoverExpired(
    context: RequestContext,
    signal: AbortSignal,
  ): Promise<PersonVmView>;
  acquireHold(
    context: RequestContext,
    binding: PersonVmBinding,
    input: { kind: PersonVmHoldKind; operationId: string },
    signal: AbortSignal,
  ): Promise<string>;
  releaseHold(
    context: RequestContext,
    binding: PersonVmBinding,
    holdId: string,
    signal: AbortSignal,
  ): Promise<void>;
}
