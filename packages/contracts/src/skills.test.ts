import { describe, expect, it } from 'vitest';

import { DshNativeSkillSnapshotSchema } from './skills.js';

describe('DSH native skill snapshot contract', () => {
  it('accepts one immutable employee-scoped skill definition', () => {
    expect(
      DshNativeSkillSnapshotSchema.parse({
        id: 'b3f3c647-c17d-4d24-af8f-2cd11d8f463a',
        name: 'web-research',
        description: 'Research current public information with citations.',
        content: '# Web research\n\nUse the approved search tool.',
        checksum: `sha256:${'a'.repeat(64)}`,
        invocation: { modelInvocable: true, userInvocable: false },
        requiredToolRefs: ['web.search'],
      }),
    ).toMatchObject({
      name: 'web-research',
      requiredToolRefs: ['web.search'],
    });
  });

  it('rejects a mutable display name or an invalid checksum', () => {
    expect(() =>
      DshNativeSkillSnapshotSchema.parse({
        id: 'b3f3c647-c17d-4d24-af8f-2cd11d8f463a',
        name: 'Web Research',
        description: 'Research current public information with citations.',
        content: '# Web research',
        checksum: 'latest',
        invocation: { modelInvocable: true, userInvocable: false },
        requiredToolRefs: [],
      }),
    ).toThrow();
  });
});
