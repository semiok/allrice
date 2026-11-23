import { expect, it } from 'vitest';
import { readPlatformPersonVmConfiguration } from './platform-person-vm-configuration.ts';

it('keeps the application platform defaults at 2GiB and twenty minutes', () => {
  expect(readPlatformPersonVmConfiguration()).toEqual({
    memoryMiB: 2 * 1024,
    idleMs: 20 * 60 * 1000,
    commandHighBytes: 1280 * 1024 ** 2,
    commandMaxBytes: 1280 * 1024 ** 2,
    commandSwapMaxBytes: 512 * 1024 ** 2,
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
  expect(Reflect.set(configuration, 'commandHighBytes', 1)).toBe(false);
  expect(Reflect.set(configuration, 'commandMaxBytes', 1)).toBe(false);
  expect(Reflect.set(configuration, 'commandSwapMaxBytes', 1)).toBe(false);
  expect(readPlatformPersonVmConfiguration()).toEqual({
    memoryMiB: 2 * 1024,
    idleMs: 20 * 60 * 1000,
    commandHighBytes: 1280 * 1024 ** 2,
    commandMaxBytes: 1280 * 1024 ** 2,
    commandSwapMaxBytes: 512 * 1024 ** 2,
  });
});
