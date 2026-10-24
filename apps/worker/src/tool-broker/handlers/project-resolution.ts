import {
  createCloudProjectResolutionOperation,
  executeProjectWorkspace,
  publishProjectResolutionDiagnostics,
  cloudStableId,
} from '@allrice/database';
import {
  ProjectDependencyResolveInputSchema,
  cloudPlatform,
  projectLockArchitectures,
  projectResolutionErrorMessage,
} from '@allrice/contracts';
import { readResolvedProject } from '@allrice/project-runtime';
import { LocalStorageAdapter } from '@allrice/storage';
import { HandlerError, confirmToolFailure } from '../../errors.js';
import { runCloudCommandOperation } from '../../cloud-runner/executor.js';
import { requireSuccessfulCloudCommand } from '../../cloud-runner/tool-result.js';
import type { RiceToolHandler } from '../types.js';

export const runProjectResolution: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const parsed = ProjectDependencyResolveInputSchema.parse(args);
  // New uv resolutions always name their target CPU, so they use the targeted
  // controller; a request without one is kept for records made before targets.
  const request =
    parsed.manager === 'uv' && !parsed.architecture
      ? { ...parsed, architecture: cloudPlatform.architecture }
      : parsed;
  const storage = new LocalStorageAdapter(input.storageRoot);
  const created = await createCloudProjectResolutionOperation({
    context: input.context,
    callId: input.call.id,
    arguments: request,
  });
  const result = await runCloudCommandOperation(created, {
    storage,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!('stopped' in result)) {
    requireSuccessfulCloudCommand(input, result);
    throw new HandlerError(
      'PROJECT_RESOLUTION_UNCONFIRMED',
      '依赖解析结果尚未确认，不能自动重跑。',
      false,
    );
  }
  if (result.status === 'failed' && result.stopped && result.cleanupConfirmed) {
    const diagnostic = await publishProjectResolutionDiagnostics(
      {
        context: input.context,
        sessionId: input.sessionId!,
        operationId: result.operationId,
      },
      storage,
    );
    const code =
      result.errorCode ??
      result.resolution?.errorCode ??
      'PROJECT_RESOLUTION_FAILED';
    const error = new HandlerError(
      code,
      `${projectResolutionErrorMessage(code) ?? '依赖准备失败，未安装。'} 已保留诊断：${JSON.stringify(diagnostic)}\n${result.resolution?.diagnostics.slice(-2000) ?? ''}`,
      false,
    );
    confirmToolFailure(error, {
      runId: input.context.runId,
      callId: input.call.id,
      toolName: input.call.name,
    });
    throw error;
  }
  requireSuccessfulCloudCommand(input, result);
  const resolved = readResolvedProject(
    request,
    Buffer.from(JSON.stringify(result.resolution)),
  );
  if (!resolved.files || !resolved.forProject)
    throw new HandlerError(
      'PROJECT_RESOLUTION_UNCONFIRMED',
      '没有收到完整的依赖解析回执，未安装。',
      false,
    );
  const project = await executeProjectWorkspace(
    {
      context: input.context,
      sessionId: input.sessionId!,
      callId: cloudStableId(`resolved-project:${input.call.id}`),
      worker: {
        attempt: input.managedBrowserJobAttempt!,
        leaseToken: input.managedBrowserJobLeaseToken!,
      },
      arguments: { action: 'open', files: resolved.files },
    },
    storage,
  );
  if (
    !('project' in project) ||
    !project.project ||
    !('sourceDigest' in project) ||
    project.sourceDigest !== resolved.sourceDigest
  )
    throw new HandlerError(
      'PROJECT_RESOLUTION_SOURCE_CHANGED',
      '保存的项目源码与依赖回执不一致，未安装。',
      false,
    );
  const projectPreparation = resolved.forProject(project.project.projectId);
  return {
    modelContent: JSON.stringify({
      ...project,
      operationId: result.operationId,
      status: 'resolved',
      installed: false,
      projectPreparation,
      // Where this lock installs; a backend of another CPU cannot run it.
      architectures: projectLockArchitectures(projectPreparation),
      nextAction:
        '依赖已解析并保存，尚未安装或验证。用返回的精确 project 和 projectPreparation 执行验证；如果 apply 添加源码，必须采用新 sourceDigest。后续任务先 open 精确 source 恢复。',
    }),
    summary: '依赖已解析并保存，尚未安装',
  };
};
