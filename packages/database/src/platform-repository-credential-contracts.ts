import { z } from 'zod';
import { UuidSchema } from '@allrice/contracts';

/** One platform-owned repository. Never accept a repository, URL or scope from a caller. */
export const platformRepository = Object.freeze({
  id: 1323769790,
  fullName: 'semiok/allrice',
} as const);
export const PlatformRepositoryCredentialSchema = z
  .object({
    repositoryId: z.literal(platformRepository.id),
    repository: z.literal(platformRepository.fullName),
    revision: z.number().int().nonnegative(),
    configured: z.boolean(),
    state: z.enum(['not_configured', 'configured', 'unavailable']),
    updatedAt: z.string().datetime({ offset: true }).nullable(),
    lastWriteRequestId: UuidSchema.nullable(),
  })
  .strict();
export type PlatformRepositoryCredential = z.infer<
  typeof PlatformRepositoryCredentialSchema
>;

// Only fine-grained repository tokens. The request is never logged or returned.
export const PlatformRepositoryTokenSchema = z
  .string()
  .regex(/^github_pat_[A-Za-z0-9_]{50,240}$/);
const revision = z.number().int().nonnegative();
export const UpdatePlatformRepositoryCredentialSchema = z.discriminatedUnion(
  'action',
  [
    z
      .object({
        action: z.literal('replace'),
        expectedRevision: revision,
        requestId: UuidSchema,
        token: PlatformRepositoryTokenSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal('remove'),
        expectedRevision: revision,
        requestId: UuidSchema,
      })
      .strict(),
  ],
);
