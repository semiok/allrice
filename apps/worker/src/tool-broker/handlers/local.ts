import {
  dispatchBridgeCommand,
  createLocalCommandOperation,
  waitLocalCommandOperation,
  localServiceWorkerAction,
} from '@allrice/database';
import {
  BridgeCommandPayloadSchema,
  RuntimeLocalServiceControlSchema,
} from '@allrice/contracts';

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

export const controlLocalService: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const { processId } = RuntimeLocalServiceControlSchema.parse(args);
  const action = input.call.name === 'local.process.stop' ? 'stop' : 'status';
  const service = await localServiceWorkerAction(
    input.context,
    processId,
    action,
  );
  return {
    modelContent: JSON.stringify({
      source: 'rice-bridge',
      service,
      notice: '仅当前Run拥有；ready不等于完成或浏览器可达，stop仅为停止请求',
    }),
    summary:
      action === 'stop'
        ? '已请求停止本地服务，等待实际停止证据'
        : '本地有限服务状态',
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
