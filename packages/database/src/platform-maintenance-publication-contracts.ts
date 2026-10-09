import { z } from 'zod';
import { ChecksumSchema, UuidSchema } from '@allrice/contracts';
import {
  RepositoryPublicationRequestSchema,
  RepositoryPublicationSourceSchema,
} from './platform-repository-publication-contracts.ts';
import { MaintenanceGithubIdentitySchema } from './platform-maintenance-github-contracts.ts';

export const MaintenanceRepositoryBindingSchema = z
  .object({
    version: z.literal(2),
    id: UuidSchema,
    publicationId: UuidSchema,
    request: RepositoryPublicationRequestSchema,
    source: RepositoryPublicationSourceSchema.refine((s) => s.version === 2),
    inputDigest: ChecksumSchema,
    grantId: UuidSchema,
    grantDigest: ChecksumSchema,
    attemptId: UuidSchema,
    githubBot: MaintenanceGithubIdentitySchema,
    timeoutMs: z.union([z.literal(30000), z.literal(120000)]),
  })
  .strict();
export type MaintenanceRepositoryBinding = z.infer<
  typeof MaintenanceRepositoryBindingSchema
>;
