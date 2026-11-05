import { z } from 'zod';
import {
  RuntimeActionApprovalRequestSchema,
  RuntimeActionApprovalResponseSchema,
} from './runtime-v2/interactions.ts';

/** Host control-plane result. Never a model tool argument or a reusable grant. */
export const NativeActionApprovalResultSchema = z
  .object({
    outcome: z.enum(['allowed-once', 'rejected', 'cancelled', 'unavailable']),
    request: RuntimeActionApprovalRequestSchema,
    response: RuntimeActionApprovalResponseSchema.nullable(),
  })
  .strict();
export type NativeActionApprovalResult = z.infer<
  typeof NativeActionApprovalResultSchema
>;
export type NativeActionApprovalPort = {
  request(
    request: z.infer<typeof RuntimeActionApprovalRequestSchema>,
  ): Promise<NativeActionApprovalResult>;
  /** Same invocation still lives in the same Host; never restored from PG. */
  assertLive(requestId: string): Promise<void>;
};
