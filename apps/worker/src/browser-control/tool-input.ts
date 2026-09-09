import { z } from 'zod';
import {
  BrowserActionSchema,
  BrowserUrlSchema,
  UuidSchema,
} from '@allrice/contracts';

export const BrowserWorkspaceToolInputSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('open'), url: BrowserUrlSchema }).strict(),
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
