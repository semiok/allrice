import { PLATFORM_EMPLOYEE_DSH_DISTRIBUTION } from '@allrice/contracts';

// CURRENT means this build's installed generation; distribution.json separately
// records production promotion status (the installed channel may be candidate).
export const DSH_DISTRIBUTION_CURRENT_VERSION = '0.1.5-rc.3';
export const DSH_DISTRIBUTION_CURRENT_GENERATION =
  PLATFORM_EMPLOYEE_DSH_DISTRIBUTION;

export function isCompatibleDshRuntimeVersion(version: string) {
  return (
    version === DSH_DISTRIBUTION_CURRENT_VERSION ||
    version.startsWith(`${DSH_DISTRIBUTION_CURRENT_VERSION}-`)
  );
}
