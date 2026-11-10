import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { EmployeeEffectiveContentSchema } from './employee-content.ts';
import {
  EmployeeAppearanceSchema,
  EmployeeIdentitySchema,
  EmployeeInstanceProfileSchema,
  EmployeeVersionSourceSchema,
} from './employees.ts';

/** One authorized, current instance read. No model credentials, skills or draft
 * fields belong to the profile projection used by employee detail surfaces. */
export const EmployeeDetailsProfileSchema = z
  .object({
    instanceId: UuidSchema,
    kind: z.enum(['general', 'custom']),
    revision: z.number().int().positive(),
    source: EmployeeVersionSourceSchema,
    name: z.string(),
    description: z.string(),
    appearance: EmployeeAppearanceSchema.optional(),
    identity: EmployeeIdentitySchema,
    expressionStyle: EmployeeInstanceProfileSchema.shape.expressionStyle,
    personalFields: z.array(EmployeeInstanceProfileSchema.keyof()),
    canMaintainPersonal: z.boolean(),
    // Current owner-view capabilities; never frozen as a Run's authority.
    editableFields: z.array(EmployeeInstanceProfileSchema.keyof()).optional(),
    isDefaultRice: z.boolean().optional(),
    canArchive: z.boolean().optional(),
    defaults: EmployeeInstanceProfileSchema.optional(),
    // Raw owner presence, not a permissions grant or an effective-value diff.
    // Optional without defaults so older detail DTOs keep their exact shape.
    overrides: EmployeeInstanceProfileSchema.optional(),
    // Platform only after verification. tenant_version retains its existing
    // meaning (platform provenance unknown); absent means unconfirmed here,
    // including a declared platform source whose evidence did not verify.
    defaultSource: EmployeeVersionSourceSchema.optional(),
  })
  .strict();
export const EmployeeDetailsSchema = z
  .object({
    profile: EmployeeDetailsProfileSchema,
    content: EmployeeEffectiveContentSchema,
  })
  .strict()
  .refine((value) => value.profile.instanceId === value.content.instanceId, {
    message: 'Employee detail identity must match its effective content.',
  });
export type EmployeeDetails = z.infer<typeof EmployeeDetailsSchema>;
export type EmployeeDetailsProfile = z.infer<
  typeof EmployeeDetailsProfileSchema
>;
