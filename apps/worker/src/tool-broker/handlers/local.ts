import {
  dispatchBridgeCommand,
  createLocalCommandOperation,
  createLocalFileOperation,
  waitLocalCommandOperation,
  localServiceWorkerAction,
  RuntimePolicyError,
} from '@allrice/database';
import {
  BridgeCommandPayloadSchema,
  RuntimeLocalServiceControlSchema,
  resolveExecutionChoice,
} from '@allrice/contracts';

import type { RiceToolHandler } from '../types.js';
import { LocalStorageAdapter } from '@allrice/storage';
import { waitForLocalAdmission } from './local-admission.js';

export const executeControlledLocalCommand: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const operation = await waitForLocalAdmission(input, () =>
    createLocalCommandOperation({
      context: input.context,
      arguments: args,
      callId: input.call.id,
      storage: new LocalStorageAdapter(input.storageRoot),
    }),
  ).catch((error: unknown) => {
    if (
      !(error instanceof RuntimePolicyError) ||
      error.code !== 'local_runner_unavailable'
    )
      throw error;
    return null;
  });
  if (!operation)
    return {
      modelContent: JSON.stringify({
        status: 'environment_unavailable',
        executed: false,
        source: 'rice-bridge',
        executionChoice: resolveExecutionChoice({
          location: 'local',
          local: 'unsupported',
          cloudAvailable: false,
          localInputs: true,
        }),
        executionLocation: 'local',
        nextAction:
          '当前明确绑定的本机环境不可用，请查看 Bridge 的具体缺项并恢复环境。不得自动上传本地文件或迁移本次调用；用户明确允许云端且输入已获授权时，可在新的工具调用中使用已有云端能力。',
      }),
      summary: '本地计算环境暂不可用，本次调用未执行',
    };
  const result = await waitLocalCommandOperation(operation, input.signal);
  return {
    modelContent: JSON.stringify({
      ...result,
      source: 'rice-bridge',
      executionLocation: 'local',
      executionReason: 'explicit_local',
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
  if (
    input.call.name === 'local.fs.write' ||
    input.call.name === 'local.fs.mkdir'
  ) {
    const operation = await waitForLocalAdmission(input, () =>
      createLocalFileOperation({
        context: input.context,
        payload: { capability: input.call.name, arguments: args },
        callId: input.call.id,
      }),
    );
    const result = await waitLocalCommandOperation(operation, input.signal);
    return {
      modelContent: JSON.stringify({
        ...result,
        source: 'rice-bridge',
        executionLocation: 'local',
        executionReason: 'local_inputs_required',
        localWorkspace: operation.workspaceLabel,
      }),
      summary: `${operation.workspaceLabel} · 文件操作 ${result.status}`,
    };
  }
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
      executionLocation: 'local',
      executionReason: 'local_inputs_required',
      localWorkspace: bridge.workspaceLabel,
      output: bridge.output,
    }),
    summary: `${bridge.workspaceLabel} · ${bridge.summary}`,
  };
};
