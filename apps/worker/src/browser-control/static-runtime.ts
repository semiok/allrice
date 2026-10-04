/** Fixed trusted program and Chromium image; models never choose a runtime. */
export { staticBrowserImageV1 } from '@allrice/contracts';
export const staticBrowserLimits = {
  memoryMiB: 768,
  cpuMillis: 1000,
  pids: 256,
  outputBytes: 65_536,
  artifactBytes: 5_000_000,
  timeoutMs: 60_000,
} as const;
