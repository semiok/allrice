import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';

/** AllRice's current-user/workspace budget, never the provider's subscription quota. */
export const UserMonthlyQuotaSchema = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    userId: UuidSchema,
    displayName: z.string().min(1),
    monthlyTokenLimit: z.number().int().positive(),
    usedTokens: z.number().int().nonnegative(),
    codexTokenPolicy: z.enum(['observe', 'enforce']).optional(),
    cachedInputTokens: z.number().int().nonnegative().nullable().optional(),
    remainingTokens: z.number().int().nonnegative(),
    remainingPercent: z.number().min(0).max(100),
    unknownUsageRuns: z.number().int().nonnegative(),
    periodStart: TimestampSchema,
    resetsAt: TimestampSchema,
    observedAt: TimestampSchema,
  })
  .strict();
export type UserMonthlyQuota = z.infer<typeof UserMonthlyQuotaSchema>;
