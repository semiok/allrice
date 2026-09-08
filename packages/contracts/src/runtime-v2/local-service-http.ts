import { z } from 'zod';
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
  })
  .strict();
export const RuntimeLocalServiceUserActionSchema = z
  .object({
    action: z.enum(['stop', 'input']),
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
