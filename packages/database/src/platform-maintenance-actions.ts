import { DataAccessError } from './data.ts';

/** Product automation ends at a PR. No policy or historical job grants these
 * actions; human GitHub merges and operator deployments use separate tools. */
export function assertMaintenanceWriteAction(action: string) {
  if (!['publish', 'repair'].includes(action))
    throw new DataAccessError('authorization_denied');
}
