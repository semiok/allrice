import { z } from 'zod';

import { UuidSchema } from './common.ts';
import { HarnessKindSchema } from './harness.ts';

export const ChatFlowTransportSchema = z.enum([
  'polling',
  'postgres-notify',
  'redis-streams',
  'nats',
]);
export type ChatFlowTransport = z.infer<typeof ChatFlowTransportSchema>;

export const ChatFlowRealtimeRolloutPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    emergencyOff: z.boolean().default(false),
    defaultEnabled: z.boolean().default(true),
    organizationIds: z.array(UuidSchema).default([]),
    workspaceIds: z.array(UuidSchema).default([]),
    employeeVersionIds: z.array(UuidSchema).default([]),
    harnesses: z.array(HarnessKindSchema).default([]),
  })
  .strict();
export type ChatFlowRealtimeRolloutPolicy = z.infer<
  typeof ChatFlowRealtimeRolloutPolicySchema
>;

export interface ChatFlowRealtimeRolloutContext {
  organizationId?: string | null;
  workspaceId?: string | null;
  employeeVersionId?: string | null;
  harness?: z.infer<typeof HarnessKindSchema> | null;
}

function matchesScope(configured: string[], actual: string | null | undefined) {
  return (
    configured.length === 0 || Boolean(actual && configured.includes(actual))
  );
}

export function resolveChatFlowRealtimeRollout(
  policyInput: ChatFlowRealtimeRolloutPolicy,
  context: ChatFlowRealtimeRolloutContext,
) {
  const policy = ChatFlowRealtimeRolloutPolicySchema.parse(policyInput);
  if (policy.emergencyOff) return false;
  const scoped =
    policy.organizationIds.length > 0 ||
    policy.workspaceIds.length > 0 ||
    policy.employeeVersionIds.length > 0 ||
    policy.harnesses.length > 0;
  if (!scoped) return policy.defaultEnabled;
  return (
    matchesScope(policy.organizationIds, context.organizationId) &&
    matchesScope(policy.workspaceIds, context.workspaceId) &&
    matchesScope(policy.employeeVersionIds, context.employeeVersionId) &&
    matchesScope(policy.harnesses, context.harness)
  );
}

/** Transport-neutral wake-up hint. Durable replay always comes from RunEvent. */
export const ChatFlowWakeupSchema = z
  .object({
    runId: UuidSchema,
    sequence: z.number().int().nonnegative(),
  })
  .strict();
export type ChatFlowWakeup = z.infer<typeof ChatFlowWakeupSchema>;
