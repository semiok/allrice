import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LocalStorageAdapter } from '@allrice/storage';
import {
  ProjectVersionRefSchema,
  ProjectWorkspaceToolInputSchema,
  BrowserVerificationOutcomeSchema,
  UuidSchema,
  type ProjectVersionRef,
} from '@allrice/contracts';
import {
  getDatabase,
  getPlatformQualityExecution,
  recordPlatformQualityReport,
  getWorkbenchArtifact,
  readArtifactBytes,
  acquireConversationRuntime,
  releaseConversationRuntime,
  appendJobEvent,
  projectExecutionReport,
  qualityFixture,
  qualityAssertion,
  qualityDigest,
  qualityLock,
  type resolveEmployeeExecution,
  type QualityCheckReport,
} from '@allrice/database';
import { executeRiceTool } from '../tool-broker.js';
import { BrowserWorkspaceToolInputSchema } from '../browser-control/tool-input.js';
import { HandlerError } from '../errors.js';
import type { ClaimedJobHandlerInput } from '../job-runner.js';

const record = z.record(z.string(), z.unknown());
const sha = (text: string) =>
  'sha256:' + createHash('sha256').update(text).digest('hex');

/** A deterministic case driver inside the existing employee Job. All physical
 * work goes through the unchanged Broker, runtime selectors and file publisher.
 * This case deliberately does not invoke a model or grade natural language. */
export async function executePlatformQualityCheck(
  handler: ClaimedJobHandlerInput,
  resolved: Awaited<ReturnType<typeof resolveEmployeeExecution>>,
) {
  const { execution, signal, workflowLease } = handler;
  const lease = { ...workflowLease, attempt: execution.job.attempt };
  const check = await getPlatformQualityExecution(lease);
  if (check.frozen.releaseSha !== process.env.ALLRICE_RELEASE_SHA)
    throw new HandlerError(
      'QUALITY_RELEASE_CHANGED',
      '质检版本已变化，请为当前版本创建新检查。',
      false,
    );
  const storageRoot = process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage';
  const storage = new LocalStorageAdapter(storageRoot);
  const principal = {
    organizationId: check.organizationId,
    workspaceId: check.workspaceId,
    actor: { type: 'user' as const, id: check.ownerId },
  };
  const ownership = {
    organizationId: check.organizationId,
    workspaceId: check.workspaceId,
    sessionId: check.sessionId,
    runId: check.runId,
    workerId: workflowLease.workerId,
  };
  await acquireConversationRuntime({
    ...ownership,
    ownerId: check.ownerId,
    configChecksum: check.frozen.fingerprint,
    compactThresholdTokens: 40000,
  });
  const report: QualityCheckReport = {
    version: 1,
    verdict: 'unknown',
    completedAt: new Date().toISOString(),
    project: null,
    build: null,
    artifacts: [],
    browser: null,
    errorCode: null,
    cleanup: 'unknown',
  };
  let finished = false;
  const step = async (
    id: string,
    name: 'workspace.project' | 'browser.workspace',
    args: Record<string, unknown>,
  ) => {
    signal.throwIfAborted();
    await getPlatformQualityExecution(lease);
    const callId = `quality:${check.id}:${id}`,
      argumentsDigest = qualityDigest(args);
    // Reconcile a durable result before doing any physical work again.
    const [receipt] =
      await getDatabase()`select payload from allrice_run_events where run_id=${check.runId}
      and event_type='tool.completed' and payload->>'source'='platform_quality_step'
      and payload->>'toolCallId'=${callId} and payload->>'jobAttempt'=${String(execution.job.attempt)} order by sequence desc limit 1`;
    if (receipt) {
      if (
        receipt.payload.argumentsDigest !== argumentsDigest ||
        typeof receipt.payload.modelContent !== 'string'
      )
        throw Error('QUALITY_STEP_CHANGED');
      return record.parse(JSON.parse(receipt.payload.modelContent));
    }
    await appendJobEvent({
      ...workflowLease,
      type: 'tool.started',
      payload: {
        toolCallId: callId,
        name,
        source: 'platform_quality_step',
        jobAttempt: execution.job.attempt,
        argumentsDigest,
      },
    });
    const result = await executeRiceTool({
      context: execution.context,
      capabilities: resolved.grantedCapabilities,
      nativeSkills: resolved.nativeSkills,
      storageRoot,
      sessionId: check.sessionId,
      employeeId: resolved.executionSnapshot?.employee.id,
      userMessageId: check.frozen.userMessageId,
      userRequest: resolved.promptSnapshot.userRequest,
      signal,
      managedBrowserJobAttempt: execution.job.attempt,
      managedBrowserJobLeaseToken: workflowLease.leaseToken,
      call: { id: callId, name, arguments: args },
    });
    const value = record.parse(JSON.parse(result.modelContent));
    await getPlatformQualityExecution(lease);
    await appendJobEvent({
      ...workflowLease,
      type: 'tool.completed',
      payload: {
        toolCallId: callId,
        name,
        source: 'platform_quality_step',
        jobAttempt: execution.job.attempt,
        argumentsDigest,
        modelContent: result.modelContent,
        summary: result.summary,
      },
    });
    return value;
  };
  const artifact = async (
    raw: unknown,
    kind: QualityCheckReport['artifacts'][number]['kind'],
  ) => {
    const ref = record.parse(raw);
    const id = UuidSchema.parse(ref.versionId ?? ref.artifactId ?? ref.id);
    const a = await getWorkbenchArtifact(principal, check.sessionId, id);
    const bytes = await readArtifactBytes(storage, a.object, 2_000_000);
    report.artifacts.push({
      artifactId: a.id,
      versionId: a.version.id,
      objectId: a.object.id,
      checksum: a.object.checksum!,
      fileName: a.version.fileName,
      sizeBytes: bytes.length,
      kind,
      storedBytesVerified: true,
    });
    return { artifact: a, bytes };
  };
  try {
    const fixture = qualityFixture(check.frozen.variant);
    const opened = await step(
      'open',
      'workspace.project',
      ProjectWorkspaceToolInputSchema.parse({
        action: 'open',
        files: fixture.files,
      }),
    );
    const project: ProjectVersionRef = ProjectVersionRefSchema.parse(
      opened.project,
    );
    report.project = project;
    const build = await step(
      'build',
      'workspace.project',
      ProjectWorkspaceToolInputSchema.parse({
        action: 'execute',
        project,
        executable: '/usr/local/bin/node',
        args: ['build.mjs'],
        path: '.',
        projectPreparation: {
          version: 1,
          projectId: project.projectId,
          sourceDigest: opened.sourceDigest,
          lockChecksum: sha(qualityLock),
          offline: true,
          manager: 'pnpm',
          managerVersion: '10.33.3',
          lockPath: 'pnpm-lock.yaml',
          scripts: 'disabled',
          packages: [],
        },
        outputs: [
          {
            path: 'dist/index.html',
            fileName: 'quality-page.html',
            format: 'html',
          },
        ],
        limits: {
          timeoutMs: 30000,
          outputBytes: 16384,
          memoryMiB: 512,
          cpuMillis: 1000,
          pids: 64,
        },
      }),
    );
    if (build.status !== 'succeeded') {
      const choice = record.safeParse(build.executionChoice);
      const reason =
        choice.success &&
        typeof choice.data.reason === 'string' &&
        /^[a-z_]{1,80}$/.test(choice.data.reason)
          ? choice.data.reason
          : 'unknown';
      throw Error(
        build.executed === false
          ? `QUALITY_EXECUTION_UNAVAILABLE:${reason}`
          : 'QUALITY_BUILD_FAILED',
      );
    }
    const operationId = UuidSchema.parse(build.operationId);
    const published = z.array(record).parse(build.artifacts);
    const pageRef = published.find(
      (a) =>
        a.fileName === 'quality-page.html' ||
        (typeof a.version === 'object' &&
          a.version !== null &&
          'fileName' in a.version &&
          a.version.fileName === 'quality-page.html'),
    );
    if (!pageRef) throw Error('QUALITY_PAGE_MISSING');
    const page = await artifact(pageRef, 'page');
    if (
      page.bytes.toString('utf8') !== fixture.html ||
      !page.artifact.execution
    )
      throw Error('QUALITY_PAGE_CHANGED');
    const actualBuild = (
      await projectExecutionReport(execution.context, project)
    ).executions.find((e) => e.operationId === operationId);
    if (
      !actualBuild ||
      actualBuild.status !== 'succeeded' ||
      actualBuild.result?.exitCode !== 0 ||
      actualBuild.result.stopped !== true ||
      qualityDigest(actualBuild.project) !== qualityDigest(project)
    )
      throw Error('QUALITY_BUILD_RECEIPT_MISSING');
    report.build = {
      operationId,
      location: actualBuild.location as 'local' | 'cloud',
      targetId: page.artifact.execution.targetId,
      exitCode: actualBuild.result.exitCode,
      command: 'node build.mjs',
    };
    const delivered = await step(
      'deliver',
      'workspace.project',
      ProjectWorkspaceToolInputSchema.parse({ action: 'deliver', project }),
    );
    for (const item of z.array(record).parse(delivered.artifacts))
      await artifact(
        item,
        item.fileName === 'project-source.zip' ? 'source' : 'report',
      );
    const verified = await step(
      'verify',
      'browser.workspace',
      BrowserWorkspaceToolInputSchema.parse({
        command: 'verify',
        artifact: {
          versionId: page.artifact.version.id,
          checksum: page.artifact.object.checksum,
        },
        plan: qualityAssertion,
      }),
    );
    report.browser = BrowserVerificationOutcomeSchema.parse(
      verified.verification,
    );
    if (
      qualityDigest(report.browser.plan) !== check.frozen.assertionDigest ||
      report.browser.report.target.versionId !== page.artifact.version.id ||
      report.browser.report.target.checksum !== page.artifact.object.checksum
    )
      throw Error('QUALITY_ASSERTION_CHANGED');
    for (const item of z.array(record).parse(verified.artifacts)) {
      const v = record.safeParse(item.version);
      await artifact(
        item,
        v.success && v.data.fileName === 'browser-verification.png'
          ? 'screenshot'
          : 'report',
      );
    }
    report.cleanup = 'confirmed';
    report.verdict =
      report.browser.report.verdict === 'passed'
        ? 'passed'
        : report.browser.report.verdict === 'failed'
          ? 'assertion_failed'
          : 'unknown';
    report.completedAt = new Date().toISOString();
    await recordPlatformQualityReport(lease, report, storage);
    if (report.verdict === 'unknown') throw Error('QUALITY_ASSERTION_UNKNOWN');
    finished = true;
    return {
      answer:
        report.verdict === 'passed'
          ? '固定项目质检通过。构建、原断言和交付文件均已核对。'
          : '固定项目质检未通过。构建成功，但点击后的结果不符合原断言；失败证据和文件已保留。',
      qualityCheckId: check.id,
      modelUsed: false,
    };
  } catch (error) {
    report.verdict = signal.aborted
      ? 'canceled'
      : error instanceof Error &&
          /UNAVAILABLE|NOT_READY|CAPABILITY|POLICY|DENIED|unavailable|unsupported/.test(
            error.message,
          )
        ? 'blocked'
        : 'execution_failed';
    report.errorCode =
      error instanceof HandlerError
        ? error.code
        : error instanceof Error &&
            /^[A-Za-z0-9_.:-]{1,120}$/.test(error.message)
          ? error.message
          : 'QUALITY_EXECUTION_FAILED';
    report.completedAt = new Date().toISOString();
    // Authority/lease loss cannot commit a late report or turn a failure into a pass.
    await recordPlatformQualityReport(lease, report, storage).catch(
      () => undefined,
    );
    throw new HandlerError(
      report.errorCode!,
      '质检未完成；保留原检查与已有文件，请先核对环境或失败证据。',
      false,
    );
  } finally {
    if (!finished || signal.aborted)
      await releaseConversationRuntime({
        ...ownership,
        outcome: signal.aborted ? 'interrupted' : 'error',
        errorCode: report.errorCode ?? 'QUALITY_EXECUTION_INCOMPLETE',
      });
  }
}
