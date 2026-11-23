import { expect, it } from 'vitest';
import { readPlatformPersonVmConfiguration } from './platform-person-vm-configuration.ts';

it('keeps the application platform defaults at 2GiB and twenty minutes', () => {
  expect(readPlatformPersonVmConfiguration()).toEqual({
    memoryMiB: 2 * 1024,
    idleMs: 20 * 60 * 1000,
  });
});
it('has no request override and returns an immutable shared platform configuration', () => {
  const configuration = readPlatformPersonVmConfiguration();
  expect(
    Reflect.apply(readPlatformPersonVmConfiguration, undefined, [
      {
        memoryMiB: 1,
        idleMs: 1,
        organizationId: 'untrusted',
      },
    ]),
  ).toBe(configuration);
  expect(Reflect.set(configuration, 'memoryMiB', 1)).toBe(false);
  expect(Reflect.set(configuration, 'idleMs', 1)).toBe(false);
  expect(readPlatformPersonVmConfiguration()).toEqual({
    memoryMiB: 2 * 1024,
    idleMs: 20 * 60 * 1000,
  });
});
