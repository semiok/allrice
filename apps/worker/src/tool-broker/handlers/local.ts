import { dispatchBridgeCommand } from '@allrice/database';
import { BridgeCommandPayloadSchema } from '@allrice/contracts';

import type { RiceToolHandler } from '../types.js';

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
