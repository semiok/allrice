import { z } from 'zod';

import { TimestampSchema, UuidSchema, VisibilitySchema } from './common.ts';
import { KnowledgeCitationSchema } from './knowledge.ts';
import {
  MemoryClassSchema,
  MemoryLifecycleStateSchema,
  MemorySourceTypeSchema,
} from './operations.ts';
import { UserQuestionAnswerSubmissionSchema } from './user-questions.ts';
import { ChangesetActionInputSchema } from './runtime-v2/changeset-execution.ts';

export const EmployeeVersionSchema = z
  .object({
    id: UuidSchema,
    employeeId: UuidSchema,
    version: z.number().int().positive(),
    name: z.string().min(1).max(120),
    model: z.string().min(1).max(120),
    systemPrompt: z.string().min(1).max(10_000),
    capabilities: z.array(z.string().min(1).max(64)),
    publishedAt: TimestampSchema,
  })
  .strict();

export const EmployeeAssignmentSchema = z
  .object({
    id: UuidSchema,
    employeeId: UuidSchema,
    employeeVersionId: UuidSchema,
    userId: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    isDefault: z.boolean(),
    version: EmployeeVersionSchema,
  })
  .strict();

export const ChatCitationSchema = z.union([
  z
    .object({
      type: z.enum(['memory', 'file']),
      id: UuidSchema,
      label: z.string().min(1).max(200),
    })
    .strict(),
  KnowledgeCitationSchema,
]);

export const ReviewContinuationInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('plan_review'),
      artifactId: UuidSchema,
      checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('version_feedback'),
      artifactId: UuidSchema,
      checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      feedbackId: UuidSchema,
    })
    .strict(),
]);
export type ReviewContinuationInput = z.infer<
  typeof ReviewContinuationInputSchema
>;

export const ChatMessageContentSchema = z
  .object({
    text: z.string().max(100_000),
    citations: z.array(ChatCitationSchema).default([]),
    interaction: z
      .union([
        z
          .object({
            type: z.literal('changeset_request'),
            action: ChangesetActionInputSchema,
          })
          .strict(),
        z
          .object({
            type: z.literal('user_question_answer'),
            answer: UserQuestionAnswerSubmissionSchema,
          })
          .strict(),
        z
          .object({
            type: z.literal('review_response'),
            review: ReviewContinuationInputSchema,
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();

export const ChatMessageSchema = z
  .object({
    id: UuidSchema,
    sessionId: UuidSchema,
    ownerId: UuidSchema,
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    content: ChatMessageContentSchema,
    status: z.enum(['pending', 'completed', 'failed']),
    errorCode: z.string().max(160).nullable().optional(),
    clientMessageId: UuidSchema.nullable(),
    replyToId: UuidSchema.nullable(),
    runId: UuidSchema.nullable(),
    attachments: z.array(
      z
        .object({
          id: UuidSchema,
          fileName: z.string().min(1).max(255),
          mediaType: z.string().min(1).max(255),
          sizeBytes: z.number().int().nonnegative(),
          restricted: z.boolean(),
        })
        .strict(),
    ),
    createdAt: TimestampSchema,
    completedAt: TimestampSchema.nullable(),
  })
  .strict();

export const ChatSessionSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    employeeAssignmentId: UuidSchema,
    employeeVersionId: UuidSchema,
    title: z.string().min(1).max(160),
    visibility: VisibilitySchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    archivedAt: TimestampSchema.nullable(),
  })
  .strict();

export const CreateChatSessionInputSchema = z
  .object({
    workspaceId: UuidSchema,
    employeeAssignmentId: UuidSchema.optional(),
    employeeVersionId: UuidSchema.optional(),
    title: z.string().trim().min(1).max(160).default('New session'),
  })
  .strict();

export const UpdateChatSessionInputSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    archived: z.boolean().optional(),
    visibility: VisibilitySchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    'at least one update is required',
  );

// User intent, not a tool grant or a budget supplied by the browser. Effective
// limits and employee/tenant authorization are resolved separately by the server.
export const AssistantPreferenceSchema = z
  .object({ mode: z.literal('daily'), allowAssistants: z.boolean() })
  .strict();
export type AssistantPreference = z.infer<typeof AssistantPreferenceSchema>;
export const AssistantControlActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('stop_child'),
      requestId: UuidSchema,
      childRunId: UuidSchema,
    })
    .strict(),
  z
    .object({ action: z.literal('cancel_root'), requestId: UuidSchema })
    .strict(),
]);
export type AssistantControlAction = z.infer<
  typeof AssistantControlActionSchema
>;

export function resolveAssistantPreference(
  preference: AssistantPreference | undefined,
  userText: string,
): AssistantPreference | undefined {
  // Only an explicit leading user directive is a deterministic restriction.
  // Quoted documents, attachments and mentions/questions are never interpreted
  // as instructions here. This parser can only remove permission, never grant it.
  const explicitOptOut =
    /^(?:本次|这次)?(?:不使用助手|不要使用助手|不要用助手|不用助手)(?:[，,。.!！：:\n]|$)/u.test(
      userText.trim(),
    );
  if (explicitOptOut) return { mode: 'daily', allowAssistants: false };
  return preference;
}

export const SendChatMessageInputSchema = z
  .object({
    clientMessageId: UuidSchema,
    text: z.string().trim().min(1).max(40_000),
    attachmentIds: z.array(UuidSchema).max(20).default([]),
    deliveryMode: z.enum(['auto', 'steer', 'follow_up']).default('auto'),
    expectedTurnId: z.string().trim().min(1).max(255).optional(),
    expectedGeneration: z.number().int().nonnegative().optional(),
    userQuestionAnswer: UserQuestionAnswerSubmissionSchema.optional(),
    reviewContinuation: ReviewContinuationInputSchema.optional(),
    changesetAction: ChangesetActionInputSchema.optional(),
    assistantPreference: AssistantPreferenceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.assistantPreference &&
      (value.deliveryMode !== 'follow_up' ||
        value.userQuestionAnswer ||
        value.reviewContinuation ||
        value.changesetAction)
    )
      context.addIssue({
        code: 'custom',
        message:
          'assistant preference applies only to a new ordinary queued task',
      });
    if (
      value.changesetAction &&
      (value.reviewContinuation ||
        value.userQuestionAnswer ||
        value.deliveryMode !== 'follow_up' ||
        value.attachmentIds.length)
    )
      context.addIssue({
        code: 'custom',
        message: 'changeset requests are distinct queued Runs',
      });
    if (
      value.reviewContinuation &&
      (value.userQuestionAnswer ||
        value.deliveryMode !== 'follow_up' ||
        value.attachmentIds.length)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'review continuation is a distinct queued Run, never an answer or action approval',
      });
    }
    if (
      value.deliveryMode === 'steer' &&
      (!value.expectedTurnId ||
        value.expectedGeneration === undefined ||
        value.attachmentIds.length)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'steer requires the exact active turn and no attachments',
      });
    }
    if (!value.userQuestionAnswer) return;
    if (
      value.deliveryMode !== 'steer' ||
      !value.expectedTurnId ||
      value.expectedGeneration === undefined ||
      value.attachmentIds.length > 0
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'user question answers require an exact active turn and no attachments',
      });
    }
  });

export const CreateSessionAttachmentInputSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    mediaType: z.enum([
      'text/plain',
      'text/markdown',
      'application/json',
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
    ]),
    contentBase64: z.string().min(1).max(28_000_000),
    visibility: VisibilitySchema.default('private'),
  })
  .strict();

export const LinkSessionAttachmentInputSchema = z
  .object({ objectId: UuidSchema })
  .strict();

export const CreateWorkspaceMemoryInputSchema = z
  .object({
    workspaceId: UuidSchema,
    employeeId: UuidSchema.nullable().default(null),
    content: z.string().trim().min(1).max(100_000),
    visibility: VisibilitySchema.default('private'),
    sourceType: MemorySourceTypeSchema,
    sourceId: UuidSchema.nullable().default(null),
    sourceLabel: z.string().trim().min(1).max(240).default('用户保存的记忆'),
    lifecycleState: MemoryLifecycleStateSchema.default('durable'),
    memoryClass: MemoryClassSchema.default('work_note'),
    confidence: z.number().min(0).max(1).default(1),
    expiresAt: TimestampSchema.nullable().default(null),
  })
  .strict();

export const WorkspaceMemorySchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    employeeId: UuidSchema.nullable(),
    ownerId: UuidSchema,
    content: z.string(),
    visibility: VisibilitySchema,
    sourceType: MemorySourceTypeSchema,
    sourceId: UuidSchema.nullable(),
    lifecycleState: MemoryLifecycleStateSchema,
    memoryClass: MemoryClassSchema,
    revision: z.number().int().positive(),
    trust: z.enum([
      'user_confirmed',
      'platform_verified',
      'derived',
      'untrusted_external',
    ]),
    confidence: z.number().min(0).max(1),
    sourceLabel: z.string(),
    capturedAt: TimestampSchema,
    expiresAt: TimestampSchema.nullable(),
    lastVerifiedAt: TimestampSchema.nullable(),
    supersedesMemoryId: UuidSchema.nullable(),
    lastRecalledAt: TimestampSchema.nullable(),
    recallCount: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
