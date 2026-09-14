import { z } from 'zod';
import { UuidSchema } from './common.ts';

/** Work mode is not an authorization grant. Boost/Teamwork remain unavailable. */
export const AssistantRunConfigurationSchema = z
  .object({
    version: z.literal(1),
    mode: z.literal('daily'),
    allowAssistants: z.boolean(),
    maxConcurrent: z.number().int().min(1).max(4),
    maxDepth: z.number().int().min(1).max(3),
    maxChildren: z.number().int().min(1).max(16),
  })
  .strict();
export type AssistantRunConfiguration = z.infer<
  typeof AssistantRunConfigurationSchema
>;
export const defaultAssistantRunConfiguration =
  (): AssistantRunConfiguration => ({
    version: 1,
    mode: 'daily',
    allowAssistants: false,
    maxConcurrent: 2,
    maxDepth: 1,
    maxChildren: 4,
  });
export const AssistantMessageRequestSchema = z
  .object({
    runId: UuidSchema,
    childRunId: UuidSchema,
    inputId: UuidSchema,
    text: z.string().trim().min(1).max(16000),
  })
  .strict();
export const AssistantResultSchema = z
  .object({
    deliveryId: UuidSchema,
    status: z.enum(['completed', 'partial', 'failed', 'canceled', 'unknown']),
    summary: z.string().max(16000),
    evidence: z
      .array(
        z
          .object({
            id: UuidSchema,
            digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(32),
    incomplete: z.array(z.string().max(2000)).max(32),
    usageComplete: z.boolean(),
  })
  .strict();
export type AssistantResult = z.infer<typeof AssistantResultSchema>;
export type AssistantStatus =
  | 'provisioning'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancel_requested'
  | 'canceled'
  | 'unknown';
export type AssistantMessageStatus =
  | 'pending'
  | 'dispatching'
  | 'accepted'
  | 'durable'
  | 'adopted'
  | 'unknown'
  | 'canceled';
export interface AssistantInstanceView {
  runId: string;
  parentRunId: string | null;
  rootRunId: string;
  nativeSessionId: string;
  label: string;
  depth: number;
  status: AssistantStatus;
  allowedTools: string[];
  artifactNamespace: string;
  cancelRequestedAt: string | null;
  stoppedAt: string | null;
}
