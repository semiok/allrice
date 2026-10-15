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
