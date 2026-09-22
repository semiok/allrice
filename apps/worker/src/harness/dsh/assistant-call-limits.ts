import { AssistantRunConfigurationSchema } from '@allrice/contracts';

/** A development root includes the coordinator, writer, tester and reviewer.
 * Allocate the existing 16-call allowance per permitted participant, once at
 * root creation. This is one finite shared ceiling, not replenished on spawn,
 * retry or completion. Tool, deadline, concurrency and loop guards remain. */
export function assistantModelCallCapacity(
  configuration: unknown,
  allowedTools: readonly string[],
): number {
  const frozen = AssistantRunConfigurationSchema.parse(configuration);
  return allowedTools.includes('assistant.development')
    ? 16 * (1 + frozen.maxChildren)
    : 16;
}
