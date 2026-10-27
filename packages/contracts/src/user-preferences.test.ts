import { describe, expect, it } from 'vitest';
import {
  defaultUserPreferences,
  QuestionWaitSchema,
  SubagentPreferencesSchema,
  UserPreferencesInputSchema,
  UserPreferencesSchema,
} from './user-preferences.js';

describe('personal display preference compatibility', () => {
  it('reads a prior streaming-only snapshot with the native display defaults', () => {
    expect(
      UserPreferencesSchema.parse({ streamingOutput: false, updatedAt: null }),
    ).toEqual({ ...defaultUserPreferences, streamingOutput: false });
  });
});

// MET-210 (user 10-27): DSH's own ranges and defaults, no AllRice cap.
describe('agent preferences follow DSH', () => {
  it('reads an older saved snapshot without pinning DSH defaults', () => {
    expect(
      UserPreferencesSchema.parse({ streamingOutput: true, updatedAt: null }),
    ).toMatchObject({
      questionWait: { mode: 'default' },
      subagents: { maxDepth: null, maxActive: null },
    });
  });
  it.each([
    [{ mode: 'default' }, true],
    [{ mode: 'forever' }, true],
    [{ mode: 'timed', seconds: 1 }, true],
    [{ mode: 'timed', seconds: 2_147_483 }, true],
    [{ mode: 'timed', seconds: 0 }, false],
    [{ mode: 'timed', seconds: 2_147_484 }, false],
    [{ mode: 'timed', seconds: 1.5 }, false],
    [{ mode: 'timed' }, false],
    [{ mode: 'forever', seconds: 10 }, false],
  ])('question wait %j is valid: %s', (value, valid) => {
    expect(QuestionWaitSchema.safeParse(value).success).toBe(valid);
  });
  it.each([
    [{ maxDepth: null, maxActive: null }, true],
    [{ maxDepth: null, maxActive: 8 }, true],
    [{ maxDepth: 0, maxActive: null }, true],
    [{ maxDepth: 0, maxActive: 1 }, true],
    [{ maxDepth: Number.MAX_SAFE_INTEGER, maxActive: 100 }, true],
    [{ maxDepth: -1, maxActive: 1 }, false],
    [{ maxDepth: 1, maxActive: 0 }, false],
    [{ maxDepth: 1 }, false],
    [{ maxDepth: null }, false],
  ])('subagents %j is valid: %s', (value, valid) => {
    expect(SubagentPreferencesSchema.safeParse(value).success).toBe(valid);
  });
  it('saves either group alone', () => {
    expect(
      UserPreferencesInputSchema.safeParse({
        questionWait: { mode: 'forever' },
      }).success,
    ).toBe(true);
    expect(
      UserPreferencesInputSchema.safeParse({
        subagents: { maxDepth: 0, maxActive: 8 },
      }).success,
    ).toBe(true);
  });
});
