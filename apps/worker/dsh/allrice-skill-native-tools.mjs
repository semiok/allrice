import { SkillResourceReadSchema } from '@allrice/contracts/native-runtime';

export const SkillNativeArgumentsSchema = SkillResourceReadSchema;

export const skillNativeTools = [
  {
    canonicalName: 'workspace.skill.read',
    wireName: 'workspace_skill_read',
    description:
      "Read one resource from this Run's exact frozen platform Skill bundle or private installed Skill package. Use exactly one of skill (frozen platform/private Skill name) or contentRef (personal Workflow package from its native load), and a relative scripts/, references/ or assets/ path. Returns resource bytes/text and version provenance; a personal package is not platform reviewed. Current private binding permission is checked. This never grants execution permission, reads a host path or runs a script.",
    timeoutMs: 30000,
    isConcurrencySafe: true,
    validateArguments(args) {
      SkillNativeArgumentsSchema.parse(args);
      return args;
    },
    parameters: {
      skill: {
        type: 'string',
        required: false,
        description: 'Frozen Skill name, for example business-reconciliation.',
      },
      contentRef: {
        type: 'string', required: false,
        description: 'Exact personal Workflow contentRef from the native skill load, instead of skill. It is a locator, never permission.',
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
