import { describe, expect, it } from 'vitest';

import { embedWorkspaceText } from './workspace.js';

describe('employee workspace embedding', () => {
  it('is deterministic, normalized and sensitive to text', () => {
    const first = embedWorkspaceText('AllRice remembers tenant-safe context');
    const retry = embedWorkspaceText('AllRice remembers tenant-safe context');
    const different = embedWorkspaceText('A different memory source');

    expect(first).toHaveLength(1536);
    expect(retry).toEqual(first);
    expect(different).not.toEqual(first);
    expect(Math.hypot(...first)).toBeCloseTo(1, 10);
  });
});
