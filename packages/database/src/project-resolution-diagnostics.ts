import {
  ProjectDependencyResolutionReceiptSchema,
  RuntimeActionBindingSchema,
  runtimeContractEqual,
  type ExecutionContext,
  type StoragePort,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { publishWorkbenchArtifact } from './artifact-review.ts';
import { checkCloudBindingAuthority } from './cloud-authority.ts';
import { RuntimePolicyError } from './runtime-policy.ts';

/** Publish only the bounded, redacted diagnostic receipt already owned by this
 * exact Run. Never accept caller-supplied log bytes or publish package contents. */
export async function publishProjectResolutionDiagnostics(
  input: { context: ExecutionContext; sessionId: string; operationId: string },
  storage: StoragePort,
  db: ReturnType<typeof getDatabase> = getDatabase(),
) {
  const ctx = input.context;
  const read = async (tx: Parameters<typeof checkCloudBindingAuthority>[0]) => {
    const [row] =
      await tx`select i.binding,i.payload,a.outcome,a.cleanup_confirmed_at
      from allrice_cloud_execution_inputs i join allrice_cloud_execution_attempts a on a.operation_id=i.operation_id
      where i.operation_id=${input.operationId} and i.organization_id=${ctx.organizationId}
        and i.workspace_id=${ctx.workspaceId!} and i.owner_id=${ctx.policySnapshot.subjectId} and i.run_id=${ctx.runId}`;
    if (
      !row ||
      row.payload.origin?.toolName !== 'workspace.project' ||
      !row.outcome?.stopped ||
      row.outcome.reason !== 'failed' ||
      !row.cleanup_confirmed_at
    )
      throw new RuntimePolicyError('cloud_resolution_diagnostics_unavailable');
    const binding = RuntimeActionBindingSchema.parse(row.binding);
    if (binding.task.chatSessionId !== input.sessionId)
      throw new RuntimePolicyError('cloud_resolution_diagnostics_unavailable');
    await checkCloudBindingAuthority(
      tx,
      {
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId!,
        requestId: input.operationId,
        actor: { type: 'user', id: ctx.policySnapshot.subjectId },
      },
      binding,
    );
    const receipt = ProjectDependencyResolutionReceiptSchema.safeParse(
      row.outcome.resolution,
    );
    return {
      operationId: input.operationId,
      status: 'failed',
      installed: false,
      errorCode:
        row.outcome.errorCode ??
        (receipt.success ? receipt.data.errorCode : undefined) ??
        'PROJECT_RESOLUTION_FAILED',
      exitCode: row.outcome.exitCode,
      ...(receipt.success
        ? {
            manager: receipt.data.manager,
            phase: receipt.data.phase,
            diagnostics: receipt.data.diagnostics,
          }
        : {}),
    };
  };
  const report = await db.begin(read);
  const a = await publishWorkbenchArtifact(
    {
      context: ctx,
      sessionId: input.sessionId,
      callId: `resolution-diagnostics:${input.operationId}`,
      kind: 'document',
      fileName: '依赖准备失败诊断.json',
      format: 'json',
      mediaType: 'application/json',
      bytes: Buffer.from(JSON.stringify(report, null, 2)),
      changeSummary: '依赖准备未完成；保留真实退出码与有限诊断。',
    },
    storage,
    db,
    {
      requiredTool: 'workspace.project',
      runId: ctx.runId,
      projectDelivery: { operationId: null, execution: null },
      admit: async (tx) => {
        if (!runtimeContractEqual(report, await read(tx)))
          throw new RuntimePolicyError('cloud_resolution_diagnostics_changed');
      },
    },
  );
  return {
    objectId: a.object.id,
    versionId: a.id,
    fileName: a.version.fileName,
    downloadUrl: `/api/v1/files/${a.object.id}/download?workspaceId=${ctx.workspaceId}&name=${encodeURIComponent(a.version.fileName)}`,
  };
}
