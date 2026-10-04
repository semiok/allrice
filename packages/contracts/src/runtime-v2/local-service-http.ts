import { z } from 'zod';
import {
  ProjectServiceSourceReceiptSchema,
  ProjectServiceSourceUpdateSchema,
} from '../project-service.ts';
import { UuidSchema } from '../common.ts';
import { RuntimeAttemptRefSchema } from './identity.ts';
import { RuntimeOperationSnapshotSchema } from './operations.ts';
import {
  RuntimeLocalServiceEventSchema,
  RuntimeLocalServiceInputSchema,
} from './local-service.ts';
export const RuntimeLocalServiceExchangeSchema = z
  .object({
    contractVersion: z.literal(1),
    attempt: RuntimeAttemptRefSchema,
    leaseToken: UuidSchema,
    events: z.array(RuntimeLocalServiceEventSchema).max(16),
    deliveryOnly: z.boolean().optional(),
    sourceReceipts: z
      .array(ProjectServiceSourceReceiptSchema)
      .max(1)
      .optional(),
  })
  .strict();
export const RuntimeLocalServiceExchangeResponseSchema = z
  .object({
    snapshot: RuntimeOperationSnapshotSchema,
    leaseExpiresAt: z.iso.datetime(),
    hardDeadlineAt: z.iso.datetime(),
    acceptedSequence: z.number().int().min(-1).max(63),
    inputs: z.array(RuntimeLocalServiceInputSchema).max(1),
    stopRequested: z.boolean(),
    acceptedSourceReceipts: z
      .array(ProjectServiceSourceReceiptSchema)
      .max(1)
      .optional(),
    projectService: z
      .object({
        id: UuidSchema,
        expiresAt: z.iso.datetime(),
        previewHost: z
          .string()
          .max(253)
          .regex(/^[a-z0-9.-]+(?::[0-9]{1,5})?$/)
          .nullable(),
        sourceUpdate: ProjectServiceSourceUpdateSchema.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const RuntimeLocalServiceUserActionSchema = z
  .object({
    action: z.enum(['stop', 'input', 'preview']),
    input: RuntimeLocalServiceInputSchema.optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if ((v.action === 'input') !== (v.input !== undefined))
      c.addIssue({
        code: 'custom',
        message: 'input required only for input action',
      });
  });
export const RuntimeLocalServiceControlSchema = z
  .object({ processId: UuidSchema })
  .strict();
