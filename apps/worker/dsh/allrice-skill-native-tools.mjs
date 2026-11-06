import { SkillResourceReadSchema } from '@allrice/contracts/native-runtime';

export const SkillNativeArgumentsSchema = SkillResourceReadSchema;

export const skillNativeTools = [
  {
    canonicalName: 'workspace.skill.read',
    wireName: 'workspace_skill_read',
    description:
      "Read one resource from this Run's exact frozen platform/private installed Skill package. Supply exactly one of skill (frozen name) or contentRef (personal Workflow's native load), plus a relative scripts/, references/ or assets/ path. Returns bytes/text and version provenance; personal packages are not platform-reviewed. Rechecks current private binding permission. Grants no execution permission; never reads host paths or runs scripts.",
    timeoutMs: 30000,
    isConcurrencySafe: true,
    validateArguments(args) {
      SkillNativeArgumentsSchema.parse(args);
      return args;
    },
    parameters: {
      skill: {
        type: 'string',
        description: 'Frozen Skill name, for example business-reconciliation.',
      },
      contentRef: {
        type: 'string',
        description:
          'Exact personal Workflow contentRef from the native skill load, instead of skill. It is a locator, never permission.',
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
