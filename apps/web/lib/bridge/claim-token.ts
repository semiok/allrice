import { createHmac } from 'node:crypto';
import {
  canonicalRuntimeBridgeJson,
  type RuntimeActionBinding,
} from '@allrice/contracts';

/** Recover the SAME unstarted lease, never rotate or mint new authority on reconnect.
 * The authenticated device credential is request-local; PostgreSQL stores only
 * the resulting token hash and remains authoritative for scope/state/expiry.
 */
export function recoverableBridgeLeaseToken(
  token: string,
  binding: RuntimeActionBinding,
) {
  const hex = createHmac('sha256', token)
    .update('allrice/bridge/claim-lease/v1\0')
    .update(
      canonicalRuntimeBridgeJson({
        scope: binding.task.scope,
        deviceId: binding.execution.deviceId,
        attempt: binding.attempt,
        inputDigest: binding.inputDigest,
      }),
    )
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
