import { z } from 'zod';

import { TimestampSchema, UuidSchema, VisibilitySchema } from './common.ts';
import { KnowledgeCitationSchema } from './knowledge.ts';

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

export const ChatMessageContentSchema = z
  .object({
    text: z.string().max(100_000),
    citations: z.array(ChatCitationSchema).default([]),
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

export const SendChatMessageInputSchema = z
  .object({
    clientMessageId: UuidSchema,
    text: z.string().trim().min(1).max(40_000),
    attachmentIds: z.array(UuidSchema).max(8).default([]),
    deliveryMode: z.enum(['auto', 'steer', 'follow_up']).default('auto'),
    expectedTurnId: z.string().trim().min(1).max(255).optional(),
    expectedGeneration: z.number().int().nonnegative().optional(),
  })
  .strict();

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
    ]),
    contentBase64: z.string().min(1).max(12_000_000),
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
    sourceType: z.enum(['user', 'message', 'file']),
    sourceId: UuidSchema.nullable().default(null),
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
    sourceType: z.enum(['user', 'message', 'file']),
    sourceId: UuidSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
