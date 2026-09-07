import { z } from 'zod';

import { TimestampSchema, UuidSchema } from '../common.ts';
import { ChecksumSchema } from '../runs.ts';
import {
  UserQuestionAnswerSubmissionSchema,
  UserQuestionRequestSchema,
} from '../user-questions.ts';
import {
  matchesRuntimeScope,
  RuntimeActionBindingSchema,
  RuntimeContentRefSchema,
  RuntimeContractVersionSchema,
  RuntimeCounterSchema,
  runtimeContractEqual,
  RuntimeEvidenceRefSchema,
  RuntimeScopeSchema,
  RuntimeTaskRefSchema,
} from './identity.ts';

export const RuntimeTurnRefSchema = z
  .object({
    turnId: z.string().trim().min(1).max(255),
    generation: RuntimeCounterSchema,
  })
  .strict();
export type RuntimeTurnRef = z.infer<typeof RuntimeTurnRefSchema>;

const requestFields = {
  contractVersion: RuntimeContractVersionSchema,
  direction: z.literal('request'),
  // Correlation only; action approval authority remains the existing approvalId.
  requestId: UuidSchema,
  version: z.number().int().positive(),
  requestDigest: ChecksumSchema,
  task: RuntimeTaskRefSchema,
  respondentId: UuidSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
};

const responseFields = {
  contractVersion: RuntimeContractVersionSchema,
  direction: z.literal('response'),
  requestId: UuidSchema,
  version: z.number().int().positive(),
  requestDigest: ChecksumSchema,
  task: RuntimeTaskRefSchema,
  responseId: UuidSchema,
  respondedBy: UuidSchema,
  respondedAt: TimestampSchema,
};

function checkRequestLifetime(
  request: { createdAt: string; expiresAt: string },
  ctx: z.RefinementCtx,
) {
  if (Date.parse(request.expiresAt) <= Date.parse(request.createdAt)) {
    ctx.addIssue({
      code: 'custom',
      message: 'request expiry must follow creation',
    });
  }
}

export const RuntimeAskUserRequestSchema = z
  .object({
    ...requestFields,
    kind: z.literal('ask_user'),
    turn: RuntimeTurnRefSchema,
    question: UserQuestionRequestSchema,
  })
  .strict()
  .superRefine(checkRequestLifetime)
  .superRefine((request, ctx) => {
    const questionIds = request.question.questions.map((item) => item.id);
    if (new Set(questionIds).size !== questionIds.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate question item IDs' });
    }
    for (const item of request.question.questions) {
      const labels = (item.options ?? []).map((option) => option.label);
      if (new Set(labels).size !== labels.length) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicate question option labels',
        });
      }
    }
  });

export const RuntimePlanReviewRequestSchema = z
  .object({
    ...requestFields,
    kind: z.literal('plan_review'),
    content: RuntimeContentRefSchema,
    prompt: z.string().trim().min(1).max(4_000),
  })
  .strict()
  .superRefine(checkRequestLifetime);

export const RuntimeVersionFeedbackRequestSchema = z
  .object({
    ...requestFields,
    kind: z.literal('version_feedback'),
    content: RuntimeContentRefSchema,
    prompt: z.string().trim().min(1).max(4_000),
  })
  .strict()
  .superRefine(checkRequestLifetime);

export const RuntimeActionApprovalRequestSchema = z
  .object({
    ...requestFields,
    kind: z.literal('action_approval'),
    approvalId: UuidSchema,
    binding: RuntimeActionBindingSchema,
  })
  .strict()
  .superRefine(checkRequestLifetime)
  .superRefine((request, ctx) => {
    if (!runtimeContractEqual(request.task, request.binding.task)) {
      ctx.addIssue({
        code: 'custom',
        message: 'approval task differs from action binding',
      });
    }
  });
export type RuntimeActionApprovalRequest = z.infer<
  typeof RuntimeActionApprovalRequestSchema
>;

/** Metadata for interaction requests, not an authorization or persistence API. */
export const RuntimeInteractionRequestSchema = z.discriminatedUnion('kind', [
  RuntimeAskUserRequestSchema,
  RuntimePlanReviewRequestSchema,
  RuntimeVersionFeedbackRequestSchema,
  RuntimeActionApprovalRequestSchema,
]);
export type RuntimeInteractionRequest = z.infer<
  typeof RuntimeInteractionRequestSchema
>;

export const RuntimeAskUserResponseSchema = z
  .object({
    ...responseFields,
    kind: z.literal('ask_user'),
    turn: RuntimeTurnRefSchema,
    answer: UserQuestionAnswerSubmissionSchema,
  })
  .strict();

export const RuntimePlanReviewResponseSchema = z
  .object({
    ...responseFields,
    kind: z.literal('plan_review'),
    content: RuntimeContentRefSchema,
    decision: z.enum(['accepted', 'revision_requested']),
    feedback: z.string().trim().min(1).max(20_000).nullable(),
  })
  .strict()
  .superRefine((response, ctx) => {
    if (
      response.decision === 'revision_requested' &&
      response.feedback === null
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'revision request requires feedback',
      });
    }
  });

export const RuntimeVersionFeedbackResponseSchema = z
  .object({
    ...responseFields,
    kind: z.literal('version_feedback'),
    content: RuntimeContentRefSchema,
    feedback: z.string().trim().min(1).max(20_000),
  })
  .strict();

export const RuntimeActionApprovalResponseSchema = z
  .object({
    ...responseFields,
    kind: z.literal('action_approval'),
    approvalId: UuidSchema,
    decision: z.enum(['approved', 'rejected']),
  })
  .strict();
export type RuntimeActionApprovalResponse = z.infer<
  typeof RuntimeActionApprovalResponseSchema
>;

export const RuntimeInteractionResponseSchema = z.discriminatedUnion('kind', [
  RuntimeAskUserResponseSchema,
  RuntimePlanReviewResponseSchema,
  RuntimeVersionFeedbackResponseSchema,
  RuntimeActionApprovalResponseSchema,
]);
export type RuntimeInteractionResponse = z.infer<
  typeof RuntimeInteractionResponseSchema
>;

const interactionMatchContextSchema = z
  .object({
    trustedScope: RuntimeScopeSchema,
    task: RuntimeTaskRefSchema,
    respondentId: UuidSchema,
    activeTurn: RuntimeTurnRefSchema.nullable(),
    now: TimestampSchema,
  })
  .strict();
export type RuntimeInteractionMatchContext = z.infer<
  typeof interactionMatchContextSchema
>;

function matchesQuestionAnswer(
  request: z.infer<typeof RuntimeAskUserRequestSchema>,
  response: z.infer<typeof RuntimeAskUserResponseSchema>,
): boolean {
  if (request.question.questionId !== response.answer.questionId) return false;
  const items = request.question.questions;
  const answers = response.answer.answers;
  if (items.length !== answers.length) return false;
  if (new Set(answers.map((answer) => answer.id)).size !== answers.length)
    return false;
  return answers.every((answer) => {
    const item = items.find((candidate) => candidate.id === answer.id);
    if (!item) return false;
    if (new Set(answer.selected).size !== answer.selected.length) return false;
    if (!item.multiSelect && answer.selected.length > 1) return false;
    if (answer.selected.length === 0 && !answer.custom) return false;
    const labels = new Set((item.options ?? []).map((option) => option.label));
    return answer.selected.every((label) => labels.has(label));
  });
}

/**
 * Pure correlation check against caller-resolved trusted state. A true result is
 * not authorization, adoption, duplicate consumption protection or a saved reply.
 * Callers must validate actor credentials, request digests and current policy.
 */
export function matchesRuntimeInteractionResponse(
  requestInput: unknown,
  responseInput: unknown,
  contextInput: RuntimeInteractionMatchContext,
): boolean {
  const requestResult = RuntimeInteractionRequestSchema.safeParse(requestInput);
  const responseResult =
    RuntimeInteractionResponseSchema.safeParse(responseInput);
  const contextResult = interactionMatchContextSchema.safeParse(contextInput);
  if (
    !requestResult.success ||
    !responseResult.success ||
    !contextResult.success
  )
    return false;
  const request = requestResult.data;
  const response = responseResult.data;
  const context = contextResult.data;
  const now = Date.parse(context.now);
  if (
    !matchesRuntimeScope(request.task.scope, context.trustedScope) ||
    !matchesRuntimeScope(context.task.scope, context.trustedScope) ||
    !runtimeContractEqual(request.task, context.task) ||
    !runtimeContractEqual(response.task, request.task) ||
    request.kind !== response.kind ||
    request.requestId !== response.requestId ||
    request.version !== response.version ||
    request.requestDigest !== response.requestDigest ||
    request.respondentId !== context.respondentId ||
    response.respondedBy !== context.respondentId ||
    Date.parse(request.createdAt) > now ||
    Date.parse(request.expiresAt) <= now ||
    Date.parse(response.respondedAt) < Date.parse(request.createdAt) ||
    Date.parse(response.respondedAt) > now
  )
    return false;

  if (request.kind === 'ask_user' && response.kind === 'ask_user') {
    return (
      context.activeTurn !== null &&
      runtimeContractEqual(request.turn, context.activeTurn) &&
      runtimeContractEqual(response.turn, request.turn) &&
      matchesQuestionAnswer(request, response)
    );
  }
  if (
    request.kind === 'action_approval' &&
    response.kind === 'action_approval'
  ) {
    return request.approvalId === response.approvalId;
  }
  if (
    (request.kind === 'plan_review' && response.kind === 'plan_review') ||
    (request.kind === 'version_feedback' &&
      response.kind === 'version_feedback')
  )
    return runtimeContractEqual(request.content, response.content);
  return false;
}

export const RuntimeActionApprovalSnapshotSchema = z
  .object({
    request: RuntimeActionApprovalRequestSchema,
    response: RuntimeActionApprovalResponseSchema.nullable(),
    consumedAt: TimestampSchema.nullable(),
    revokedAt: TimestampSchema.nullable(),
  })
  .strict();
export type RuntimeActionApprovalSnapshot = z.infer<
  typeof RuntimeActionApprovalSnapshotSchema
>;

const actionApprovalMatchContextSchema = interactionMatchContextSchema
  .extend({
    binding: RuntimeActionBindingSchema,
  })
  .strict();
export type RuntimeActionApprovalMatchContext = z.infer<
  typeof actionApprovalMatchContextSchema
>;

/**
 * Checks an unconsumed snapshot's exact binding. Does NOT authorize or consume
 * an approval; atomic consumption/revocation races belong to the later Broker.
 */
export function matchesRuntimeActionApproval(
  snapshotInput: unknown,
  contextInput: RuntimeActionApprovalMatchContext,
): boolean {
  const snapshotResult =
    RuntimeActionApprovalSnapshotSchema.safeParse(snapshotInput);
  const contextResult =
    actionApprovalMatchContextSchema.safeParse(contextInput);
  if (!snapshotResult.success || !contextResult.success) return false;
  const snapshot = snapshotResult.data;
  const { binding, ...context } = contextResult.data;
  if (
    snapshot.response?.decision !== 'approved' ||
    snapshot.consumedAt !== null ||
    snapshot.revokedAt !== null ||
    !runtimeContractEqual(snapshot.request.binding, binding)
  )
    return false;
  return matchesRuntimeInteractionResponse(
    snapshot.request,
    snapshot.response,
    context,
  );
}

export const RuntimeTypedInputKindSchema = z.enum([
  'steer_current',
  'queue_next',
  'interrupt_adjust',
]);

const typedInputFields = {
  contractVersion: RuntimeContractVersionSchema,
  inputId: UuidSchema,
  scope: RuntimeScopeSchema,
  chatSessionId: UuidSchema,
  actorId: UuidSchema,
  text: z.string().trim().min(1).max(40_000),
  submittedAt: TimestampSchema,
};

export const RuntimeTypedInputSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...typedInputFields,
        kind: z.literal('steer_current'),
        task: RuntimeTaskRefSchema,
        turn: RuntimeTurnRefSchema,
      })
      .strict(),
    z
      .object({
        ...typedInputFields,
        kind: z.literal('queue_next'),
        afterRunId: UuidSchema.nullable(),
      })
      .strict(),
    z
      .object({
        ...typedInputFields,
        kind: z.literal('interrupt_adjust'),
        task: RuntimeTaskRefSchema,
        turn: RuntimeTurnRefSchema,
      })
      .strict(),
  ])
  .superRefine((input, ctx) => {
    if (input.kind === 'queue_next') return;
    if (
      !matchesRuntimeScope(input.scope, input.task.scope) ||
      input.chatSessionId !== input.task.chatSessionId
    )
      ctx.addIssue({
        code: 'custom',
        message: 'input task/session scope mismatch',
      });
  });
export type RuntimeTypedInput = z.infer<typeof RuntimeTypedInputSchema>;

const typedInputMatchContextSchema = z
  .object({
    trustedScope: RuntimeScopeSchema,
    chatSessionId: UuidSchema,
    actorId: UuidSchema,
    activeTask: RuntimeTaskRefSchema.nullable(),
    activeTurn: RuntimeTurnRefSchema.nullable(),
  })
  .strict();
export type RuntimeTypedInputMatchContext = z.infer<
  typeof typedInputMatchContextSchema
>;

/** Scope/turn admission precondition only; does not deliver, interrupt or dedupe. */
export function matchesRuntimeTypedInput(
  inputValue: unknown,
  contextInput: RuntimeTypedInputMatchContext,
): boolean {
  const inputResult = RuntimeTypedInputSchema.safeParse(inputValue);
  const contextResult = typedInputMatchContextSchema.safeParse(contextInput);
  if (!inputResult.success || !contextResult.success) return false;
  const input = inputResult.data;
  const context = contextResult.data;
  if (
    !matchesRuntimeScope(input.scope, context.trustedScope) ||
    input.chatSessionId !== context.chatSessionId ||
    input.actorId !== context.actorId
  )
    return false;
  if (
    context.activeTask !== null &&
    (!matchesRuntimeScope(context.activeTask.scope, context.trustedScope) ||
      context.activeTask.chatSessionId !== context.chatSessionId)
  )
    return false;
  if (input.kind === 'queue_next') {
    return (
      input.afterRunId === null ||
      input.afterRunId === context.activeTask?.runId
    );
  }
  return (
    context.activeTask !== null &&
    context.activeTurn !== null &&
    runtimeContractEqual(input.task, context.activeTask) &&
    runtimeContractEqual(input.turn, context.activeTurn)
  );
}

const receiptFields = {
  contractVersion: RuntimeContractVersionSchema,
  inputId: UuidSchema,
  inputKind: RuntimeTypedInputKindSchema,
  inputDigest: ChecksumSchema,
  scope: RuntimeScopeSchema,
  chatSessionId: UuidSchema,
  recordedAt: TimestampSchema,
};

/** Receipts describe distinct facts; accepted/received is never DSH adoption. */
export const RuntimeInputReceiptSchema = z
  .discriminatedUnion('status', [
    z.object({ ...receiptFields, status: z.literal('received') }).strict(),
    z
      .object({
        ...receiptFields,
        status: z.literal('queued'),
        inputKind: z.literal('queue_next'),
        position: RuntimeCounterSchema,
      })
      .strict(),
    z
      .object({
        ...receiptFields,
        status: z.literal('pending'),
        reason: z.enum(['waiting_runtime', 'waiting_interrupt']),
      })
      .strict(),
    z
      .object({
        ...receiptFields,
        status: z.literal('adopted'),
        appliedTo: RuntimeTaskRefSchema,
        turn: RuntimeTurnRefSchema,
        evidence: RuntimeEvidenceRefSchema,
      })
      .strict(),
    z
      .object({
        ...receiptFields,
        status: z.literal('rejected'),
        reason: z.string().trim().min(1).max(160),
      })
      .strict(),
  ])
  .superRefine((receipt, ctx) => {
    if (
      receipt.status === 'pending' &&
      receipt.reason === 'waiting_interrupt' &&
      receipt.inputKind !== 'interrupt_adjust'
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'only interrupt-adjust input may wait for an interruption',
      });
    }
    if (receipt.status !== 'adopted') return;
    if (
      !matchesRuntimeScope(receipt.scope, receipt.appliedTo.scope) ||
      receipt.chatSessionId !== receipt.appliedTo.chatSessionId ||
      Date.parse(receipt.evidence.recordedAt) > Date.parse(receipt.recordedAt)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'adoption evidence/task scope mismatch',
      });
  });
export type RuntimeInputReceipt = z.infer<typeof RuntimeInputReceiptSchema>;
