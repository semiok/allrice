import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';

export const RuntimeComponentSchema = z
  .object({
    id: z.string().min(1).max(200),
    packageName: z.string().min(1).max(200),
    version: z.string().max(100).nullable(),
    state: z.enum(['configured', 'disabled', 'conditional', 'missing']),
  })
  .strict();

/** Only non-secret installation/configuration facts cross the Worker boundary. */
export const WorkerCapabilitySnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    workerId: UuidSchema,
    releaseSha: z.string().max(100).nullable(),
    version: z.string().max(100).nullable(),
    profileDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    profileStatus: z.enum(['read', 'unavailable', 'custom-runtime']),
    components: z.array(RuntimeComponentSchema).max(500),
    tools: z
      .array(
        z
          .object({
            name: z.string().max(160),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export const WorkerCapabilityObservationSchema =
  WorkerCapabilitySnapshotSchema.extend({
    observedAt: TimestampSchema,
    online: z.boolean(),
  });

export type WorkerCapabilitySnapshot = z.infer<
  typeof WorkerCapabilitySnapshotSchema
>;
export type WorkerCapabilityObservation = z.infer<
  typeof WorkerCapabilityObservationSchema
>;

export interface RuntimeCapabilityPublication {
  employeeName: string;
  workspaceId: string;
  workspaceName: string;
  version: number;
  skillIds: string[];
  toolNames: string[];
  policyEnabled: boolean;
  policyMode: string | null;
}

export interface RuntimeCapabilityInventory {
  checkedAt: string;
  workers: WorkerCapabilityObservation[];
  publications: RuntimeCapabilityPublication[];
}

/** Read-only aggregate exported to the DSH Lab; no tenant identities or manifests. */
export const AllriceCapabilitySummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    checkedAt: TimestampSchema,
    webReleaseSha: z.string().max(100).nullable(),
    workerReleaseShas: z.array(z.string().max(100)).max(500),
    versions: z.array(z.string().max(100)).max(500),
    onlineWorkers: z.number().int().nonnegative(),
    componentCount: z.string().max(30),
    enhancementCount: z.string().max(30),
    availableSkills: z.number().int().nonnegative(),
    publishedSkills: z.number().int().nonnegative(),
    publications: z.number().int().nonnegative(),
    capabilities: z
      .array(
        z
          .object({
            id: z.string().max(100),
            status: z.string().max(200),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export const DshNativeCapabilitySnapshotSchema = z
  .object({
    type: z.literal('allrice/admin-native-capabilities'),
    components: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            name: z.string().min(1).max(200),
            state: z.enum([
              'active',
              'disabled',
              'pending',
              'failed',
              'unknown',
            ]),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();

export type AllriceCapabilitySummary = z.infer<
  typeof AllriceCapabilitySummarySchema
>;
