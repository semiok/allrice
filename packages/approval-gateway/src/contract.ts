import type { RequestContext } from '@allrice/contracts';
import type { PersonVmBinding } from '@allrice/person-vm';
import { z } from 'zod';

export const APPROVAL_GATEWAY_CONTRACT_VERSION = 1 as const;
const text = z.string().min(1);
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
export const ApprovalRefSchema = z
  .object({
    requestId: z.string().uuid(),
    version: z.literal(1),
    digest: checksum,
  })
  .strict();
export type ApprovalRef = z.infer<typeof ApprovalRefSchema>;
export const ApprovalAttachmentSchema = z
  .object({ ...ApprovalRefSchema.shape, index: z.number().int().nonnegative() })
  .strict();
/** Opaque exact-version selector interpreted and authorized by its registered owner. */
export const AttachmentSelectionSchema = z
  .object({ module: text, ref: text })
  .strict();
export type AttachmentSelection = z.infer<typeof AttachmentSelectionSchema>;
export const ApprovalStageSchema = z
  .object({
    idempotencyKey: text,
    adapterId: text,
    target: text,
    body: z.string(),
    attachments: z.array(AttachmentSelectionSchema),
  })
  .strict();
export type ApprovalStage = z.infer<typeof ApprovalStageSchema>;
export const ApprovalDecisionSchema = z
  .object({
    ...ApprovalRefSchema.shape,
    decision: z.enum(['approved', 'rejected']),
  })
  .strict();

/** HOST ONLY: resolved from authenticated connection and actual native call owner. */
export type ApprovalBinding = Readonly<{
  vm: PersonVmBinding;
  workspaceId: string | null;
  employeeInstanceId: string;
  employeeRelease: string;
  allriceThreadRef: string;
  runId: string;
  executionId: string;
  executionGeneration: string;
  native: Readonly<{
    instanceId: string;
    profile: string;
    sessionId: string;
    rootSessionId: string;
    parentSessionId: string | null;
    callId: string;
  }>;
}>;
export type FrozenAttachment = Readonly<{
  selection: AttachmentSelection;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  /** Private frozen byte copy, never included in MCP view or diagnostic logs. */
  base64: string;
}>;
export type FrozenPayload = Readonly<{
  adapterId: string;
  actionLabel: string;
  target: Readonly<{ id: string; label: string }>;
  body: string;
  attachments: readonly FrozenAttachment[];
}>;
export type ApprovalRecord = Readonly<{
  ref: ApprovalRef;
  scopeKey: string;
  idempotencyKey: string;
  binding: ApprovalBinding;
  payload: FrozenPayload;
  decision: 'pending' | 'approved' | 'rejected';
  decidedBy: string | null;
  decidedAt: string | null;
  revoked: boolean;
  /** Once intent is durable, neither crash nor timeout may authorize another dispatch. */
  intentAt: string | null;
  receipt: ExternalReceipt | null;
  failure: ApprovalFailure | null;
}>;
export type ExternalReceipt = Readonly<{ id: string; digest: string }>;
export type ApprovalFailure = Readonly<{
  kind:
    | 'CANCELLED'
    | 'DISPATCH_FAILED'
    | 'RECEIPT_INTEGRITY'
    | 'RECEIPT_PERSIST_FAILED';
  code: ApprovalError['code'] | null;
  at: string;
}>;
export type ApprovalView = Readonly<{
  ref: ApprovalRef;
  adapterId: string;
  actionLabel: string;
  target: FrozenPayload['target'];
  body: string;
  attachments: readonly Omit<FrozenAttachment, 'base64'>[];
  decision: ApprovalRecord['decision'];
  revoked: boolean;
  effect: 'not-dispatched' | 'unknown' | 'received';
  receipt: ExternalReceipt | null;
  failure: ApprovalFailure | null;
}>;
export class ApprovalError extends Error {
  constructor(
    readonly code:
      | 'DENIED'
      | 'INVALID_INPUT'
      | 'CONFLICT'
      | 'NOT_CONFIRMED'
      | 'REVOKED'
      | 'UNAVAILABLE'
      | 'INTEGRITY'
      | 'LIMIT_EXCEEDED',
  ) {
    super(code);
    this.name = 'ApprovalError';
  }
}
export interface ApprovalStore {
  stage(record: ApprovalRecord): Promise<ApprovalRecord>;
  get(requestId: string): Promise<ApprovalRecord | null>;
  decide(
    ref: ApprovalRef,
    actorId: string,
    decision: 'approved' | 'rejected',
  ): Promise<ApprovalRecord>;
  revoke(ref: ApprovalRef): Promise<ApprovalRecord>;
  claim(
    ref: ApprovalRef,
  ): Promise<{ claimed: boolean; record: ApprovalRecord }>;
  receive(ref: ApprovalRef, receipt: ExternalReceipt): Promise<ApprovalRecord>;
  noteFailure(
    ref: ApprovalRef,
    failure: Omit<ApprovalFailure, 'at'>,
  ): Promise<ApprovalRecord>;
}
export interface ApprovalAuthority {
  assertCall(binding: ApprovalBinding, signal: AbortSignal): Promise<void>;
  assertUser(
    context: RequestContext,
    binding: ApprovalBinding,
    signal: AbortSignal,
  ): Promise<void>;
  /** Must serialize identity/resource/destination revocation with admission and abort/drain admitted effects.
   * callback spans claim AND real dispatch. No guest or fixture implementation in production. */
  admit<T>(
    binding: ApprovalBinding,
    callback: (admissionSignal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T>;
}
export interface ApprovalResourceOwner {
  snapshot(
    binding: ApprovalBinding,
    selection: AttachmentSelection,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{
    ref: string;
    filename: string;
    mediaType: string;
    bytes: Uint8Array;
  }>;
  assertCurrent(
    binding: ApprovalBinding,
    selection: AttachmentSelection,
    signal: AbortSignal,
  ): Promise<void>;
}
export interface ApprovalDestination {
  /** Trusted description of the registered operation shown to the human. */
  readonly actionLabel: string;
  resolve(
    binding: ApprovalBinding,
    selector: string,
    signal: AbortSignal,
  ): Promise<FrozenPayload['target']>;
  assertCurrent(
    binding: ApprovalBinding,
    target: FrozenPayload['target'],
    signal: AbortSignal,
  ): Promise<void>;
  dispatch(
    binding: ApprovalBinding,
    ref: ApprovalRef,
    payload: FrozenPayload,
    signal: AbortSignal,
  ): Promise<ExternalReceipt>;
  /** null means unknown, including unsupported lookup. Never dispatch here. */
  lookup(
    binding: ApprovalBinding,
    ref: ApprovalRef,
    payload: FrozenPayload,
    signal: AbortSignal,
  ): Promise<ExternalReceipt | null>;
}
export type ApprovalPolicy = Readonly<{
  maxRequestBytes: number;
  maxBodyBytes: number;
  maxAttachmentBytes: number;
  maxAttachments: number;
}>;
export type ApprovalOptions = {
  store: ApprovalStore;
  authority: ApprovalAuthority;
  resources: Readonly<Record<string, ApprovalResourceOwner>>;
  destinations: Readonly<Record<string, ApprovalDestination>>;
  policy: ApprovalPolicy;
};
