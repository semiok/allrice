import { expect, it } from 'vitest';
import {
  employeeRuntimeFeatureFlags,
  runtimeFeatureEnabled,
} from './runtime-feature-flags.ts';
it('makes implemented capabilities available in development while respecting an explicit pause', () => {
  for (const flag of employeeRuntimeFeatureFlags) {
    expect(runtimeFeatureEnabled(flag, { ALLRICE_ENV: 'development' })).toBe(
      true,
    );
    expect(
      runtimeFeatureEnabled(flag, { ALLRICE_ENV: 'development', [flag]: '0' }),
    ).toBe(false);
    expect(runtimeFeatureEnabled(flag, { ALLRICE_ENV: 'production' })).toBe(
      false,
    );
    expect(
      runtimeFeatureEnabled(flag, { ALLRICE_ENV: 'production', [flag]: '1' }),
    ).toBe(true);
  }
});
