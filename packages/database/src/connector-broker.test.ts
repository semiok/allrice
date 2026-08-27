import { describe, expect, it } from 'vitest';

import { connectorInputDigest } from './connector-broker.js';

describe('connector broker digests', () => {
  it('is stable across object key order and never contains credential data', () => {
    const first = connectorInputDigest({ query: 'rice', limit: 3 });
    const second = connectorInputDigest({ limit: 3, query: 'rice' });
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first).not.toContain('rice');
  });
});
