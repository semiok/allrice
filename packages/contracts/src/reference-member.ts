import { z } from 'zod';
import { ChecksumSchema } from './runs.ts';

export const ReferenceArchiveEntryIdSchema = z
  .string()
  .regex(/^entry:sha256:[a-f0-9]{64}$/);
export const ReferenceMemberIdentitySchema = z
  .object({
    entryId: ReferenceArchiveEntryIdSchema,
    path: z.string().min(1).max(1024),
    checksum: ChecksumSchema,
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(20 * 1024 * 1024),
    mediaType: z.string().min(1).max(255),
  })
  .strict();
export type ReferenceMemberIdentity = z.infer<
  typeof ReferenceMemberIdentitySchema
>;
