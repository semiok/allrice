import type { CloudExecutionPayload } from '@allrice/contracts';
import type { CloudRunResult } from './backend.js';

/** Stopping a process cannot undo or settle an external API request. Missing
 * observations after recovery are uncertainty, never invented zero traffic. */
export function unconfirmedCloudNetworkOutcome(
  payload: CloudExecutionPayload,
  outcome: Pick<CloudRunResult, 'reason' | 'network'> &
    Partial<Pick<CloudRunResult, 'resolution' | 'exitCode'>>,
) {
  // The canonical fixed resolver only reads public package metadata; tenant
  // scripts cannot opt into this exception. Missing receipts remain unknown.
  if (
    !('kind' in payload) &&
    payload.origin?.toolName === 'workspace.project' &&
    outcome.reason === 'failed' &&
    outcome.resolution &&
    outcome.resolution.exitCode === outcome.exitCode
  )
    return false;
  return (
    !('kind' in payload) &&
    payload.network !== 'none' &&
    outcome.reason !== 'completed' &&
    (!outcome.network || outcome.network.sentBytes > 0)
  );
}
