import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';

const address = {
  requestId: UuidSchema,
  parentSessionId: z.string().min(1),
  childSessionId: z.string().min(1),
  mode: z.literal('continuable'),
};
export const NativeSubagentControlInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...address,
      kind: z.literal('prompt'),
      delivery: z.enum(['queue', 'steer']),
      content: z.tuple([
        z.object({ type: z.literal('text'), text: z.string().min(1) }).strict(),
      ]),
      clientTimeZone: z.string().min(1).optional(),
    })
    .strict(),
  z.object({ ...address, kind: z.literal('interrupt') }).strict(),
]);

// Server-frozen internal address, never a browser-supplied execution grant.
export const NativeSubagentControlScopeSchema = z
  .object({
    rootRunId: UuidSchema,
    nativeRootId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    jobId: UuidSchema,
    jobAttempt: z.number().int().positive(),
    rootOriginDigest: ChecksumSchema,
    storageNamespace: z.string().min(1),
  })
  .strict();
export const NativeSubagentControlRequestSchema = z
  .object({
    scope: NativeSubagentControlScopeSchema,
    input: NativeSubagentControlInputSchema,
  })
  .strict();

// Inbox acceptance / cancellation ACK, not execution or stopped evidence.
export const NativeSubagentControlAcceptanceSchema = z.discriminatedUnion(
  'kind',
  [
    z
      .object({ kind: z.literal('prompt'), messageId: z.string().min(1) })
      .strict(),
    z
      .object({ kind: z.literal('interrupt'), accepted: z.literal(true) })
      .strict(),
  ],
);
export type NativeSubagentControlInput = z.infer<
  typeof NativeSubagentControlInputSchema
>;
export type NativeSubagentControlScope = z.infer<
  typeof NativeSubagentControlScopeSchema
>;
export type NativeSubagentControlRequest = z.infer<
  typeof NativeSubagentControlRequestSchema
>;
export type NativeSubagentControlAcceptance = z.infer<
  typeof NativeSubagentControlAcceptanceSchema
>;

export const NativeSubagentControlResultSchema = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('accepted'),
        acceptance: NativeSubagentControlAcceptanceSchema,
        source: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('native_ack') }).strict(),
          z
            .object({
              kind: z.literal('user_rpc'),
              rpcId: UuidSchema,
              sequence: z.number().int().nonnegative(),
            })
            .strict(),
        ]),
      })
      .strict(),
    z.object({ status: z.literal('unknown') }).strict(),
    z
      .object({
        status: z.literal('rejected'),
        code: z
          .string()
          .min(1)
          .refine((code) => code !== 'INPUT_OUTCOME_UNKNOWN'),
      })
      .strict(),
  ],
);
export type NativeSubagentControlResult = z.infer<
  typeof NativeSubagentControlResultSchema
>;
export interface NativeSubagentControlTicket {
  requestId: string;
  kind: NativeSubagentControlInput['kind'];
  result: NativeSubagentControlResult | { status: 'recorded' };
}
