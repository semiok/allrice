import { createCloudCommandOperation } from '@allrice/database';
import { PythonExecuteArgsSchema } from '@allrice/contracts';
import { LocalStorageAdapter } from '@allrice/storage';
import { runCloudCommandOperation } from '../../cloud-runner/executor.js';
import { executeManagedCharts } from '../../python/managed-charts.js';
import type { RiceToolHandler } from '../types.js';
import { resolveCloudToolArguments } from './cloud-frozen-script.js';

export const executeCloudCommand: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const argumentsResolved = await resolveCloudToolArguments({
    context: input.context,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    arguments: args,
  });
  const created = await createCloudCommandOperation({
    context: input.context,
    arguments: argumentsResolved,
    callId: input.call.id,
  });
  const result = await runCloudCommandOperation(created, {
    storage: new LocalStorageAdapter(input.storageRoot),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return {
    modelContent: JSON.stringify({
      ...result,
      source: 'cloud-gvisor-v1',
      localFilesModified: false,
    }),
    summary: `云端隔离计算 · ${result.status}`,
    itemCount: result.artifacts.length,
  };
};

export const executePythonCommand: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const result = await executeManagedCharts(
    input,
    PythonExecuteArgsSchema.parse(args),
  );
  return {
    modelContent: JSON.stringify(result),
    summary: `${result.location === 'local' ? '本地' : '云端'} Python 计算 · ${result.status}`,
    itemCount: result.artifacts.length,
  };
};
