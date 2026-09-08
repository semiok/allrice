import { z } from 'zod';
import { UuidSchema } from '../common.ts';
import { ChecksumSchema } from '../runs.ts';

/** P09-c: finite, Run-owned service. Readiness is inside the private container,
 * never a promise that a browser on another machine can reach this port. */
export const RuntimeLocalServiceConfigSchema = z
  .object({
    durationMs: z.number().int().min(1000).max(300_000),
    readiness: z
      .object({
        kind: z.enum(['tcp', 'http']),
        port: z.number().int().min(1024).max(65535),
        path: z
          .string()
          .max(256)
          .regex(/^\/[A-Za-z0-9_./?=&%-]*$/)
          .default('/'),
        timeoutMs: z.number().int().min(500).max(30_000),
      })
      .strict(),
    stdin: z
      .object({
        mode: z.enum(['none', 'requests-v1']),
        maxRequests: z.number().int().min(1).max(16),
        maxBytes: z.number().int().min(1).max(4096),
        requestTimeoutMs: z.number().int().min(500).max(60_000),
      })
      .strict(),
  })
  .strict();
export type RuntimeLocalServiceConfig = z.infer<
  typeof RuntimeLocalServiceConfigSchema
>;

export const RuntimeLocalServiceRequestSchema = z
  .object({
    requestId: UuidSchema,
    sequence: z.number().int().min(0).max(15),
    prompt: z.string().min(1).max(500),
    expiresAt: z.iso.datetime(),
    maxBytes: z.number().int().min(1).max(4096),
  })
  .strict();
export type RuntimeLocalServiceRequest = z.infer<
  typeof RuntimeLocalServiceRequestSchema
>;

export const RuntimeLocalServiceInputSchema = z
  .object({
    inputId: UuidSchema,
    requestId: UuidSchema,
    sequence: z.number().int().min(0).max(15),
    expiresAt: z.iso.datetime(),
    digest: ChecksumSchema,
    kind: z.enum(['text', 'eof']),
    text: z
      .string()
      .max(4096)
      .refine((s) => !s.includes('\0')),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      (v.kind === 'eof' && v.text !== '') ||
      new TextEncoder().encode(v.text).length > 4096
    )
      c.addIssue({ code: 'custom', message: 'invalid bounded process input' });
  });
export type RuntimeLocalServiceInput = z.infer<
  typeof RuntimeLocalServiceInputSchema
>;

const common = {
  processId: UuidSchema,
  attemptId: UuidSchema,
  sequence: z.number().int().min(0).max(63),
};
export const RuntimeLocalServiceEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...common,
      type: z.literal('starting'),
      containerId: z.string().regex(/^[a-f0-9]{64}$/),
      hardDeadlineAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('ready'),
      port: z.number().int().min(1024).max(65535),
      visibility: z.literal('container_only'),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('input_request'),
      request: RuntimeLocalServiceRequestSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('input_delivered'),
      inputId: UuidSchema,
      requestId: UuidSchema,
      inputSequence: z.number().int().min(0).max(15),
      digest: ChecksumSchema,
      kind: z.enum(['text', 'eof']),
    })
    .strict(),
]);
export type RuntimeLocalServiceEvent = z.infer<
  typeof RuntimeLocalServiceEventSchema
>;

/** Exact digest bytes are canonical JSON of {kind,text}; never include plaintext
 * input in audit summaries, model results or supervisor logs. */
export const RuntimeLocalServiceStateSchema = z.enum([
  'starting',
  'ready',
  'waiting_input',
  'stopping',
  'stopped',
  'failed',
  'unknown',
]);
export type RuntimeLocalServiceState = z.infer<
  typeof RuntimeLocalServiceStateSchema
>;
