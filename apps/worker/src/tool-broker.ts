import { recordToolBrokerAudit } from '@allrice/database';

import { HandlerError } from './errors.js';
import { riceToolCapability, riceToolRisk } from './tool-broker/definitions.js';
import { objectValue } from './tool-broker/input-values.js';
import { requireRiceToolHandler } from './tool-broker/registry.js';
import type {
  RiceToolExecutionInput,
  RiceToolResult,
} from './tool-broker/types.js';

export {
  riceReadOnlyToolDefinitionsForPreview,
  riceToolCapability,
  riceToolDefinitions,
  riceToolDefinitionsForCapabilities,
  riceToolDefinitionsForTurn,
  riceToolRisk,
  type RiceToolRisk,
} from './tool-broker/definitions.js';
export { createManagedBrowserCancellationMonitor } from './tool-broker/handlers/browser.js';
export { managedBrowserUntrustedContent } from './tool-broker/managed-browser-input.js';
export type {
  RiceToolCall,
  RiceToolExecutionInput,
  RiceToolResult,
} from './tool-broker/types.js';

function auditMetadata(
  input: RiceToolExecutionInput,
  requiredCapability: NonNullable<ReturnType<typeof riceToolCapability>>,
) {
  return {
    skillVersionIds: input.skillVersionIds ?? [],
    requiredCapability,
    ...(input.platformTestRunId
      ? {
          platformTestRunId: input.platformTestRunId,
          platformActorLabel: input.platformActorLabel ?? null,
          delegatedSubjectId: input.context.policySnapshot.subjectId,
          executionMode: 'platform_employee_preview' as const,
        }
      : {}),
  };
}

/**
 * The Tool Broker governance boundary. Capability, preview and audit policy
 * remain centralized here; concrete tool behavior is selected by the exact
 * name-to-handler registry under `tool-broker/registry.ts`.
 */
export async function executeRiceTool(
  input: RiceToolExecutionInput,
): Promise<RiceToolResult> {
  const requiredCapability = riceToolCapability(input.call.name);
  if (!requiredCapability) {
    throw new HandlerError(
      'TOOL_NOT_ALLOWED',
      `不允许调用工具 ${input.call.name}`,
      false,
    );
  }
  if (!input.capabilities.includes(requiredCapability)) {
    throw new HandlerError(
      'TOOL_CAPABILITY_DENIED',
      `Rice 未被授予 ${requiredCapability} 能力`,
      false,
    );
  }
  const args = objectValue(input.call.arguments);
  try {
    if (
      input.platformTestRunId &&
      riceToolRisk(input.call.name) !== 'read_only'
    ) {
      throw new HandlerError(
        'PLATFORM_PREVIEW_READ_ONLY',
        '平台配置试用仅允许只读工具',
        false,
      );
    }

    const registration = requireRiceToolHandler(input.call.name);
    const result = await registration.execute({ input, arguments: args });
    await recordToolBrokerAudit({
      context: input.context,
      toolName: input.call.name,
      metadata: auditMetadata(input, requiredCapability),
    });
    return result;
  } catch (error) {
    await recordToolBrokerAudit({
      context: input.context,
      toolName: input.call.name,
      decision: 'denied',
      reason:
        error instanceof HandlerError
          ? error.code.toLowerCase()
          : 'tool_execution_failed',
      metadata: auditMetadata(input, requiredCapability),
    }).catch(() => undefined);
    throw error;
  }
}
