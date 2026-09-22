import { describe, expect, it } from 'vitest';
import { defaultAssistantRunConfiguration } from '@allrice/contracts';
import { assistantModelCallCapacity } from './assistant-call-limits.js';

describe('shared development call guard', () => {
  const config = {
    ...defaultAssistantRunConfiguration(),
    allowAssistants: true,
  };
  it('keeps ordinary assistant limits and reserves finite room for an entire development team', () => {
    expect(assistantModelCallCapacity(config, ['assistant.delegate'])).toBe(16);
    expect(assistantModelCallCapacity(config, ['assistant.development'])).toBe(
      80,
    );
    expect(
      assistantModelCallCapacity({ ...config, maxChildren: 3 }, [
        'assistant.development',
      ]),
    ).toBe(64);
    expect(
      assistantModelCallCapacity({ ...config, maxChildren: 16 }, [
        'assistant.development',
      ]),
    ).toBe(272);
  });
  it('rejects unbounded or unrecognized configuration', () => {
    for (const maxChildren of [0, 17, Infinity, -1]) {
      expect(() =>
        assistantModelCallCapacity({ ...config, maxChildren }, [
          'assistant.development',
        ]),
      ).toThrow();
    }
  });
});
