import { describe, it, expect } from 'vitest';
import { parsePersonalSkill } from './personal-skill-import.js';
import { skillBytesChecksum } from '@allrice/database';

describe('personal import through the native filesystem Skill provider', () => {
  it('retains raw bytes separately from native body, metadata and invocation', async () => {
    const raw =
      '---\nname: private-checklist\ndescription: Three checks\nwhenToUse: Checking deliverables\nmetadata:\n  purpose: qa\nlicense: MIT\ndisable-model-invocation: true\nuser-invocable: false\n---\nFirst; second; third.\n';
    const result = await parsePersonalSkill(Buffer.from(raw));
    expect(result.originalText).toBe(raw);
    expect(result.definition).toMatchObject({
      name: 'private-checklist',
      content: 'First; second; third.',
      whenToUse: 'Checking deliverables',
      metadata: { purpose: 'qa' },
      invocation: { modelInvocable: false, userInvocable: false },
    });
    expect(result.definition.checksum).toBe(
      skillBytesChecksum(result.definition.content),
    );
    expect(result.definition.checksum).not.toBe(skillBytesChecksum(raw));
  });
  it.each([
    'No frontmatter',
    '---\nname: ../../escape\ndescription: test\n---\nbody',
    '---\nname: test\ndescription: test\nuser-invocable: maybe\n---\nbody',
    '---\nname: test\ndescription: test\n---\n',
    'bad\0bytes',
  ])('rejects invalid independent files: %s', async (raw) => {
    await expect(parsePersonalSkill(Buffer.from(raw))).rejects.toThrow();
  });
  it('rejects invalid UTF-8 and overlarge source before parsing', async () => {
    await expect(
      parsePersonalSkill(Uint8Array.from([0xff, 0xfe])),
    ).rejects.toThrow();
    await expect(parsePersonalSkill(new Uint8Array(262145))).rejects.toThrow();
  });
});
