import { z } from 'zod';
import { TimestampSchema, UuidSchema } from '../common.ts';
import { ChecksumSchema } from '../runs.ts';
import { RuntimeScopeSchema } from './identity.ts';

/** Reserved virtual origin: only the trusted process relay can serve it.
 * Never resolve through DNS, publish a host port or accept a model chosen host. */
export const localPreviewSuffix = '.preview.allrice.invalid';
export const LocalPreviewOpenInputSchema = z
  .object({ processId: UuidSchema })
  .strict();
export function localPreviewOrigin(endpointId: string) {
  return `https://p-${UuidSchema.parse(endpointId)}${localPreviewSuffix}`;
}
export const LocalPreviewTargetSchema = z
  .object({
    version: z.literal(1),
    endpointId: UuidSchema,
    scope: RuntimeScopeSchema,
    ownerId: UuidSchema,
    deviceId: UuidSchema,
    runId: UuidSchema,
    rootRunId: UuidSchema,
    browserWorkspaceId: UuidSchema,
    browserProfileId: UuidSchema,
    browserGrantId: UuidSchema,
    processId: UuidSchema,
    attemptId: UuidSchema,
    generation: z.number().int().nonnegative(),
    fence: z.number().int().positive(),
    processInputDigest: ChecksumSchema,
    folderGrantId: UuidSchema,
    folderGrantVersion: z.number().int().positive(),
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    imageDigest: ChecksumSchema,
    port: z.number().int().min(1024).max(65535),
    hardDeadlineAt: TimestampSchema,
  })
  .strict();
export type LocalPreviewTarget = z.infer<typeof LocalPreviewTargetSchema>;
export const LocalPreviewLeaseSchema = z
  .object({
    target: LocalPreviewTargetSchema,
    endpointLeaseId: UuidSchema,
    expiresAt: TimestampSchema,
  })
  .strict();
export type LocalPreviewLease = z.infer<typeof LocalPreviewLeaseSchema>;

export function localPreviewUrlAllowed(
  target: LocalPreviewTarget,
  value: string,
) {
  try {
    const parsed = new URL(value);
    return (
      value.length <= 4096 &&
      parsed.origin === localPreviewOrigin(target.endpointId) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash &&
      !/[\r\n\0]/.test(value)
    );
  } catch {
    return false;
  }
}
export function reservedLocalPreviewUrl(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    return (
      host === localPreviewSuffix.slice(1) || host.endsWith(localPreviewSuffix)
    );
  } catch {
    return false;
  }
}

export const LocalPreviewErrorCodeSchema = z.enum([
  'LOCAL_PREVIEW_DISABLED',
  'LOCAL_PREVIEW_TARGET_DENIED',
  'LOCAL_PREVIEW_LEASE_LOST',
  'LOCAL_PREVIEW_PROCESS_STOPPED',
  'LOCAL_PREVIEW_NETWORK_DENIED',
  'LOCAL_PREVIEW_OUTPUT_LIMIT',
  'LOCAL_PREVIEW_UNKNOWN',
  'LOCAL_PREVIEW_REQUEST_INVALID',
]);
export type LocalPreviewErrorCode = z.infer<typeof LocalPreviewErrorCodeSchema>;
