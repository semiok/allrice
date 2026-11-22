import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { SkillBundleSchema, SkillResourcePathSchema } from './skill-bundle.ts';

/** Repository source identity only. A pin never authorizes an employee, tool,
 * installation, private package read, or script execution. */
export const BuiltinSkillSourceSelectorSchema = z
  .object({
    id: UuidSchema,
    version: SkillBundleSchema.shape.version,
    contentChecksum: SkillBundleSchema.shape.contentChecksum,
    // Explicit null means this exact source has no resource bundle.
    bundleChecksum: SkillBundleSchema.shape.checksum.nullable(),
  })
  .strict();

export const BuiltinSkillSourceResourceQuerySchema = z
  .object({
    ...BuiltinSkillSourceSelectorSchema.shape,
    path: SkillResourcePathSchema,
    checksum: SkillBundleSchema.shape.resources.element.shape.checksum,
  })
  .strict();

export type BuiltinSkillSourceSelector = z.infer<
  typeof BuiltinSkillSourceSelectorSchema
>;
export type BuiltinSkillSourceResourceQuery = z.infer<
  typeof BuiltinSkillSourceResourceQuerySchema
>;
