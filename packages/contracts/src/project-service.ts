import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import {
  ProjectVersionRefSchema,
  ProjectSnapshotSchema,
} from './project-workspace.ts';

/** One finite service identity across local and cloud backends. A Run may
 * finish successfully without ending this lease; cancellation never detaches. */
export const projectServiceLimits = Object.freeze({
  defaultLeaseMs: 600_000,
  maximumLeaseMs: 1_800_000,
  maximumLifetimeMs: 3_600_000,
  heartbeatMs: 5000,
  maximumUpdates: 8,
  // Framework development bundles are larger than production assets.
  maximumHttpBytes: 16_000_000,
  maximumSocketBytes: 500_000,
  maximumReadinessMs: 300_000,
});
export function projectServiceReadinessLimit(preparation?: {
  manager: string;
  resourceProfile?: string;
}) {
  return preparation?.manager === 'pnpm' &&
    preparation.resourceProfile === 'web-development'
    ? projectServiceLimits.maximumReadinessMs
    : 30_000;
}
export const ProjectServiceConfigSchema = z
  .object({
    port: z.number().int().min(1024).max(65535),
    path: z
      .string()
      .max(256)
      .regex(/^\/[A-Za-z0-9_./?=&%-]*$/)
      .default('/'),
    readinessTimeoutMs: z
      .number()
      .int()
      .min(500)
      .max(projectServiceLimits.maximumReadinessMs)
      .default(30_000),
    leaseMs: z
      .number()
      .int()
      .min(10_000)
      .max(projectServiceLimits.maximumLeaseMs)
      .default(projectServiceLimits.defaultLeaseMs),
  })
  .strict();
export type ProjectServiceConfig = z.infer<typeof ProjectServiceConfigSchema>;
export const ProjectServiceStateSchema = z.enum([
  'starting',
  'ready',
  'offline',
  'stopping',
  'stopped',
  'failed',
  'unknown',
]);
export const ProjectServiceViewSchema = z
  .object({
    version: z.literal(1),
    id: UuidSchema,
    runId: UuidSchema,
    sessionId: UuidSchema,
    backend: z.enum(['local', 'cloud']),
    state: ProjectServiceStateSchema,
    project: ProjectVersionRefSchema,
    sourceDigest: ChecksumSchema,
    expiresAt: TimestampSchema,
    hardDeadlineAt: TimestampSchema,
    lastSeenAt: TimestampSchema.nullable(),
    stopRequested: z.boolean(),
    stopped: z.boolean(),
    updatePending: z.boolean(),
    canRenew: z.boolean(),
  })
  .strict();
export type ProjectServiceView = z.infer<typeof ProjectServiceViewSchema>;
export const ProjectServiceControlInputSchema = z.discriminatedUnion('action', [
  z
    .object({ action: z.literal('service_status'), serviceId: UuidSchema })
    .strict(),
  z
    .object({ action: z.literal('service_stop'), serviceId: UuidSchema })
    .strict(),
  z
    .object({
      action: z.literal('service_renew'),
      serviceId: UuidSchema,
      requestId: UuidSchema,
      leaseMs: z
        .number()
        .int()
        .min(10_000)
        .max(projectServiceLimits.maximumLeaseMs),
    })
    .strict(),
  z
    .object({
      action: z.literal('service_sync'),
      serviceId: UuidSchema,
      requestId: UuidSchema,
      expectedProject: ProjectVersionRefSchema,
      project: ProjectVersionRefSchema,
    })
    .strict(),
]);
export const ProjectServiceUserActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('stop') }).strict(),
  z.object({ action: z.literal('preview') }).strict(),
  z
    .object({
      action: z.literal('renew'),
      requestId: UuidSchema,
      leaseMs: z
        .number()
        .int()
        .min(10_000)
        .max(projectServiceLimits.maximumLeaseMs),
    })
    .strict(),
]);
export const ProjectServiceSourceUpdateSchema = z
  .object({
    updateId: UuidSchema,
    expectedDigest: ChecksumSchema,
    project: ProjectVersionRefSchema,
    snapshot: ProjectSnapshotSchema,
  })
  .strict();
export type ProjectServiceSourceUpdate = z.infer<
  typeof ProjectServiceSourceUpdateSchema
>;
export const ProjectServiceSourceReceiptSchema = z
  .object({
    updateId: UuidSchema,
    sourceDigest: ChecksumSchema,
  })
  .strict();
/** Server-issued data-plane target. The client never chooses a host, container,
 * mount, image, owner, port or backend. Every transfer rechecks live authority. */
export const ProjectServiceTargetSchema = z
  .object({
    serviceId: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    backend: z.enum(['local', 'cloud']),
    deviceId: UuidSchema.nullable(),
    operationId: UuidSchema,
    attemptId: UuidSchema,
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    imageDigest: ChecksumSchema,
    port: z.number().int().min(1024).max(65535),
    expiresAt: TimestampSchema,
    hardDeadlineAt: TimestampSchema,
  })
  .strict();
export type ProjectServiceTarget = z.infer<typeof ProjectServiceTargetSchema>;
