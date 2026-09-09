import { z } from 'zod';
import {
  BrowserActionSchema,
  BrowserUrlSchema,
  UuidSchema,
} from '@allrice/contracts';
const workspace = {
  workspaceId: UuidSchema,
  profileId: UuidSchema,
  fence: z.number().int().positive(),
};
export const LocalBrowserToolInputSchema = z.discriminatedUnion('command', [
  z
    .object({
      command: z.literal('open'),
      grantId: UuidSchema,
      url: BrowserUrlSchema,
    })
    .strict(),
  z.object({ command: z.literal('observe'), ...workspace }).strict(),
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
      ...workspace,
      observationId: UuidSchema.nullable(),
      action: BrowserActionSchema.refine(
        (a) => a.type !== 'sensitive_fill' && a.type !== 'request',
      ),
    })
    .strict(),
]);
