import { createCloudCommandOperation } from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import { runCloudCommandOperation } from '../../cloud-runner/executor.js';
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
