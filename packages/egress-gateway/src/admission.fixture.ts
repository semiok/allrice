import { randomUUID } from 'node:crypto';
import type { PersonVmAdmissionBoundary } from '@allrice/person-vm';

/** Explicit unit fixture only. Shared PG semantics are covered by admission.integration. */
export function admissionFixture(): PersonVmAdmissionBoundary {
  return {
    admit: async (_context, binding, { participant }, signal) => ({
      permitId: randomUUID(),
      binding,
      participant,
      disposition: 'queued',
      signal,
    }),
    queued: async (_permit, operation, signal) => operation(signal),
    activate: async (_permit, operation, signal) => operation(signal),
    waitUntilReady: async () => {
      throw Error('unit fixture cannot prove ready');
    },
    finish: async () => {},
  };
}
