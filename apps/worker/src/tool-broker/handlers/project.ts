import {
  executeProjectWorkspace,
  publishLocalProjectArtifacts,
  ProjectWorkspaceError,
  selectProjectExecution,
  createLocalCommandOperation,
  waitLocalCommandOperation,
  createCloudProjectOperation,
  RuntimePolicyError,
  cloudExecutionEnabled,
  projectServiceWorkerControl,
  readProjectService,
} from '@allrice/database';
import {
  ProjectRunnableInputSchema,
  projectServiceLimits,
  projectWorkflowBudget,
  cloudPythonImageV1,
  cloudToolchainImageV1,
} from '@allrice/contracts';
import { LocalStorageAdapter } from '@allrice/storage';
import { HandlerError } from '../../errors.js';
import type { RiceToolHandler } from '../types.js';
import { waitForLocalAdmission } from './local-admission.js';
import { CloudRunnerBackend } from '../../cloud-runner/backend.js';
import { runCloudCommandOperation } from '../../cloud-runner/executor.js';

export const runProjectWorkspace: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  if (
    !input.sessionId ||
    input.managedBrowserJobAttempt === undefined ||
    !input.managedBrowserJobLeaseToken
  )
    throw new HandlerError(
      'PROJECT_TASK_UNAVAILABLE',
      '项目操作需要当前任务的有效执行上下文。',
      false,
    );
  try {
    if (
      [
        'service_status',
        'service_stop',
        'service_renew',
        'service_sync',
      ].includes(String(args.action))
    ) {
      const result = await projectServiceWorkerControl(
        input.context,
        input.sessionId,
        args,
        {
          attempt: input.managedBrowserJobAttempt,
          leaseToken: input.managedBrowserJobLeaseToken,
        },
        new LocalStorageAdapter(input.storageRoot),
      );
      return {
        modelContent: JSON.stringify({ service: result }),
        summary: `项目服务 · ${result.state}`,
      };
    }
    if (args.action === 'execute' || args.action === 'service_start') {
      const command = ProjectRunnableInputSchema.parse(args),
        storage = new LocalStorageAdapter(input.storageRoot);
      const worker = {
        attempt: input.managedBrowserJobAttempt,
        leaseToken: input.managedBrowserJobLeaseToken,
      };
      const backend = new CloudRunnerBackend();
      let cloudReady = false;
      const selected = await waitForLocalAdmission(input, async () => {
        let selection = await selectProjectExecution({
          context: input.context,
          arguments: command,
          callId: input.call.id,
          worker,
          cloudReady,
        });
        if (
          command.action === 'execute' &&
          cloudExecutionEnabled() &&
          !cloudReady &&
          (selection.choice.location === 'none' ||
            selection.choice.location === 'cloud') &&
          selection.choice.reason === 'cloud_unavailable'
        ) {
          // Local-ready/busy/preparing paths never spend a cloud probe or cloud slot.
          cloudReady = await backend
            .preflight(
              command.projectPreparation.manager === 'uv'
                ? cloudPythonImageV1
                : cloudToolchainImageV1,
            )
            .then(() => true)
            .catch(() => false);
          if (cloudReady)
            selection = await selectProjectExecution({
              context: input.context,
              arguments: command,
              callId: input.call.id,
              worker,
              cloudReady,
            });
        }
        if (selection.choice.status === 'wait')
          throw new RuntimePolicyError(
            selection.choice.reason === 'local_busy'
              ? 'local_runner_busy'
              : 'local_runner_preparing',
          );
        if (selection.choice.status !== 'execute')
          return { selection, local: null };
        if (selection.choice.location === 'local') {
          const localArgs = {
            project: command.project,
            executable: command.executable,
            args: command.args,
            path: command.path,
            projectPreparation: command.projectPreparation,
            ...('outputs' in command && command.outputs
              ? { outputs: command.outputs }
              : {}),
            ...(command.action === 'service_start'
              ? {
                  background: {
                    durationMs: projectServiceLimits.maximumLifetimeMs,
                    readiness: {
                      kind: 'http',
                      port: command.service.port,
                      path: command.service.path,
                      timeoutMs: command.service.readinessTimeoutMs,
                    },
                    stdin: {
                      mode: 'none',
                      maxRequests: 1,
                      maxBytes: 1,
                      requestTimeoutMs: 1000,
                    },
                    projectService: command.service,
                  },
                }
              : {}),
            limits: command.limits,
          };
          const local = await createLocalCommandOperation({
            context: input.context,
            arguments: localArgs,
            callId: input.call.id,
            worker,
            storage,
            projectSelection: selection,
          });
          return { selection, local };
        }
        return { selection, local: null };
      });
      if (selected.selection.choice.status !== 'execute')
        return {
          modelContent: JSON.stringify({
            status:
              selected.selection.choice.status === 'reconcile'
                ? 'unknown'
                : 'environment_unavailable',
            executed: false,
            executionChoice: selected.selection.choice,
            project: command.project,
            nextAction:
              '本次调用未启动新的执行；恢复原执行环境或核对原操作状态，不得自动换端重跑。',
          }),
          summary: '项目执行环境暂不可用',
        };
      if (selected.local) {
        const result = await waitLocalCommandOperation(
          selected.local,
          input.signal,
        );
        if (command.action === 'service_start') {
          const service = await readProjectService(
            {
              organizationId: input.context.organizationId,
              workspaceId: input.context.workspaceId,
              actor: {
                type: 'user',
                id: input.context.policySnapshot.subjectId,
              },
            },
            result.operationId,
          );
          return {
            modelContent: JSON.stringify({
              service,
              executionChoice: selected.selection.choice,
              project: command.project,
              sourceDirectoryModified: false,
            }),
            summary: `本地项目服务 · ${service.state}`,
          };
        }
        const artifacts =
          result.status === 'succeeded' && command.outputs?.length
            ? await publishLocalProjectArtifacts(
                { context: input.context, operationId: result.operationId },
                storage,
              )
            : [];
        const evidence = result.evidence as {
          output?: { artifacts?: unknown[] };
        } | null;
        const publicResult = evidence?.output?.artifacts
          ? {
              ...result,
              evidence: {
                ...evidence,
                output: { ...evidence.output, artifacts: undefined },
              },
            }
          : result;
        return {
          modelContent: JSON.stringify({
            ...publicResult,
            artifacts,
            project: command.project,
            executionLocation: 'local',
            executionChoice: selected.selection.choice,
            workCopy: 'local_isolated_copy',
            sourceDirectoryModified: false,
          }),
          summary: `本地项目执行 · ${result.status}`,
        };
      }
      if (command.action !== 'execute')
        throw new HandlerError(
          'PROJECT_SERVICE_UNAVAILABLE',
          '当前项目服务需要已就绪的本地 Bridge。',
          false,
        );
      const created = await createCloudProjectOperation({
        context: input.context,
        callId: input.call.id,
        projectSelection: selected.selection,
        worker,
        storage,
      });
      const result = await runCloudCommandOperation(created, {
        storage,
        backend,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return {
        modelContent: JSON.stringify({
          ...result,
          project: command.project,
          executionLocation: 'cloud',
          executionChoice: selected.selection.choice,
          workCopy: 'cloud_copy',
          sourceDirectoryModified: false,
        }),
        summary: `云端项目执行 · ${result.status}`,
      };
    }
    const result = await executeProjectWorkspace(
      {
        context: input.context,
        sessionId: input.sessionId,
        callId: input.call.id,
        worker: {
          attempt: input.managedBrowserJobAttempt,
          leaseToken: input.managedBrowserJobLeaseToken,
        },
        arguments: args,
      },
      new LocalStorageAdapter(input.storageRoot),
    );
    return {
      modelContent: JSON.stringify({
        ...result,
        workflowBudget: projectWorkflowBudget,
      }),
      summary:
        args.action === 'open' || args.action === 'apply'
          ? '项目源码已保存；尚未执行构建'
          : args.action === 'deliver'
            ? '项目源码与真实测试记录已交付'
            : '已读取指定版本的项目源码',
    };
  } catch (error) {
    if (
      error instanceof RuntimePolicyError &&
      error.code === 'project_workflow_budget_exhausted'
    )
      throw new HandlerError(
        'PROJECT_WORKFLOW_BUDGET_EXHAUSTED',
        '本轮项目执行预算已用完。保留当前源码和失败记录，用 deliver 交付结果；不要继续修改、执行或换端重试。',
        false,
      );
    if (error instanceof ProjectWorkspaceError)
      throw new HandlerError(
        `PROJECT_${error.code.toUpperCase()}`,
        error.message,
        false,
      );
    throw error;
  }
};
