import { z } from 'zod';
import { TimestampSchema, UuidSchema } from '../common.ts';
import { ChecksumSchema } from '../runs.ts';
import { RuntimeScopeSchema } from './identity.ts';
import { RuntimeOperationSnapshotSchema } from './operations.ts';
import {
  LocalPreviewLeaseSchema,
  localPreviewOrigin,
} from './local-preview.ts';
import {
  BrowserCommandSchema,
  BrowserObservationSchema,
  BrowserProfileSchema,
  BrowserUrlSchema,
  BrowserWorkspaceStateSchema,
} from './browser-control.ts';

/** P22 uses the existing browser/operation authority, with a device controller port. */
export const localBrowserVersion = 1;
export const localBrowserControllerLeaseMs = 5000;
export const localBrowserStateMaximumBytes = 256 * 1024;
export const localBrowserCaptureMaximumBytes = 2 * 1024 * 1024;
const revision = z.number().int().positive();
const control = z.enum(['agent', 'human', 'paused', 'closed']);

export const LocalBrowserProfileBindingSchema = z
  .object({
    version: z.literal(1),
    scope: RuntimeScopeSchema,
    ownerId: UuidSchema,
    deviceId: UuidSchema,
    grantId: UuidSchema,
    grantRevision: revision,
    logicalProfileId: UuidSchema,
    persistLogin: z.boolean(),
  })
  .strict();
export type LocalBrowserProfileBinding = z.infer<
  typeof LocalBrowserProfileBindingSchema
>;

export const LocalBrowserWorkspaceSchema = z
  .object({
    id: UuidSchema,
    scope: RuntimeScopeSchema,
    ownerId: UuidSchema,
    deviceId: UuidSchema,
    runId: UuidSchema,
    rootRunId: UuidSchema,
    sessionId: UuidSchema,
    profileId: UuidSchema,
    logicalProfileId: UuidSchema,
    grantId: UuidSchema,
    grantRevision: revision,
    persistLogin: z.boolean(),
    // Public HTTPS only in P22. P23 requires its own exact, live process grant;
    // no localhost/HTTP relaxation of the shared cloud BrowserProfile schema.
    profile: BrowserProfileSchema,
    fence: revision,
    acknowledgedFence: z.number().int().nonnegative(),
    state: BrowserWorkspaceStateSchema,
    desiredControl: control,
    expiresAt: TimestampSchema,
    revoked: z.boolean(),
    preview: LocalPreviewLeaseSchema.optional(),
  })
  .strict()
  .superRefine((w, context) => {
    if (!w.preview) return;
    const t = w.preview.target;
    if (
      t.browserWorkspaceId !== w.id ||
      t.browserProfileId !== w.profileId ||
      t.browserGrantId !== w.grantId ||
      t.ownerId !== w.ownerId ||
      t.deviceId !== w.deviceId ||
      t.runId !== w.runId ||
      t.rootRunId !== w.rootRunId ||
      t.scope.organizationId !== w.scope.organizationId ||
      t.scope.workspaceId !== w.scope.workspaceId ||
      t.scope.projectId !== w.scope.projectId ||
      w.persistLogin ||
      w.profile.allowUploads ||
      w.profile.allowDownloads ||
      w.profile.allowHumanCredentials ||
      w.profile.origins.length !== 1 ||
      w.profile.origins[0] !== localPreviewOrigin(t.endpointId) ||
      Date.parse(w.preview.expiresAt) > Date.parse(w.expiresAt) ||
      Date.parse(w.preview.expiresAt) > Date.parse(t.hardDeadlineAt)
    )
      context.addIssue({
        code: 'custom',
        message:
          'Preview must match the private workspace identity, profile and lifetime',
      });
  });
export type LocalBrowserWorkspace = z.infer<typeof LocalBrowserWorkspaceSchema>;

export const LocalBrowserControllerLeaseSchema = z
  .object({
    workspaceId: UuidSchema,
    token: UuidSchema,
    expiresAt: TimestampSchema,
  })
  .strict();
export type LocalBrowserControllerLease = z.infer<
  typeof LocalBrowserControllerLeaseSchema
>;

export const LocalBrowserRevocationSchema =
  LocalBrowserProfileBindingSchema.omit({
    persistLogin: true,
  });
export type LocalBrowserRevocation = z.infer<
  typeof LocalBrowserRevocationSchema
>;

export const LocalBrowserClaimSchema = z
  .object({
    lease: LocalBrowserControllerLeaseSchema.nullable(),
    workspace: LocalBrowserWorkspaceSchema.nullable(),
    revocations: z.array(LocalBrowserRevocationSchema).max(100),
  })
  .strict()
  .refine(
    (claim) =>
      (claim.lease === null && claim.workspace === null) ||
      (claim.lease !== null && claim.lease.workspaceId === claim.workspace?.id),
    'Workspace and controller lease must match',
  );
export type LocalBrowserClaim = z.infer<typeof LocalBrowserClaimSchema>;

export const LocalBrowserOperationSchema = z
  .object({
    snapshot: RuntimeOperationSnapshotSchema,
    command: BrowserCommandSchema,
    observation: BrowserObservationSchema.nullable(),
  })
  .strict();
export type LocalBrowserOperation = z.infer<typeof LocalBrowserOperationSchema>;
export const LocalBrowserNextSchema = z
  .object({ operation: LocalBrowserOperationSchema.nullable() })
  .strict();
export const LocalBrowserStartSchema = z
  .object({
    snapshot: RuntimeOperationSnapshotSchema,
    mayExecute: z.boolean(),
    operationLeaseToken: UuidSchema.nullable(),
  })
  .strict()
  .refine((r) => !r.mayExecute || r.operationLeaseToken !== null);

export const LocalBrowserErrorCodeSchema = z.enum([
  'LOCAL_BROWSER_UNAVAILABLE',
  'LOCAL_BROWSER_DISABLED',
  'LOCAL_BROWSER_LEASE_LOST',
  'LOCAL_BROWSER_CONTROL_CHANGED',
  'LOCAL_BROWSER_POLICY_DENIED',
  'LOCAL_BROWSER_STALE_OBSERVATION',
  'LOCAL_BROWSER_INPUT_INVALID',
  'LOCAL_BROWSER_OUTPUT_LIMIT',
  'LOCAL_BROWSER_IO_UNKNOWN',
  'LOCAL_BROWSER_PROFILE_UNSAFE',
  'LOCAL_BROWSER_CLEANUP_PENDING',
]);
export type LocalBrowserErrorCode = z.infer<typeof LocalBrowserErrorCodeSchema>;
const owned = { workspaceId: UuidSchema, controllerLeaseToken: UuidSchema };

export const LocalBrowserRequestEffectSchema = z
  .object({
    url: BrowserUrlSchema,
    urlDigest: ChecksumSchema,
    method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
    bodyDigest: ChecksumSchema,
    bodyBytes: z.number().int().nonnegative().max(2500000),
  })
  .strict();
export type LocalBrowserRequestEffect = z.infer<
  typeof LocalBrowserRequestEffectSchema
>;

export const LocalBrowserReceiptSchema = z
  .object({
    ...owned,
    operationId: UuidSchema,
    operationLeaseToken: UuidSchema,
    receiptId: UuidSchema,
    status: z.enum(['succeeded', 'failed', 'unknown']),
    networkEffect: z.boolean(),
    observationId: UuidSchema.nullable(),
    downloadObjectId: UuidSchema.nullable(),
    errorCode: LocalBrowserErrorCodeSchema.nullable(),
  })
  .strict();
export type LocalBrowserReceipt = z.infer<typeof LocalBrowserReceiptSchema>;

export const LocalBrowserHttpRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('claim'),
      controllerId: UuidSchema,
      acceptWork: z.boolean(),
      acceptPreview: z.boolean().default(false),
    })
    .strict(),
  z.object({ kind: z.literal('heartbeat'), ...owned }).strict(),
  z.object({ kind: z.literal('next'), ...owned }).strict(),
  z
    .object({ kind: z.literal('start'), ...owned, operationId: UuidSchema })
    .strict(),
  LocalBrowserReceiptSchema.extend({ kind: z.literal('receipt') }),
  z
    .object({
      kind: z.literal('observation'),
      ...owned,
      observation: BrowserObservationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('control_ack'),
      ...owned,
      fence: revision,
      state: z.enum(['agent', 'human', 'paused', 'closed']),
      observationId: UuidSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('stopped'),
      ...owned,
      confirmed: z.boolean(),
      errorCode: LocalBrowserErrorCodeSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('revoke_ack'),
      grantId: UuidSchema,
      grantRevision: revision,
      logicalProfileId: UuidSchema,
      confirmed: z.boolean(),
      errorCode: LocalBrowserErrorCodeSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('request_approval'),
      ...owned,
      requestId: UuidSchema,
      operationId: UuidSchema,
      operationLeaseToken: UuidSchema,
      effect: LocalBrowserRequestEffectSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('request_status'),
      ...owned,
      operationId: UuidSchema,
      approvalOperationId: UuidSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('request_complete'),
      ...owned,
      approvalOperationId: UuidSchema,
      permissionToken: UuidSchema,
      confirmed: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('take_input'),
      ...owned,
      operationId: UuidSchema,
      operationLeaseToken: UuidSchema,
      inputKind: z.enum(['upload', 'private']),
    })
    .strict(),
]);
export type LocalBrowserHttpRequest = z.infer<
  typeof LocalBrowserHttpRequestSchema
>;

export const LocalBrowserHeartbeatSchema = z
  .object({
    lease: LocalBrowserControllerLeaseSchema,
    workspace: LocalBrowserWorkspaceSchema,
  })
  .strict();
export const LocalBrowserRequestApprovalSchema = z
  .object({
    operationId: UuidSchema,
    status: z.enum(['pending', 'ready', 'denied', 'unknown']),
    permissionToken: UuidSchema.nullable(),
  })
  .strict()
  .refine((r) => r.status !== 'ready' || r.permissionToken !== null);

/** Binary endpoints use this bounded metadata, not arbitrary object IDs/paths. */
export const LocalBrowserCaptureSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('screenshot'),
      ...owned,
      fence: revision,
      observationId: UuidSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('download'),
      ...owned,
      operationId: UuidSchema,
      operationLeaseToken: UuidSchema,
      fileName: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[A-Za-z0-9._-]+$/),
      mediaType: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
    })
    .strict(),
]);
export type LocalBrowserCapture = z.infer<typeof LocalBrowserCaptureSchema>;

export function localBrowserProfileBinding(
  workspace: LocalBrowserWorkspace,
): LocalBrowserProfileBinding {
  return LocalBrowserProfileBindingSchema.parse({
    version: 1,
    scope: workspace.scope,
    ownerId: workspace.ownerId,
    deviceId: workspace.deviceId,
    grantId: workspace.grantId,
    grantRevision: workspace.grantRevision,
    logicalProfileId: workspace.logicalProfileId,
    persistLogin: workspace.persistLogin,
  });
}
