import { PLATFORM_EMPLOYEE_DSH_DISTRIBUTION } from '@allrice/contracts';

export const DSH_DISTRIBUTION_CURRENT_VERSION = '0.1.1-rc.2';
export const DSH_DISTRIBUTION_CURRENT_GENERATION =
  PLATFORM_EMPLOYEE_DSH_DISTRIBUTION;

export function isCompatibleDshRuntimeVersion(version: string) {
  return (
    version === DSH_DISTRIBUTION_CURRENT_VERSION ||
    version.startsWith(`${DSH_DISTRIBUTION_CURRENT_VERSION}-`)
  );
}
