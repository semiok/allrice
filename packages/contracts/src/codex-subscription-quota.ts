import { z } from 'zod';

import { TimestampSchema } from './common.ts';

/** Provider-reported percentages, NOT token balances or platform allocations. */
export const CodexSubscriptionQuotaWindowSchema = z
  .object({
    slot: z.enum(['primary', 'secondary']),
    status: z.enum(['available', 'unknown']),
    usedPercent: z.number().finite().min(0).max(100).nullable(),
    windowDurationMins: z.number().int().positive().nullable(),
    // Official app-server wire time is Unix seconds, not milliseconds.
    resetsAt: z.number().int().positive().max(253402300799).nullable(),
  })
  .strict()
  .superRefine((window, ctx) => {
    const complete =
      window.usedPercent !== null &&
      window.windowDurationMins !== null &&
      window.resetsAt !== null;
    if ((window.status === 'available') !== complete)
      ctx.addIssue({
        code: 'custom',
        message: 'window status must match data',
      });
  });

export const CodexSubscriptionQuotaSnapshotSchema = z
  .object({
    source: z.literal('codex_app_server'),
    status: z.enum(['available', 'unknown', 'error']),
    checkedAt: TimestampSchema,
    accountFingerprint: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
    detailCode: z
      .string()
      .regex(/^codex_quota_[a-z_]+$/)
      .max(100),
    // Only a digest of a rejected protocol method; never its arbitrary text,
    // request body, headers, token or provider error details.
    rejectedMethodFingerprint: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    buckets: z
      .array(
        z
          .object({
            limitId: z
              .string()
              .regex(/^[a-zA-Z0-9_.:-]{1,128}$/)
              .nullable(),
            limitReached: z.boolean().nullable(),
            windows: z.tuple([
              CodexSubscriptionQuotaWindowSchema,
              CodexSubscriptionQuotaWindowSchema,
            ]),
          })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const measured = snapshot.buckets.some((bucket) =>
      bucket.windows.some((window) => window.status === 'available'),
    );
    if (
      (snapshot.status === 'available' &&
        (!measured || snapshot.accountFingerprint === null)) ||
      (snapshot.status !== 'available' && measured) ||
      (snapshot.status === 'error' && snapshot.buckets.length > 0) ||
      (snapshot.rejectedMethodFingerprint !== undefined &&
        snapshot.status !== 'error') ||
      snapshot.buckets.some(
        (bucket) =>
          bucket.windows[0].slot !== 'primary' ||
          bucket.windows[1].slot !== 'secondary',
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'quota snapshot is inconsistent',
      });
  });

export type CodexSubscriptionQuotaSnapshot = z.infer<
  typeof CodexSubscriptionQuotaSnapshotSchema
>;
