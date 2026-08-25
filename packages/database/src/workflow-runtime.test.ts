import { describe, expect, it } from 'vitest';

import { workflowDigest } from './workflow-runtime.js';

describe('workflow runtime evidence', () => {
  it('uses canonical digests for idempotent step inputs', () => {
    const first = workflowDigest({ task: 'publish', data: { b: 2, a: 1 } });
    const second = workflowDigest({ data: { a: 1, b: 2 }, task: 'publish' });
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first).not.toContain('publish');
  });
});
