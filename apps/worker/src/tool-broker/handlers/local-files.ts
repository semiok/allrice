import {
  createLocalBinaryFileOperation,
  createLocalFileDerivationOperation,
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
    input.call.name === 'local.file.derive'
      ? createLocalFileDerivationOperation({
          context: input.context,
          arguments: args,
          callId: input.call.id,
        })
      : createLocalBinaryFileOperation({
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
        input.call.name === 'local.file.derive'
          ? 'listed只核验压缩包内容；derived证明新生成的平台附件已核验，并非已经解压或保存到电脑。需要本机文件时，另行local.file.save按objectId和checksum保存，重名不覆盖。unknown须对账，不重做。'
          : '只有uploaded回执证明平台原始字节可下载；saved证明本机落盘；opened/revealed仅证明系统接收动作。unknown须对账，不自动重做。',
    }),
    summary: `${operation.workspaceLabel} · 文件操作 ${result.status}`,
  };
};
