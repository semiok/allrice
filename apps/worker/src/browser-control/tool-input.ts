import { z } from 'zod';
import {
  BrowserActionSchema,
  BrowserUrlSchema,
  UuidSchema,
  ExecutionLocationSchema,
} from '@allrice/contracts';

export const BrowserWorkspaceToolInputSchema = z.discriminatedUnion('command', [
  z
    .object({
      command: z.literal('open'),
      url: BrowserUrlSchema,
      location: ExecutionLocationSchema.optional(),
      requireLocalInputs: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal('close'),
      workspaceId: UuidSchema,
      fence: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      command: z.literal('act'),
      workspaceId: UuidSchema,
      profileId: UuidSchema,
      fence: z.number().int().positive(),
      observationId: UuidSchema.nullable(),
      action: BrowserActionSchema.refine(
        (a) => a.type !== 'sensitive_fill' && a.type !== 'request',
      ),
    })
    .strict(),
]);
