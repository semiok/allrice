import { describe, expect, it } from 'vitest';

import {
  approvedSkillCandidates,
  validateApprovedSkillCandidate,
} from './approved-skills';

describe('approved SkillHub imports', () => {
  it('pins every audited candidate and carries license notices', () => {
    expect(Object.keys(approvedSkillCandidates)).toHaveLength(24);
    for (const candidate of Object.values(approvedSkillCandidates)) {
      expect(candidate.source.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(candidate.source.license).toBe('MIT');
      expect(candidate.bundle.files.map((file) => file.path)).toEqual(
        expect.arrayContaining(['SKILL.md', 'NOTICE.md', 'LICENSE.txt']),
      );
    }
  });

  it('includes the approved workplace and presentation workflows', () => {
    expect(approvedSkillCandidates['allrice-meeting-notes']?.name).toBe(
      '会议纪要助手',
    );
    expect(
      approvedSkillCandidates['allrice-presentation-generator'],
    ).toMatchObject({
      name: '演示文稿生成助手',
      capabilities: ['model:invoke', 'storage:read', 'storage:write'],
    });
    expect(approvedSkillCandidates['allrice-schedule-reminders']).toMatchObject(
      {
        capabilities: ['model:invoke', 'storage:read', 'automation:write'],
      },
    );
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
