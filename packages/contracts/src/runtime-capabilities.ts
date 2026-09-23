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
