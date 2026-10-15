import { PersonalSkillInstallInputSchema } from '@allrice/contracts';

export const personalSkillNativeTools = [
  {
    canonicalName: 'workspace.personal_skill.install',
    wireName: 'workspace_personal_skill_install',
    description:
      'Install exactly one SKILL.md attached to the current direct user message, only when the user explicitly asks to install it for this AI employee. Reading, reviewing, translating or trying a file for this task is not installation authority. The server derives the current owner/instance; never pass arbitrary skill text or other user IDs. This is a private binding for subsequent tasks, not platform approval or a grant of tools. Do not claim success until the receipt succeeds. On ambiguous intent ask the user. The user can disable/uninstall in Settings → 我的技能.',
    timeoutMs: 15000,
    isConcurrencySafe: false,
    parameters: {
      objectId: {
        type: 'string',
        required: true,
        description:
          'UUID of the single SKILL.md attachment in the current user message.',
      },
    },
    validateArguments(args) {
      return PersonalSkillInstallInputSchema.parse(args);
    },
  },
];
