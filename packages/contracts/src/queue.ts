import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';

export const JobStatusSchema = z.enum([
  'queued',
  'claimed',
  'running',
  'retry_wait',
  'succeeded',
  'failed',
  'dead_letter',
  'canceled',
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.string().min(1).max(128),
    input: z.unknown(),
  })
  .strict();

export const JobLeaseSchema = z
  .object({
    workerId: UuidSchema,
    token: UuidSchema,
    claimedAt: TimestampSchema,
    heartbeatAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict();

export const JobSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    status: JobStatusSchema,
    idempotencyKey: z.string().min(1).max(255),
    attempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    availableAt: TimestampSchema,
    timeoutAt: TimestampSchema,
    payload: JobPayloadSchema,
    lease: JobLeaseSchema.nullable(),
  })
  .strict();
export type Job = z.infer<typeof JobSchema>;

const transitions: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ['claimed', 'canceled'],
  claimed: ['running', 'canceled', 'dead_letter'],
  running: ['succeeded', 'retry_wait', 'failed', 'canceled'],
  retry_wait: ['queued', 'dead_letter', 'canceled'],
  succeeded: [],
  failed: [],
  dead_letter: [],
  canceled: [],
};

export function canTransitionJob(
  from: JobStatus,
  to: JobStatus,
  options: { leaseExpired?: boolean } = {},
) {
  if (
    options.leaseExpired &&
    (from === 'claimed' || from === 'running') &&
    to === 'queued'
  ) {
    return true;
  }
  return transitions[from].includes(to);
}

export function assertJobTransition(
  from: JobStatus,
  to: JobStatus,
  options: { leaseExpired?: boolean } = {},
) {
  if (!canTransitionJob(from, to, options)) {
    throw new Error(`illegal job transition: ${from} -> ${to}`);
  }
}

export function retryDelayMs(attempt: number, baseMs = 1000, capMs = 300_000) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error('attempt must be a positive integer');
  }
  return Math.min(capMs, baseMs * 2 ** (attempt - 1));
}
