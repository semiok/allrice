import {
  ExecutionContextSchema,
  ApiErrorSchema,
  UuidSchema,
  type ExecutionContext,
} from '@allrice/contracts';
import { DataAccessError } from './data.ts';

/** Host-only migration adapter. A real 3.x lease is never a 4.0 execution.
 * Parsing this value does not authenticate it: the owning business primitive
 * still verifies its persisted Run, current access and exact worker lease. */
export interface LegacyMcpExecution {
  executionGeneration: '3.x';
  context: ExecutionContext;
  sessionId: string;
  worker: {
    workerId: string;
    jobId: string;
    leaseToken: string;
    attempt: number;
  };
}

export function legacyMcpScope(authority: LegacyMcpExecution) {
  const context = ExecutionContextSchema.parse(authority.context);
  if (
    authority.executionGeneration !== '3.x' ||
    !context.workspaceId ||
    authority.worker.workerId !== context.worker.id ||
    authority.worker.jobId !== context.jobId
  )
    throw new DataAccessError('authorization_denied');
  return {
    organizationId: context.organizationId,
    workspaceId: context.workspaceId,
    ownerId: context.policySnapshot.subjectId,
    sessionId: UuidSchema.parse(authority.sessionId),
    runId: context.runId,
  };
}

/** Existing API access-error projection at the owner boundary. Not a new
 * wire envelope: the outer result is the native MCP isError/text shape. */
export function legacyMcpAccessError(
  requestId: string,
  error: DataAccessError,
) {
  const codes = {
    authentication_required: 'AUTHENTICATION_REQUIRED',
    authorization_denied: 'AUTHORIZATION_DENIED',
    not_found: 'RESOURCE_NOT_FOUND',
    quota_exceeded: 'QUOTA_EXCEEDED',
    grant_invalid: 'SIGNED_ACCESS_DENIED',
  } as const;
  const value = ApiErrorSchema.parse({
    error: {
      code: codes[error.code],
      message: error.message,
      requestId,
      retryable: false,
    },
  });
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  };
}
