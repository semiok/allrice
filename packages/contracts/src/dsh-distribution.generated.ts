// Generated from apps/worker/dsh/distribution.json; run pnpm dsh:generate.

// Missing historical fields never follow a later installed-generation change.

export const DSH_INSTALLED_DISTRIBUTION = {
  generation: 'dsh-0.2.1-rc.2-687f282',
  version: '0.2.1-rc.2',
  commit: '687f282e8625c6b8d11ff58211a90524be2e4317',
  sourceArchiveSha256:
    '157903b22c2881d3678d846755afe957a48df834e747deda805a1195ce25a146',
  profile: 'allrice-restricted.cordis.yml',
  frozenProfileAllowed: true,
} as const;

export const DSH_DECLARED_PROMOTED_DISTRIBUTION = {
  generation: 'dsh-0.1.1-rc.2-b150a55',
  version: '0.1.1-rc.2',
  commit: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e',
  sourceArchiveSha256:
    '8cc8169bc1ba6ef6f3c225ef6779f3b349fb15c437c6fd8f42bca19b31ef0d2b',
  profile: 'allrice-restricted.cordis.yml',
  frozenProfileAllowed: true,
} as const;

export const DSH_UPGRADE_CANDIDATE = {
  generation: 'dsh-0.2.1-rc.2-687f282',
  version: '0.2.1-rc.2',
  commit: '687f282e8625c6b8d11ff58211a90524be2e4317',
  sourceArchiveSha256:
    '157903b22c2881d3678d846755afe957a48df834e747deda805a1195ce25a146',
  profile: 'allrice-restricted.cordis.yml',
  frozenProfileAllowed: true,
} as const;

export const DSH_MISSING_FROZEN_GENERATION = 'dsh-0.1.5-rc.3-a4c74a9' as const;

export const DSH_FROZEN_PROFILE_GENERATIONS = [
  'dsh-0.1.5-rc.3-a4c74a9',
  'dsh-0.1.1-rc.2-b150a55',
  'dsh-0.2.1-rc.2-687f282',
] as const;
