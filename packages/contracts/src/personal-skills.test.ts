import { describe, expect, it } from 'vitest';
import {
  PersonalSkillInstallInputSchema,
  PersonalSkillSourceSchema,
} from './personal-skills.ts';

const url = 'https://github.com/acme/skills/tree/main/weekly';
const source = {
  kind: 'github',
  requestedUrl: url,
  owner: 'acme',
  repository: 'skills',
  resolvedRef: 'main',
  commitSha: 'a'.repeat(40),
  treeSha: 'b'.repeat(40),
  sourcePath: 'weekly',
  fileName: 'github-skills.zip',
  originalChecksum: `sha256:${'c'.repeat(64)}`,
  byteLength: 300,
  candidatePath: 'weekly/SKILL.md',
  license: { status: 'unknown' },
};

describe('public skill source protocol', () => {
  it('preserves old attachment records and accepts an exclusive public source input', () => {
    const attachment = {
      kind: 'attachment',
      objectId: 'ca37bd57-8174-4bd7-a7b5-c347e8112345',
      fileName: 'SKILL.md',
      originalChecksum: source.originalChecksum,
      byteLength: 100,
    };
    expect(PersonalSkillSourceSchema.parse(attachment)).toEqual(attachment);
    expect(PersonalSkillSourceSchema.parse(source)).toEqual(source);
    expect(PersonalSkillInstallInputSchema.parse({ url })).toEqual({ url });
    expect(
      PersonalSkillInstallInputSchema.safeParse({
        url,
        objectId: attachment.objectId,
      }).success,
    ).toBe(false);
    expect(
      PersonalSkillInstallInputSchema.safeParse({
        url,
        importId: attachment.objectId,
        candidatePath: 'weekly/SKILL.md',
      }).success,
    ).toBe(false);
  });

  it.each([
    { owner: 'another' },
    { repository: 'another' },
    { sourcePath: 'monthly' },
    { resolvedRef: 'another' },
    { requestedUrl: url + '?token=secret' },
    { requestedUrl: url + '#' },
    { requestedUrl: url.replace('/weekly', '/%2e%2e/weekly') },
    { requestedUrl: url.replace('github.com', 'github.com.evil.test') },
  ])('rejects source identity or URL mismatch: %j', (change) => {
    expect(
      PersonalSkillSourceSchema.safeParse({ ...source, ...change }).success,
    ).toBe(false);
  });

  it('cannot record a different commit for a URL fixed to a full SHA', () => {
    const fixed = {
      ...source,
      requestedUrl: url.replace('main', source.commitSha),
      resolvedRef: source.commitSha,
    };
    expect(PersonalSkillSourceSchema.parse(fixed)).toEqual(fixed);
    expect(
      PersonalSkillSourceSchema.safeParse({
        ...fixed,
        commitSha: 'd'.repeat(40),
      }).success,
    ).toBe(false);
  });
});
