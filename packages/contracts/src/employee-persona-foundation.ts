import { z } from 'zod';

import { EmployeeAccentColorSchema } from './employee-colors.ts';

// Platform-owned source fields only. Personal overrides and rendered PERSONA
// belong to the Run snapshot, not to the published runtime package.
export const EmployeePersonaFoundationSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000),
    appearance: z
      .object({
        avatarType: z.enum(['initials', 'emoji', 'image']),
        avatarValue: z.string().trim().min(1).max(500),
        accentColor: EmployeeAccentColorSchema.optional(),
      })
      .strict(),
    identity: z
      .object({
        role: z.string().trim().min(1).max(120),
        mission: z.string().trim().min(1).max(500),
        workStyle: z.string().trim().min(1).max(1_000),
        behaviorRules: z.array(z.string().trim().min(1).max(500)).max(32),
        safetyBoundaries: z.array(z.string().trim().min(1).max(500)).max(32),
        expressionStyle: z.enum(['concise', 'structured', 'exploratory']),
        outputLanguage: z.enum(['zh-CN', 'en-US']),
      })
      .strict(),
  })
  .strict();
