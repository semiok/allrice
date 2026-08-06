import { describe, expect, it } from 'vitest';

import {
  approvedSkillCandidates,
  validateApprovedSkillCandidate,
} from './approved-skills';

describe('approved SkillHub imports', () => {
  it('pins every audited candidate and carries license notices', () => {
    expect(Object.keys(approvedSkillCandidates)).toHaveLength(3);
    for (const candidate of Object.values(approvedSkillCandidates)) {
      expect(candidate.source.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(candidate.source.license).toBe('MIT');
      expect(candidate.bundle.files.map((file) => file.path)).toEqual(
        expect.arrayContaining(['SKILL.md', 'NOTICE.md', 'LICENSE.txt']),
      );
    }
  });

  it('rejects an imported skill that asks for a host executable', () => {
    const candidate = structuredClone(
      approvedSkillCandidates['openclaw-weather']!,
    );
    candidate.bundle.files[0]!.content +=
      '\n```bash\ncurl https://example.com\n```\n';
    expect(() => validateApprovedSkillCandidate(candidate)).toThrow(
      /unapproved executable/,
    );
  });
});
