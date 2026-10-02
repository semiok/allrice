import { createHash } from 'node:crypto';
import {
  allRiceToolManifest,
  TaskNextStepsSchema,
  type EmployeeManifest,
  type TaskNextStep,
  type TaskNextSteps,
  type TaskNextStepsInput,
  type WorkbenchArtifact,
  type Visibility,
} from '@allrice/contracts';

const capabilities = new Map(
  allRiceToolManifest.map((t) => [t.canonicalName as string, t.capability]),
);
export interface NextStepsFacts {
  scope: TaskNextStepsInput & { organizationId: string; viewerId: string };
  manifest: EmployeeManifest;
  run: { id: string; state: string; errorCode: string | null } | null;
  unknown: boolean;
  errorCodes: string[];
  artifacts: WorkbenchArtifact[];
  visibility: Record<string, Visibility>;
  bridgePreparationAllowed: boolean;
}

/** Display-only rules over authorized server facts. No filenames, exit codes,
 * model text or tool paths are used to infer delivery or employee capability. */
export function projectTaskNextSteps(facts: NextStepsFacts): TaskNextSteps {
  const { manifest, run } = facts;
  const modern = manifest.schemaVersion === 2 ? manifest : null;
  const denied = new Set(modern?.securityPolicy.deniedCapabilities ?? []);
  const tools = new Set(modern?.capabilityBindings.toolNames ?? []);
  const canModel =
    manifest.provider.provider !== 'basic' &&
    manifest.capabilities.includes('model:invoke') &&
    !denied.has('model:invoke');
  const allows = (tool: string) => {
    const cap = capabilities.get(tool);
    return (
      canModel &&
      !!cap &&
      tools.has(tool) &&
      manifest.capabilities.includes(cap) &&
      !denied.has(cap)
    );
  };
  const office = modern?.runtimePackage?.skills.find(
    (s) =>
      s.name === 'office' &&
      s.invocation.modelInvocable &&
      s.requiredToolRefs.every(allows) &&
      [
        'workspace.document.read',
        'workspace.skill.read',
        'workspace.export.create',
      ].every((t) => s.requiredToolRefs.includes(t)),
  );
  const canOffice =
    !!office &&
    [
      'workspace.document.read',
      'workspace.skill.read',
      'workspace.export.create',
    ].every(allows);
  const artifacts = run
    ? facts.artifacts
        .filter(
          (a) =>
            a.provenance.kind !== 'legacy_deliverable' &&
            a.provenance.runId === run.id &&
            !a.stale &&
            !a.object.deletedAt &&
            !!facts.visibility[a.object.id] &&
            a.version.sessionId === facts.scope.sessionId &&
            a.object.ownerId === facts.scope.viewerId &&
            a.object.workspaceId === facts.scope.workspaceId &&
            a.object.organizationId === facts.scope.organizationId,
        )
        .slice(0, 50)
    : [];
  const state: TaskNextSteps['state'] = !run
    ? 'idle'
    : facts.unknown
      ? 'unknown'
      : run.state === 'succeeded' ||
          run.state === 'failed' ||
          run.state === 'canceled'
        ? run.state
        : 'running';
  const suggestions: TaskNextStep[] = [];
  function add(
    id: string,
    title: string,
    template: string,
    artifact: WorkbenchArtifact,
    report = false,
  ) {
    if (
      suggestions.length >= 3 ||
      suggestions.some((s) => s.task.id.startsWith(id + '-'))
    )
      return;
    suggestions.push({
      source: 'context-rule',
      task: {
        id: `${id}-${artifact.version.id}`,
        title,
        template,
        description: '使用本轮已交付的原件；预览状态不影响读取。',
        ...(report ? { readiness: ['report'] as const } : {}),
      },
      references: [
        {
          objectId: artifact.object.id,
          versionId: artifact.version.id,
          checksum: artifact.object.checksum,
          fileName: artifact.version.fileName,
          mediaType: artifact.object.mediaType,
          sizeBytes: artifact.object.sizeBytes,
          visibility: facts.visibility[artifact.object.id]!,
        },
      ],
    });
  }
  // An active or unknown execution is never a recommendation to replay it.
  if (canModel && state !== 'running' && state !== 'unknown') {
    for (const artifact of artifacts) {
      if (artifact.kind === 'changeset') {
        if (allows('workspace.document.read'))
          add(
            'review-changeset',
            '检查变更与风险',
            '读取这份已有变更，梳理影响范围、潜在风险、待验证的行为和检查清单；先不要执行或应用变更。',
            artifact,
          );
      } else if (
        ['xlsx', 'json'].includes(artifact.version.format) ||
        artifact.object.mediaType === 'text/csv'
      ) {
        if (allows('workspace.document.read'))
          add(
            'check-data',
            '检查数据与异常',
            '读取这份已有成果，核对原始字段、缺失值、负数与计算依据，列出需要人工确认的异常；先不要修改原件。',
            artifact,
          );
        if (allows('python.execute') && allows('workspace.document.read'))
          add(
            'make-chart',
            '制作数据图表',
            '根据这份已有成果制作可下载的中文数据图表，保留编号、负数与缺失值，说明计算依据和局限。',
            artifact,
          );
        if (canOffice)
          add(
            'prepare-report',
            '准备汇报',
            '根据这份已有成果制作可编辑的 PPT 汇报，先核对关键数据与异常，保留来源和需要确认的问题。',
            artifact,
            true,
          );
      } else if (artifact.version.format === 'png' && canOffice) {
        add(
          'prepare-report',
          '准备汇报',
          '使用这份已有图片制作可编辑的 PPT 汇报，保留原图和来源，说明需要补充的文字与依据。',
          artifact,
          true,
        );
      } else if (
        ['docx', 'pptx', 'pdf', 'markdown', 'text'].includes(
          artifact.version.format,
        )
      ) {
        if (allows('workspace.document.read'))
          add(
            'summarize',
            '提炼重点与待办',
            '阅读这份已有成果，提炼结论、关键依据、待办和需要确认的问题，保留来源与不确定性。',
            artifact,
          );
        if (canOffice)
          add(
            'prepare-report',
            '准备汇报',
            '根据这份已有成果制作可编辑的 PPT 汇报，保留关键依据、来源与需要确认的问题。',
            artifact,
            true,
          );
      }
    }
    const codes = new Set([run?.errorCode, ...facts.errorCodes]);
    const preparation =
      codes.has('TOOL_FILE_NOT_FOUND') ||
      codes.has('TOOL_SOURCE_CHANGED') ||
      codes.has('PDF_SOURCE_UNAVAILABLE')
        ? 'files'
        : codes.has('MCP_AUTH_REQUIRED')
          ? 'connections'
          : codes.has('local_runner_unavailable') ||
              codes.has('PYTHON_LOCAL_UNAVAILABLE') ||
              codes.has('PDF_LOCAL_UNAVAILABLE') ||
              codes.has('OFFICE_LOCAL_UNAVAILABLE')
            ? 'bridge'
            : null;
    const supportsPreparation =
      preparation === 'files'
        ? allows('workspace.document.read')
        : preparation === 'connections'
          ? allows('local.mcp.call') || allows('cloud.mcp.call')
          : preparation === 'bridge'
            ? facts.bridgePreparationAllowed &&
              [...tools].some(
                (t) =>
                  allows(t) &&
                  (t.startsWith('local.') ||
                    t === 'python.execute' ||
                    t === 'workspace.document.read'),
              )
            : false;
    if (
      state === 'failed' &&
      preparation &&
      supportsPreparation &&
      suggestions.length < 3
    )
      suggestions.push({
        source: 'context-rule',
        task: {
          id: `prepare-${preparation}`,
          title:
            preparation === 'files'
              ? '补充所需资料'
              : preparation === 'connections'
                ? '检查应用连接'
                : '检查电脑执行条件',
          description: '先补齐已明确缺少的条件；不会自动重试任务。',
          template:
            '我会先补齐这项工作的资料或连接条件。请核对已有结果与缺项，再说明可以继续处理的部分；不要重复尚未确认的操作。',
          preparation: [preparation],
        },
        references: [],
      });
  }
  const notice =
    state === 'unknown'
      ? '执行结果尚未确认，请先核对已执行的操作；不会建议重跑。'
      : state === 'canceled'
        ? `本轮已取消${artifacts.length ? `，保留了 ${artifacts.length} 份可读成果` : ''}。`
        : state === 'failed'
          ? artifacts.length
            ? `本轮未全部完成，已有 ${artifacts.length} 份可读成果可继续使用。`
            : '本轮未完成。仅对明确缺项提供准备建议，不推测错误原因。'
          : state === 'running'
            ? '本轮仍在进行，下一步将在正式结果更新后提供。'
            : '';
  const scope = { ...facts.scope, sourceRunId: run?.id ?? null };
  const contextRevision =
    'sha256:' +
    createHash('sha256')
      .update(
        JSON.stringify({
          scope,
          state,
          errorCodes: [...facts.errorCodes].sort(),
          errorCode: run?.errorCode,
          references: artifacts.map((a) => [a.version.id, a.object.checksum]),
          suggestions,
        }),
      )
      .digest('hex');
  return TaskNextStepsSchema.parse({
    contractVersion: 1,
    scope: { ...scope, contextRevision },
    state,
    readableArtifactCount: artifacts.length,
    notice,
    suggestions,
  });
}
