export const DSH_DISTRIBUTION_CURRENT_VERSION = '0.1.1-rc.2';
export const DSH_DISTRIBUTION_CURRENT_GENERATION = 'dsh-0.1.1-rc.2-b150a55';

export function isCompatibleDshRuntimeVersion(version: string) {
  return (
    version === DSH_DISTRIBUTION_CURRENT_VERSION ||
    version.startsWith(`${DSH_DISTRIBUTION_CURRENT_VERSION}-`)
  );
}
