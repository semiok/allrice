import {
  dispatchBridgeCommand,
  createLocalCommandOperation,
  waitLocalCommandOperation,
} from '@allrice/database';
import { BridgeCommandPayloadSchema } from '@allrice/contracts';

import type { RiceToolHandler } from '../types.js';

export const executeControlledLocalCommand: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const operation = await createLocalCommandOperation({
    context: input.context,
    arguments: args,
    callId: input.call.id,
  });
  const result = await waitLocalCommandOperation(operation, input.signal);
  return {
    modelContent: JSON.stringify({
      ...result,
      source: 'rice-bridge',
      workCopy: 'local_isolated_copy',
      sourceDirectoryModified: false,
    }),
    summary: `${operation.workspaceLabel} · 本地命令 ${result.status}`,
  };
};

export const executeLocalBridgeTool: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const bridge = await dispatchBridgeCommand({
    context: input.context,
    payload: BridgeCommandPayloadSchema.parse({
      capability: input.call.name,
      arguments: args,
    }),
    idempotencyKey: `tool:${input.context.runId}:${input.call.id}`,
  });
  return {
    modelContent: JSON.stringify({
      source: 'rice-bridge',
      localWorkspace: bridge.workspaceLabel,
      output: bridge.output,
    }),
    summary: `${bridge.workspaceLabel} · ${bridge.summary}`,
  };
};
