import { DSH_INSTALLED_DISTRIBUTION } from '@allrice/contracts';

// CURRENT means this build's installed composition, not a live acceptance or
// production-promotion receipt. The generated facts have one reviewed source.
export const DSH_DISTRIBUTION_CURRENT_VERSION =
  DSH_INSTALLED_DISTRIBUTION.version;
export const DSH_DISTRIBUTION_CURRENT_GENERATION =
  DSH_INSTALLED_DISTRIBUTION.generation;

export function isCompatibleDshRuntimeVersion(version: string) {
  return (
    version === DSH_DISTRIBUTION_CURRENT_VERSION ||
    version.startsWith(`${DSH_DISTRIBUTION_CURRENT_VERSION}-`)
  );
}
