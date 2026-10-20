import { z } from 'zod';
import type { WorkflowDefinition } from '@allrice/contracts';

const Receipt = z
  .object({
    usage: z.object({
      inputTokens: z.number().int().nonnegative(),
      cachedInputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    }),
    usageComplete: z.boolean(),
    cacheUsageKnown: z.boolean(),
  })
  .passthrough();

/** Worker receipts live beside each answer, never inside the model's text.
 * Recovery uses persisted receipts; a missing receipt stays unknown. */
export function workflowModelUsage(
  definition: WorkflowDefinition,
  output: Record<string, unknown>,
) {
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let usageComplete = true,
    cacheUsageKnown = true;
  for (const step of definition.steps.filter(
    (s) => s.kind === 'model' || s.kind === 'agent_skill',
  )) {
    const receipt = Receipt.safeParse(output[step.key]);
    if (!receipt.success) {
      usageComplete = false;
      cacheUsageKnown = false;
      continue;
    }
    usage.inputTokens += receipt.data.usage.inputTokens;
    usage.cachedInputTokens += receipt.data.usage.cachedInputTokens;
    usage.outputTokens += receipt.data.usage.outputTokens;
    usageComplete &&= receipt.data.usageComplete;
    cacheUsageKnown &&= receipt.data.cacheUsageKnown;
  }
  return { usage, usageComplete, cacheUsageKnown };
}
