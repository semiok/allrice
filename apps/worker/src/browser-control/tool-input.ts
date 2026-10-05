import { z } from 'zod';
import {
  BrowserActionSchema,
  BrowserNavigationUrlSchema,
  UuidSchema,
  ExecutionLocationSchema,
  StaticBrowserReferenceSchema,
  BrowserVerificationPlanSchema,
} from '@allrice/contracts';

/** This branch is deliberately absent from the ordinary employee manifest. */
export const PrivateQualityLiveInputSchema = z
  .object({
    command: z.literal('verify_live'),
    serviceId: UuidSchema,
  })
  .strict();

export const BrowserWorkspaceToolInputSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('profiles') }).strict(),
  z
    .object({
      command: z.literal('verify'),
      artifact: StaticBrowserReferenceSchema,
      plan: BrowserVerificationPlanSchema,
      location: ExecutionLocationSchema.optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal('open'),
      url: BrowserNavigationUrlSchema,
      grantId: UuidSchema.optional(),
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
