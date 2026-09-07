import { describe, expect, it } from 'vitest';

import { canonicalRuntimeBridgeJson } from './bridge-journal.ts';

describe('Bridge journal canonical JSON', () => {
  it('sorts codepoint keys and preserves array order', () => {
    expect(
      canonicalRuntimeBridgeJson({ '2': 'b', 中: 4, '10': 'a', é: 3 }),
    ).toBe('{"10":"a","2":"b","é":3,"中":4}');
    expect(canonicalRuntimeBridgeJson([2, 1])).toBe('[2,1]');
  });

  it('rejects non-JSON values instead of silently altering fingerprints', () => {
    for (const value of [
      undefined,
      NaN,
      Infinity,
      new Date(),
      new Map(),
      { unsupported: undefined },
      new Array(1),
      () => true,
      1n,
    ]) {
      expect(() => canonicalRuntimeBridgeJson(value)).toThrow(
        'Non-JSON Bridge value',
      );
    }
  });
});
