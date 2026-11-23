/** Application-versioned platform configuration. Operators change this file
 * and release the application to adjust these defaults for every person.
 * No request, environment, enterprise or employee override is read here. */
export type PlatformPersonVmConfiguration = Readonly<{
  memoryMiB: number;
  idleMs: number;
  commandHighBytes: number;
  commandMaxBytes: number;
  commandSwapMaxBytes: number;
}>;
const configuration: PlatformPersonVmConfiguration = Object.freeze({
  memoryMiB: 2 * 1024,
  idleMs: 20 * 60 * 1000,
  commandHighBytes: 1280 * 1024 ** 2,
  commandMaxBytes: 1280 * 1024 ** 2,
  commandSwapMaxBytes: 512 * 1024 ** 2,
});

export function readPlatformPersonVmConfiguration(): PlatformPersonVmConfiguration {
  return configuration;
}
