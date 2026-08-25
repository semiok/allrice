import { describe, expect, it } from 'vitest';

import {
  DSH_DISTRIBUTION_CURRENT_GENERATION,
  DSH_DISTRIBUTION_CURRENT_VERSION,
  isCompatibleDshRuntimeVersion,
} from './dsh-distribution.js';

describe('AllRice DSH distribution', () => {
  it('pins a named runtime generation', () => {
    expect(DSH_DISTRIBUTION_CURRENT_GENERATION).toContain(
      DSH_DISTRIBUTION_CURRENT_VERSION,
    );
  });

  it('accepts the pinned server and test builds derived from it', () => {
    expect(isCompatibleDshRuntimeVersion('0.1.1-rc.2')).toBe(true);
    expect(isCompatibleDshRuntimeVersion('0.1.1-rc.2-fake')).toBe(true);
    expect(isCompatibleDshRuntimeVersion('0.1.2')).toBe(false);
  });
});
