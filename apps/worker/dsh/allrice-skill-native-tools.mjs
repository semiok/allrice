import { z } from 'zod';

export const SkillNativeArgumentsSchema = z
  .object({
    skill: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    path: z
      .string()
      .min(1)
      .max(240)
      .regex(/^(?:references|scripts|assets)\/[A-Za-z0-9_.\-/]+$/)
      .refine((value) =>
        value.split('/').every((part) => part && part !== '.' && part !== '..'),
      ),
  })
  .strict();

export const skillNativeTools = [
  {
    canonicalName: 'workspace.skill.read',
    wireName: 'workspace_skill_read',
    description:
      "Read one resource from this Run's immutable frozen Skill bundle. Use the Skill name and bundle-relative scripts/, references/ or assets/ path. Returns reviewed resource text and provenance only; never grants execution permission, reads a host path or runs a script.",
    timeoutMs: 30000,
    isConcurrencySafe: true,
    validateArguments(args) {
      SkillNativeArgumentsSchema.parse(args);
      return args;
    },
    parameters: {
      skill: {
        type: 'string',
        required: true,
        description: 'Frozen Skill name, for example business-reconciliation.',
      },
      path: {
        type: 'string',
        required: true,
        description:
          'Frozen resource path, for example references/format.md or scripts/reconcile.mjs; at most 240 characters.',
      },
    },
  },
];
