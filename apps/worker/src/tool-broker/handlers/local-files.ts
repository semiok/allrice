import {
  createLocalBinaryFileOperation,
  waitLocalCommandOperation,
} from '@allrice/database';
import type { LocalFileToolArguments } from '@allrice/contracts';
import type { RiceToolHandler } from '../types.js';
import { waitForLocalAdmission } from './local-admission.js';

export const executeLocalFileTool: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const capability = input.call.name as keyof typeof LocalFileToolArguments;
  const operation = await waitForLocalAdmission(input, () =>
    createLocalBinaryFileOperation({
      context: input.context,
      capability,
      arguments: args,
      callId: input.call.id,
    }),
  );
  const result = await waitLocalCommandOperation(operation, input.signal);
  return {
    modelContent: JSON.stringify({
      ...result,
      source: 'rice-bridge',
      executionLocation: 'local',
      executionReason: 'explicit_local',
      localWorkspace: operation.workspaceLabel,
      notice:
        '只有uploaded回执证明平台原始字节可下载；saved证明本机落盘；opened/revealed仅证明系统接收动作。unknown须对账，不自动重做。',
    }),
    summary: `${operation.workspaceLabel} · 文件操作 ${result.status}`,
  };
};
