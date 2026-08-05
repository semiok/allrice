import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';

export const CredentialBindingSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema.nullable(),
    ownerId: UuidSchema.nullable(),
    provider: z.string().min(1).max(64),
    label: z.string().min(1).max(120),
    vaultKey: z.string().min(1).max(255),
    createdAt: TimestampSchema,
    revokedAt: TimestampSchema.nullable(),
  })
  .strict();

export interface SecretVault {
  put(secret: Uint8Array): Promise<string>;
  get(vaultKey: string): Promise<Uint8Array>;
  delete(vaultKey: string): Promise<void>;
}
