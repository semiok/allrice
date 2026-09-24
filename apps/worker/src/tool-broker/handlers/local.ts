import {
  dispatchBridgeCommand,
  createLocalCommandOperation,
  waitLocalCommandOperation,
  localServiceWorkerAction,
  RuntimePolicyError,
} from '@allrice/database';
import {
  BridgeCommandPayloadSchema,
  RuntimeLocalServiceControlSchema,
} from '@allrice/contracts';

import type { RiceToolHandler } from '../types.js';
import { LocalStorageAdapter } from '@allrice/storage';

export const executeControlledLocalCommand: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const operation = await createLocalCommandOperation({
    context: input.context,
    arguments: args,
    callId: input.call.id,
    storage: new LocalStorageAdapter(input.storageRoot),
  }).catch((error: unknown) => {
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
        recoveryTool: 'cloud.process.execute',
        nextAction:
          '若任务不依赖本机进程，使用已有 cloud.process.execute 完成计算，并明确告诉用户在云端执行。所需本地文件必须来自用户为当前任务选择的输入，通过既有文件工具读取/上传，不能自动上传整个目录。依赖本机服务、项目预览或本地开发审查的任务，提示 Bridge 重新检查并准备环境，不能声称已等价执行。原有工具权限、具体动作批准与 Diff 回写继续生效。',
      }),
      summary: '本地计算环境暂不可用，通用计算可转由云端完成',
    };
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
