import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { runtimeLedgerInputDigest } from './ledger.ts';

describe('runtime ledger exact JSON digest', () => {
  it('canonicalizes object key order recursively but preserves array order', () => {
    expect(
      runtimeLedgerInputDigest({ z: { b: 2, a: 1 }, a: [true, null] }),
    ).toBe(runtimeLedgerInputDigest({ a: [true, null], z: { a: 1, b: 2 } }));
    expect(runtimeLedgerInputDigest([1, 2])).not.toBe(
      runtimeLedgerInputDigest([2, 1]),
    );
  });
  it('does not silently drop undefined or non-JSON authority input', () => {
    for (const value of [
      undefined,
      { a: undefined },
      [undefined],
      NaN,
      Infinity,
      new Date(),
      1n,
    ])
      expect(() => runtimeLedgerInputDigest(value)).toThrow('invalid_state');
  });
  it('binds explicit defaults and values rather than treating schema-equivalent raw input as identical', () => {
    expect(runtimeLedgerInputDigest({ path: '.' })).not.toBe(
      runtimeLedgerInputDigest({ path: '.', limit: 100 }),
    );
  });
  it('sorts numeric and non-ASCII keys by codepoint without object enumeration reordering', () => {
    const canonical = '{"10":"a","2":"b","é":3,"中":4}';
    expect(runtimeLedgerInputDigest({ '2': 'b', 中: 4, '10': 'a', é: 3 })).toBe(
      `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
    );
  });
});
