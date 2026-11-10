import { ApiErrorSchema } from '@allrice/contracts';
import type {
  ApiErrorCodeSchema,
  MemoryConflictDetails,
} from '@allrice/contracts';

export type ApiProblemCode = (typeof ApiErrorCodeSchema.options)[number];

export type ApiProblemOptions = {
  status: number;
  code: ApiProblemCode;
  message: string;
  retryable?: boolean;
  requestId?: string;
  details?: MemoryConflictDetails;
};

/** Edge-safe canonical JSON error envelope shared by routes and proxy gates. */
export function apiProblem({
  status,
  code,
  message,
  retryable = status >= 500,
  requestId = crypto.randomUUID(),
  details,
}: ApiProblemOptions) {
  if (details && status !== 409)
    throw new Error('Memory conflicts require HTTP 409');
  const body = ApiErrorSchema.parse({
    error: {
      code,
      message,
      requestId,
      retryable,
      ...(details ? { details } : {}),
    },
  });
  return Response.json(body, { status });
}

export function authenticationRequiredProblem(
  message = 'Authentication required',
) {
  return apiProblem({
    status: 401,
    code: 'AUTHENTICATION_REQUIRED',
    message,
    retryable: false,
  });
}

export function authorizationDeniedProblem(message = 'Access denied') {
  return apiProblem({
    status: 403,
    code: 'AUTHORIZATION_DENIED',
    message,
    retryable: false,
  });
}
