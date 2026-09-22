import { describe, it, expect } from 'vitest';
import { DevelopmentCommandSchema } from './development-cooperation.ts';
const ref = {
  artifactId: '8b06e2ab-b856-4d08-8dde-fc2c799994c2',
  digest: `sha256:${'a'.repeat(64)}`,
};
describe('bounded native development commands', () => {
  it('separates editor assignment inspection from candidate verification', () => {
    expect(
      DevelopmentCommandSchema.safeParse({
        action: 'inspect',
        assignmentId: ref.artifactId,
        candidate: ref,
      }).success,
    ).toBe(false);
    for (const args of [
      {},
      { assignmentId: ref.artifactId },
      { candidate: ref },
    ]) {
      expect(
        DevelopmentCommandSchema.safeParse({ action: 'inspect', ...args })
          .success,
      ).toBe(true);
    }
  });
  it.each([
    'runId',
    'worker',
    'execution',
    'approval',
    'passed',
    'inputDigest',
  ])('refuses model-supplied %s authority or evidence', (field) => {
    expect(
      DevelopmentCommandSchema.safeParse({
        action: 'review',
        candidate: ref,
        operationId: ref.artifactId,
        verdict: 'accept',
        summary: 'review',
        [field]: 'invented',
      }).success,
    ).toBe(false);
  });
  it('requires real references and an explicit previous version on publication', () => {
    expect(
      DevelopmentCommandSchema.safeParse({
        action: 'publish',
        assignmentId: ref.artifactId,
        proposal: { files: [{ path: 'a', before: null, after: 'text' }] },
      }).success,
    ).toBe(false);
    expect(
      DevelopmentCommandSchema.safeParse({
        action: 'deliver',
        candidate: { ...ref, digest: 'passed' },
        reviewId: ref.artifactId,
      }).success,
    ).toBe(false);
  });
});
