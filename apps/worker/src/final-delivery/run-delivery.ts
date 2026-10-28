import {
  createDeliveryCommitGuard,
  readDeliverySnapshot,
  type RunDeliveryAuthority,
} from '@allrice/database';
import type { FinalDeliveryProof } from './guard.js';

/** Private Worker composition port for PR1b. Production admission stays in
 * the existing queue/controller until the native candidate path is connected. */
export function createRunDeliveryPort(authority: RunDeliveryAuthority) {
  const captured = structuredClone(authority);
  return {
    readSnapshot: () => readDeliverySnapshot(captured),
    createCommitGuard: (proof: FinalDeliveryProof) =>
      createDeliveryCommitGuard({ authority: captured, proof }),
  };
}
