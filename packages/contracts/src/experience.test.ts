import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  CreateExperienceInputSchema,
  ReviewExperienceInputSchema,
} from './experience.ts';
const candidate = {
  clientRequestId: randomUUID(),
  runId: randomUUID(),
  messageId: randomUUID(),
  sourceExcerpt: 'Keep the originals',
  content: 'Keep originals unchanged',
  memoryClass: 'work_note',
  scope: 'private',
  shareAcknowledged: false,
};
it('requires a separate explicit bounded candidate, never a generic chat approval', () => {
  expect(CreateExperienceInputSchema.parse(candidate)).toEqual(candidate);
  for (const invalid of [
    { message: 'yes' },
    { ...candidate, approved: true },
    { ...candidate, content: 'x'.repeat(4001) },
    { ...candidate, scope: 'organization' },
  ])
    expect(CreateExperienceInputSchema.safeParse(invalid).success).toBe(false);
});
it.each(['workspace', 'platform'])(
  'requires owner acknowledgment for %s intent',
  (scope) => {
    expect(
      CreateExperienceInputSchema.safeParse({ ...candidate, scope }).success,
    ).toBe(false);
    expect(
      CreateExperienceInputSchema.safeParse({
        ...candidate,
        scope,
        shareAcknowledged: true,
      }).success,
    ).toBe(true);
  },
);
it('review is bound to exact version and digest without allowing content or scope changes', () => {
  const review = {
    decision: 'approve',
    expectedRevision: 1,
    expectedDigest: `sha256:${'a'.repeat(64)}`,
    reason: 'Checked exact rule',
  };
  expect(ReviewExperienceInputSchema.safeParse(review).success).toBe(true);
  for (const invalid of [
    { decision: 'approve' },
    { ...review, scope: 'workspace' },
    { ...review, content: 'replacement' },
    { ...review, expectedRevision: 0 },
    { ...review, reason: '' },
  ])
    expect(ReviewExperienceInputSchema.safeParse(invalid).success).toBe(false);
});
