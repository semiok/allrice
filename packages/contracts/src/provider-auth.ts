import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';

export const ProviderAuthorizationFlowStateSchema = z.enum([
  'pending',
  'running',
  'awaiting_user',
  'connected',
  'failed',
  'expired',
  'canceled',
]);

export const ProviderAuthorizationFlowSchema = z
  .object({
    id: UuidSchema,
    provider: z.literal('codex'),
    connectionId: UuidSchema,
    state: ProviderAuthorizationFlowStateSchema,
    verificationUri: z.string().url().max(2_000).nullable(),
    userCode: z.string().trim().min(4).max(64).nullable(),
    detailCode: z.string().trim().min(1).max(160).nullable(),
    expiresAt: TimestampSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    completedAt: TimestampSchema.nullable(),
  })
  .strict();

export type ProviderAuthorizationFlow = z.infer<
  typeof ProviderAuthorizationFlowSchema
>;

export const StartProviderAuthorizationInputSchema = z
  .object({ connectionId: UuidSchema.optional() })
  .strict();

export const ProviderGrantSchema = z
  .object({
    connectionId: UuidSchema,
    provider: z.literal('codex'),
    authMode: z.literal('chatgpt_subscription'),
    status: z.enum(['connected', 'disconnected', 'error']),
    credentialReference: z.string().trim().min(1).max(255),
    authorizedAt: TimestampSchema.nullable(),
    lastCheckedAt: TimestampSchema.nullable(),
    detailCode: z.string().trim().min(1).max(160).nullable(),
  })
  .strict();

export type ProviderGrant = z.infer<typeof ProviderGrantSchema>;
