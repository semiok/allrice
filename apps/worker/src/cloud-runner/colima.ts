import { dirname, isAbsolute } from 'node:path';

/** Operator-fixed Colima binary: Intel Homebrew by default, Apple silicon sets
 * ALLRICE_CLOUD_COLIMA=/opt/homebrew/bin/colima. limactl lives beside it. */
export function colimaExecutable() {
  const configured = process.env.ALLRICE_CLOUD_COLIMA;
  if (configured !== undefined && !isAbsolute(configured))
    throw Error('ALLRICE_CLOUD_COLIMA must be absolute');
  return configured ?? '/usr/local/bin/colima';
}
export function colimaEnvironmentPath() {
  return `${dirname(colimaExecutable())}:/usr/local/bin:/usr/bin:/bin`;
}
