import type { ImportSkillInput } from '@allrice/contracts';

const openRiceCommit = '6149e0160893b033b4fd2d32b932b23735720949';

export const approvedSkillCandidates: Readonly<
  Record<string, Omit<ImportSkillInput, 'workspaceId'>>
> = {
  'openrice-weather': {
    slug: 'openrice-weather',
    name: 'Weather',
    description:
      'Weather lookup instructions adapted from OpenRice for the isolated Codex runtime.',
    publisher: 'semiok/openrice',
    version: '1.0.0',
    capabilities: ['model:invoke', 'network:outbound'],
    source: {
      repository: 'https://github.com/semiok/openrice',
      commit: openRiceCommit,
      path: 'skills/weather/SKILL.md',
      license: 'Apache-2.0',
    },
    bundle: {
      schemaVersion: 1,
      entrypoint: 'SKILL.md',
      files: [
        {
          path: 'SKILL.md',
          content: `---
name: weather
description: Look up current weather or a short forecast for a named place.
license: Apache-2.0
source: semiok/openrice@${openRiceCommit}:skills/weather/SKILL.md
modified: true
---

# Weather

Answer weather questions with concise, current conditions and a short forecast.

## Rules

- Resolve the user's place name before searching.
- Use only a network or web-search tool made available by the AllRice execution policy.
- Do not invent current conditions when live data is unavailable.
- Include temperature, conditions, precipitation risk, wind, and the observation or forecast time.
- Mention the source in one short line.
- Never ask for or expose credentials.
`,
        },
        {
          path: 'NOTICE.md',
          content: `Adapted from semiok/openrice at ${openRiceCommit}, skills/weather/SKILL.md.\nLicensed under Apache-2.0. This AllRice version changes the network instructions to use only policy-approved Codex tools.\n`,
        },
      ],
    },
  },
};
