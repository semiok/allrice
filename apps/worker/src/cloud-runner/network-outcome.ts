import type { CloudExecutionPayload } from '@allrice/contracts';
import type { CloudRunResult } from './backend.js';

/** Stopping a process cannot undo or settle an external API request. Missing
 * observations after recovery are uncertainty, never invented zero traffic. */
export function unconfirmedCloudNetworkOutcome(
  payload: CloudExecutionPayload,
  outcome: Pick<CloudRunResult, 'reason' | 'network'>,
) {
  return (
    !('kind' in payload) &&
    payload.network !== 'none' &&
    outcome.reason !== 'completed' &&
    (!outcome.network || outcome.network.sentBytes > 0)
  );
}
