import { z } from 'zod';
import { makeObjectKey } from '@allrice/contracts';
import type { StoragePort } from '@allrice/contracts';
import { LocalStorageAdapter } from '@allrice/storage';
import {
  getDatabase,
  cloudStableId,
  createCloudCommandOperation,
  getPlatformRepairExecution,
  readPlatformRepairSource,
  applyPlatformRepairCandidate,
  preparePlatformRepairInput,
  preparePlatformRepairVerification,
  recordPlatformRepairVerification,
  recordPlatformRepairReport,
  createToolBrokerExportObject,
  registerToolBrokerExport,
  assertPlatformRepairLease,
  appendJobEvent,
  platformRepairToolName,
  technicalDigest,
  lockWorkspaceStorageQuota,
  repositoryCandidate,
  acquireConversationRuntime,
  releaseConversationRuntime,
} from '@allrice/database';
import {
  RepairToolInputSchema,
  RepairReportSchema,
} from '@allrice/database/technical-contracts';
import { createHash } from 'node:crypto';
import type { ClaimedJobHandlerInput } from '../job-runner.js';
import type { HarnessToolCall, HarnessToolResult } from '../harness/adapter.js';
import { runCloudCommandOperation } from '../cloud-runner/executor.js';
import type { CloudRunnerBackend } from '../cloud-runner/backend.js';
import { HandlerError } from '../errors.js';
export const platformRepairToolDefinition = {
  name: platformRepairToolName,
  description:
    'Read, propose a bounded change to, or run the immutable verifier for this registered private AllRice repository candidate. No host path, arbitrary command, assertion change or deployment is accepted.',
  inputSchema: z.toJSONSchema(RepairToolInputSchema),
};

/** A restricted tool controller inside the normal Employee/DSH/budget path.
 * Only its typed source and verification ports differ from an ordinary turn. */
export async function createPlatformRepairController(
  input: ClaimedJobHandlerInput,
  options: { storage?: StoragePort; backend?: CloudRunnerBackend } = {},
) {
  const { execution, workflowLease, signal } = input,
    lease = { ...workflowLease, attempt: execution.job.attempt },
    storage =
      options.storage ??
      new LocalStorageAdapter(
        process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
      );
  const initial = await preparePlatformRepairInput(
    lease,
    execution.context,
    storage,
  );
  if (initial.task.frozen.verificationMode === 'compiled_packages')
    await preparePlatformRepairInput(
      lease,
      execution.context,
      storage,
      'dependencies',
    );
  const observations = new Map<
    string,
    Promise<Awaited<ReturnType<typeof recordPlatformRepairVerification>>>
  >();
  const verify = (checksum: string) => {
    const existing = observations.get(checksum);
    if (existing) return existing;
    const pending = (async () => {
      signal.throwIfAborted();
      const prepared = await preparePlatformRepairVerification(
        lease,
        execution.context,
        checksum,
      );
      if (prepared.observation) return prepared.observation;
      await appendJobEvent({
        ...workflowLease,
        type: 'tool.started',
        payload: {
          name: platformRepairToolName,
          toolCallId: prepared.callId,
          source: 'platform_repository_verification',
          jobAttempt: lease.attempt,
          operationId: prepared.operationId,
          candidateChecksum: checksum,
        },
      });
      const created = await createCloudCommandOperation({
        context: execution.context,
        arguments: prepared.arguments,
        callId: prepared.callId,
      });
      if (
        technicalDigest(created.payload) !== technicalDigest(prepared.command)
      )
        throw new HandlerError(
          'REPAIR_PROFILE_CHANGED',
          '修复验证环境已变化，未执行。',
          false,
        );
      await runCloudCommandOperation(created, {
        storage,
        signal,
        ...(options.backend ? { backend: options.backend } : {}),
      });
      const observation = await recordPlatformRepairVerification(
        lease,
        prepared.operationId,
      );
      await appendJobEvent({
        ...workflowLease,
        type: 'tool.completed',
        payload: {
          name: platformRepairToolName,
          toolCallId: prepared.callId,
          source: 'platform_repository_verification',
          jobAttempt: lease.attempt,
          operationId: prepared.operationId,
          candidateChecksum: checksum,
          verification: observation,
          summary:
            observation.report.exitCode === 0
              ? '固定断言通过'
              : '固定断言未通过',
        },
      });
      return observation;
    })();
    // Retain a rejected/unknown physical operation. A repeat never reruns it.
    observations.set(checksum, pending);
    return pending;
  };
  // Re-entry verifies the original durable baseline observation; a current
  // candidate must never be treated as a new baseline or run twice.
  const before =
    initial.candidate.revision === 0
      ? await verify(initial.candidate.checksum)
      : await recordPlatformRepairVerification(
          lease,
          cloudStableId(
            'cloud-command:' + execution.context.runId + ':repair-verify:0',
          ),
        );
  if (
    before.revision !== 0 ||
    before.report.failureKind !== 'assertion_failed' ||
    before.report.exitCode !== 1
  )
    throw new HandlerError(
      before.report.version === 2 &&
        before.report.failureKind === 'harness_error'
        ? 'REPAIR_COMPILED_BUILD_FAILED'
        : 'REPAIR_BASELINE_NOT_FAILING',
      '该基线未复现固定缺陷，没有启动模型修复。',
      false,
    );
  async function onToolCall(call: HarnessToolCall): Promise<HarnessToolResult> {
    if (call.name !== platformRepairToolName)
      throw new HandlerError(
        'REPAIR_TOOL_DENIED',
        '本任务仅支持固定仓库候选工具。',
        false,
      );
    signal.throwIfAborted();
    const args = RepairToolInputSchema.parse(call.arguments);
    let value: unknown;
    if (args.action === 'read') {
      const current = await readPlatformRepairSource(lease);
      value = {
        baseline: current.task.frozen.baseline,
        candidate: current.candidate,
        file: current.file,
        before,
        allowedPath: current.file.path,
        maxCandidates: 3,
        wholeRepositoryBuildVerified: false,
        publishedToMain: false,
      };
    } else if (args.action === 'apply') {
      value = await applyPlatformRepairCandidate(lease, call.id, args);
    } else value = await verify(args.candidateChecksum);
    await getPlatformRepairExecution(lease);
    await appendJobEvent({
      ...workflowLease,
      type: 'tool.completed',
      payload: {
        source: 'platform_repository_repair',
        name: call.name,
        toolCallId: call.id,
        jobAttempt: lease.attempt,
        argumentsDigest: technicalDigest(args),
        resultDigest: technicalDigest(value),
        action: args.action,
      },
    });
    return {
      modelContent: JSON.stringify(value),
      summary:
        args.action === 'read'
          ? '已读取固定仓库候选'
          : args.action === 'apply'
            ? '已保存待验证候选'
            : '已核对固定断言',
    };
  }
  async function publish(kind: 'candidate' | 'report', document: unknown) {
    const task = await getPlatformRepairExecution(lease),
      bytes = Buffer.from(JSON.stringify(document, null, 2) + '\n'),
      checksum = 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      fileName =
        kind === 'candidate' ? '仓库候选修订.json' : '仓库修复验证.json';
    const prior =
      await getDatabase()`select v.id,v.object_id,o.checksum,o.size_bytes from allrice_deliverable_versions v join allrice_storage_objects o on o.id=v.object_id
      where v.session_id=${task.session_id} and v.owner_id=${task.owner_id} and v.organization_id=${task.organization_id} and v.workspace_id=${task.workspace_id}
      and v.file_name=${fileName} and o.state='ready' and o.deleted_at is null and o.checksum=${checksum} order by v.id limit 2`;
    if (prior.length > 1)
      throw new HandlerError(
        'REPAIR_ARTIFACT_CONFLICT',
        '候选文件身份冲突，请核对现有成果。',
        false,
      );
    if (prior[0])
      return {
        artifactId: prior[0].id,
        versionId: prior[0].id,
        objectId: prior[0].object_id,
        checksum,
        fileName,
        sizeBytes: Number(prior[0].size_bytes),
        kind,
      };
    const objectId = cloudStableId(
        'repair-artifact:' + task.id + ':' + kind + ':' + checksum,
      ),
      object = {
        ...createToolBrokerExportObject({
          context: execution.context,
          mediaType: 'application/json',
          sizeBytes: bytes.length,
          checksum,
        }),
        id: objectId,
        immutable: true,
        key: makeObjectKey({
          organizationId: task.organization_id,
          workspaceId: task.workspace_id,
          ownerId: task.owner_id,
          category: 'exports',
          objectId,
        }),
      };
    signal.throwIfAborted();
    if (!(await storage.exists(object)))
      await storage.put(object, new Blob([Uint8Array.from(bytes)]).stream());
    const registered = await getDatabase().begin(async (tx) => {
      await lockWorkspaceStorageQuota(
        tx,
        task.organization_id,
        task.workspace_id,
      );
      await assertPlatformRepairLease(tx, lease);
      return registerToolBrokerExport(
        {
          context: execution.context,
          sessionId: task.session_id,
          object,
          fileName,
          format: 'json',
          changeSummary:
            'Private fixed-profile candidate repair; not published to main',
        },
        tx,
      );
    });
    return {
      artifactId: registered.id,
      versionId: registered.id,
      objectId,
      checksum,
      fileName,
      sizeBytes: bytes.length,
      kind,
    };
  }
  async function finish() {
    const current = await readPlatformRepairSource(lease);
    if (current.task.report)
      return RepairReportSchema.parse(current.task.report);
    if (current.candidate.revision === 0)
      throw new HandlerError(
        'REPAIR_CANDIDATE_REQUIRED',
        '本轮没有可验证的修订候选。',
        false,
      );
    const after = await verify(current.candidate.checksum);
    if (after.report.exitCode !== 0)
      throw new HandlerError(
        'REPAIR_ASSERTIONS_FAILED',
        '候选未通过原始断言，已保留失败记录。',
        false,
      );
    const document = {
      version: 1,
      candidateChecksum: current.candidate.checksum,
      before,
      after,
      baseline: current.source.baseline,
      wholeRepositoryBuildVerified: false,
      publishedToMain: false,
    };
    const artifacts = [
      await publish('candidate', current.candidate),
      await publish('report', document),
    ];
    const report = RepairReportSchema.parse({
      version: 1,
      candidateChecksum: current.candidate.checksum,
      before,
      after,
      artifacts,
      completedAt: after.completedAt,
      verdict: 'fixed_assertions_passed',
      publishedToMain: false,
      wholeRepositoryBuildVerified: false,
    });
    await recordPlatformRepairReport(lease, report, storage);
    return report;
  }
  async function importAcceptedCandidate() {
    const task = await getPlatformRepairExecution(lease),
      seed = task.frozen.reuseSeed;
    if (!seed || task.frozen.verificationMode !== 'compiled_packages')
      throw new HandlerError(
        'REPAIR_REUSE_UNAVAILABLE',
        '本任务没有冻结可复验的原候选。',
        false,
      );
    signal.throwIfAborted();
    return applyPlatformRepairCandidate(lease, 'repair-reuse:' + task.id, {
      action: 'apply',
      expectedCandidate: repositoryCandidate(0, []).checksum,
      proposal: {
        files: [
          {
            path: 'packages/project-runtime/src/command-output.ts',
            before: task.frozen.baselineText,
            after: Buffer.from(seed.afterBase64, 'base64').toString('utf8'),
          },
        ],
      },
    });
  }
  return { onToolCall, finish, before, importAcceptedCandidate };
}

/** Like the existing deterministic quality check, this reuses the Employee Job
 * and trusted tool controller. No DSH/model call or fabricated model receipt. */
export async function executePlatformRepairReverification(
  input: ClaimedJobHandlerInput,
) {
  const { execution, workflowLease, signal } = input,
    lease = { ...workflowLease, attempt: execution.job.attempt },
    task = await getPlatformRepairExecution(lease),
    ownership = {
      organizationId: task.organization_id,
      workspaceId: task.workspace_id,
      sessionId: task.session_id,
      runId: task.run_id,
      workerId: workflowLease.workerId,
    };
  if (
    !task.frozen.reuseSeed ||
    task.frozen.verificationMode !== 'compiled_packages'
  )
    throw new HandlerError(
      'REPAIR_REUSE_UNAVAILABLE',
      '没有已冻结的候选，未运行模型。',
      false,
    );
  await acquireConversationRuntime({
    ...ownership,
    ownerId: task.owner_id,
    configChecksum: task.frozen.fingerprint,
    compactThresholdTokens: 40000,
  });
  let finished = false;
  try {
    const controller = await createPlatformRepairController(input);
    await controller.importAcceptedCandidate();
    const report = await controller.finish();
    signal.throwIfAborted();
    await getPlatformRepairExecution(lease);
    finished = true;
    return {
      answer: `原候选已在新基线复验：依赖离线安装、两个包编译完成，编译产物通过同一组 ${report.after.report.assertions.length} 项断言。没有重新调用模型；完整仓库构建与发布尚未执行。`,
      repairTaskId: task.id,
      modelUsed: false,
    };
  } finally {
    // The canonical Job completion releases a successful runtime. Releasing
    // here would open the session before the Job/report commit has completed.
    if (!finished || signal.aborted)
      await releaseConversationRuntime({
        ...ownership,
        outcome: signal.aborted ? 'interrupted' : 'error',
        errorCode: 'REPAIR_COMPILED_VERIFICATION_INCOMPLETE',
      });
  }
}
