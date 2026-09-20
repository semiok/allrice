import { recordToolBrokerAudit } from '@allrice/database';

import { HandlerError } from './errors.js';
import { riceToolCapability, riceToolRisk } from './tool-broker/definitions.js';
import { objectValue } from './tool-broker/input-values.js';
import { requireRiceToolHandler } from './tool-broker/registry.js';
import { boundToolResult } from './tool-broker/result-budget.js';
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
  if (
    input.call.name === 'cloud.mcp.call' &&
    !input.frozenMcpTools?.some(
      (tool) =>
        tool.employeeAuthorization &&
        tool.connectionId === input.call.arguments.connectionId &&
        tool.name === input.call.arguments.tool,
    )
  ) {
    throw new HandlerError(
      'TOOL_CAPABILITY_DENIED',
      '当前 Run 未冻结此员工版本的 MCP 连接授权',
      false,
    );
  }
  const args = objectValue(input.call.arguments);
  if (
    ['local.mcp.discover', 'local.mcp.call'].includes(input.call.name) &&
    (!input.localMcp?.connections.some(
      (c) => c.connectionId === args.connectionId,
    ) ||
      (input.call.name === 'local.mcp.call' &&
        !input.localMcp.tools.some(
          (t) => t.connectionId === args.connectionId && t.name === args.tool,
        )))
  )
    throw new HandlerError(
      'TOOL_CAPABILITY_DENIED',
      '当前 Run 未冻结此设备的本地 MCP 连接或工具授权',
      false,
    );
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
    const result = await boundToolResult(
      input,
      await registration.execute({ input, arguments: args }),
    );
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
