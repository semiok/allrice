import { cookies } from 'next/headers';
import {
  RuntimeActionApprovalSnapshotSchema,
  RuntimeActionApprovalResponseSchema,
  runtimeContractEqual,
  type RequestContext,
} from '@allrice/contracts';
import {
  getNativeMcpApprovalTarget,
  getRuntimeActionApproval,
  listCloudRuntimeOperations,
  nativeMcpApprovalConfigured,
  RuntimePolicyError,
  type CloudOperationView,
} from '@allrice/database';
import { sessionCookieName } from '../identity/session';

/** null means an unrelated legacy operation. An enrolled native operation
 * never falls back to the PG decision writer when its Host is unavailable. */
export async function requestNativeActionApproval(
  context: RequestContext,
  approvalId: string,
  action: 'read' | 'answer' | 'cancel',
  response?: unknown,
): Promise<Record<string, unknown> | null> {
  const target = await getNativeMcpApprovalTarget(context, approvalId);
  if (!target) return null;
  if (action === 'cancel' ? !target.cutoff : target.cutoff)
    throw new RuntimePolicyError('native_action_unavailable');
  if (action !== 'cancel' && !target.displayable)
    throw new RuntimePolicyError('native_action_not_displayable');
  const token = (await cookies()).get(sessionCookieName)?.value;
  if (!token) throw new RuntimePolicyError('native_action_unavailable');
  const base = new URL(
    process.env.ALLRICE_WORKER_INTERNAL_URL?.trim() ||
      `http://127.0.0.1:${process.env.ALLRICE_WORKER_PORT ?? '3101'}`,
  );
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new RuntimePolicyError('native_action_unavailable');
  const result = await fetch(
    new URL('/internal/native-action-approval', base),
    {
      method: 'POST',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
        approvalId: target.approvalId,
        action,
        ...(action === 'answer' ? { response } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!result.ok) throw new RuntimePolicyError('native_action_unavailable');
  return result.json();
}

export async function projectNativeActionApprovals(
  context: RequestContext,
  operations: CloudOperationView[],
) {
  return Promise.all(
    operations.map(async (operation) => {
      if (operation.proposal?.kind !== 'mcp') return operation;
      const id = operation.snapshot.binding.attempt.operationId;
      const target = await getNativeMcpApprovalTarget(context, id);
      if (!target) return operation;
      // Durable responses are audit/consumption facts. Pending comes only from
      // the live native request; cached PG pending is never actionable here.
      if (operation.approval?.response) return operation;
      if (
        !target.displayable ||
        target.cutoff ||
        operation.mcpAuthorization?.available === false
      )
        return { ...operation, approval: null };
      try {
        const live = await requestNativeActionApproval(context, id, 'read');
        return {
          ...operation,
          approval: RuntimeActionApprovalSnapshotSchema.parse(live),
        };
      } catch {
        return { ...operation, approval: null };
      }
    }),
  );
}

/** Existing authenticated root cancellation is durable first. Deliver only
 * its negative cutoff to the same live native signal; cold cleanup belongs
 * to the existing Worker recovery tick, never a new waiting queue. */
export async function cancelNativeActionApprovals(
  context: RequestContext,
  runId: string,
) {
  if (!nativeMcpApprovalConfigured()) return;
  for (const operation of await listCloudRuntimeOperations(context, runId)) {
    if (
      operation.proposal?.kind !== 'mcp' ||
      operation.snapshot.status !== 'cancel_requested'
    )
      continue;
    await requestNativeActionApproval(
      context,
      operation.snapshot.binding.attempt.operationId,
      'cancel',
    ).catch(() => undefined);
  }
}

/** An exact completed-response retry acknowledges only the immutable receipt;
 * it cannot create or change a decision, consume, dispatch or revive a Host. */
export async function completedNativeActionResponse(
  context: RequestContext,
  id: string,
  input: unknown,
) {
  const saved = await getRuntimeActionApproval(context, id);
  if (!saved.response || !input || typeof input !== 'object')
    throw new RuntimePolicyError('native_action_unavailable');
  const response = RuntimeActionApprovalResponseSchema.parse(saved.response);
  const actual = {
    ...(input as Record<string, unknown>),
    respondedAt: response.respondedAt,
  };
  if (!runtimeContractEqual(actual, response))
    throw new RuntimePolicyError('approval_response_conflict');
  return { response };
}
