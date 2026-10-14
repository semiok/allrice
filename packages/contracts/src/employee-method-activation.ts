import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';

/** Target and approval are derived from the live session, never model inputs. */
export const EmployeeMethodPrepareActivationSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    candidateRevisionId: UuidSchema,
    candidateDigest: ChecksumSchema,
    testIds: z.array(UuidSchema).max(32),
  })
  .strict()
  .refine(
    (v) => new Set(v.testIds).size === v.testIds.length,
    'Duplicate tests',
  );
export const EmployeeMethodActivateSchema = z
  .object({ receiptId: UuidSchema })
  .strict();

export const methodActivationQuestionPrefix = 'method-activate:';
export const methodActivationApprove = '确认启用';
export const methodActivationDecline = '暂不启用';
