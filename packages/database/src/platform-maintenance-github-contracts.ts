import { z } from 'zod';
import { UuidSchema } from '@allrice/contracts';
import {
  platformRepository,
  PlatformRepositoryTokenSchema,
} from './platform-repository-credential-contracts.ts';

export const MaintenanceGithubIdentitySchema = z
  .object({
    revision: z.number().int().positive(),
    login: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
    userId: z.number().int().positive(),
  })
  .strict();
export type MaintenanceGithubIdentity = z.infer<
  typeof MaintenanceGithubIdentitySchema
>;
export const MaintenanceGithubBotSchema = z
  .object({
    repository: z.literal(platformRepository.fullName),
    revision: z.number().int().nonnegative(),
    configured: z.boolean(),
    state: z.enum([
      'central_disabled',
      'not_configured',
      'configured',
      'unavailable',
    ]),
    identity: MaintenanceGithubIdentitySchema.nullable(),
    verifiedAt: z.string().datetime({ offset: true }).nullable(),
    updatedAt: z.string().datetime({ offset: true }).nullable(),
    lastWriteRequestId: UuidSchema.nullable(),
  })
  .strict();
export type MaintenanceGithubBot = z.infer<typeof MaintenanceGithubBotSchema>;
export const UpdateMaintenanceGithubBotSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('replace'),
      requestId: UuidSchema,
      expectedRevision: z.number().int().nonnegative(),
      expectedLogin: MaintenanceGithubIdentitySchema.shape.login,
      token: PlatformRepositoryTokenSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('remove'),
      requestId: UuidSchema,
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
]);
