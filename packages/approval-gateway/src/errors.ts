import { randomUUID } from 'node:crypto';
import {
  ApiErrorSchema,
  ReferenceSelectionErrorSchema,
} from '@allrice/contracts';
import { z, ZodError } from 'zod';
import { ApprovalError } from './contract.js';

export const ApprovalPublicErrorSchema = z.union([
  ReferenceSelectionErrorSchema,
  ApiErrorSchema.refine(
    (value) => value.error.code !== 'REFERENCE_SELECTION_UNAVAILABLE',
  ),
]);
export type ApprovalPublicError = z.infer<typeof ApprovalPublicErrorSchema>;

/** Only registered host owners create this from their existing public error DTO.
 * Reference IDs must be a subset of the selectors actually received by that owner. */
export class ApprovalOwnerError extends Error {
  readonly publicError: ApprovalPublicError;
  constructor(
    input: unknown,
    allowedReferenceRevisionIds: readonly string[] = [],
  ) {
    const parsed = ApprovalPublicErrorSchema.parse(input);
    if (
      'referenceRevisionIds' in parsed.error &&
      parsed.error.referenceRevisionIds.some(
        (id) => !allowedReferenceRevisionIds.includes(id),
      )
    ) {
      throw new ApprovalError('DENIED');
    }
    super(parsed.error.code);
    this.name = 'ApprovalOwnerError';
    // Never propagate arbitrary upstream/SQL error messages, even when shaped like a public DTO.
    this.publicError = structuredClone({
      ...parsed,
      error: {
        ...parsed.error,
        message:
          parsed.error.code === 'REFERENCE_SELECTION_UNAVAILABLE'
            ? '所选资料版本当前不可用，请重新选择。'
            : '所属模块未能完成请求。',
      },
    });
  }
}
export function approvalPublicError(
  error: unknown,
  requestId: string = randomUUID(),
): ApprovalPublicError {
  if (error instanceof ApprovalOwnerError)
    return ApprovalPublicErrorSchema.parse({
      ...error.publicError,
      error: { ...error.publicError.error, requestId },
    });
  const code =
    error instanceof ApprovalError
      ? error.code
      : error instanceof ZodError || error instanceof SyntaxError
        ? 'INVALID_INPUT'
        : 'INTERNAL';
  const mapping = {
    DENIED: ['AUTHORIZATION_DENIED', '当前无权执行此操作。', false],
    REVOKED: ['AUTHORIZATION_DENIED', '外发批准已撤销。', false],
    INVALID_INPUT: ['VALIDATION_FAILED', '请求参数无效。', false],
    LIMIT_EXCEEDED: ['VALIDATION_FAILED', '请求超过已配置的业务上限。', false],
    CONFLICT: ['CONFLICT', '请求版本或业务状态已改变。', false],
    NOT_CONFIRMED: ['APPROVAL_REQUIRED', '需要本人在可信页面确认。', false],
    UNAVAILABLE: [
      'DEPENDENCY_UNAVAILABLE',
      '依赖当前不可用；未知外发效果只能对账。',
      true,
    ],
    INTEGRITY: ['INTERNAL_ERROR', '外发请求或回执完整性校验失败。', false],
    INTERNAL: ['INTERNAL_ERROR', '请求未能完成。', false],
  } as const;
  const [publicCode, message, retryable] = mapping[code];
  return ApiErrorSchema.parse({
    error: { code: publicCode, message, requestId, retryable },
  });
}
export function approvalErrorStatus(
  error: unknown,
  value: ApprovalPublicError,
): number {
  if (error instanceof ApprovalError && error.code === 'LIMIT_EXCEEDED')
    return 413;
  switch (value.error.code) {
    case 'AUTHENTICATION_REQUIRED':
      return 401;
    case 'AUTHORIZATION_DENIED':
    case 'REFERENCE_SELECTION_UNAVAILABLE':
      return 403;
    case 'CONFLICT':
    case 'VERSION_CONFLICT':
      return 409;
    case 'DEPENDENCY_UNAVAILABLE':
      return 503;
    case 'INTERNAL_ERROR':
      return 500;
    case 'NOT_FOUND':
    case 'RESOURCE_NOT_FOUND':
      return 404;
    default:
      return 400;
  }
}
