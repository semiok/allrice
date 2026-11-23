import type { DEntryRolloutPolicy, RequestContext } from '@allrice/contracts';
import { readDEntryReleasePolicy as readPublishedPolicy } from '@allrice/database';

export class DEntryDependencyUnavailable extends Error {
  constructor(
    readonly dependency: 'release-policy' | 'native-route',
    options?: ErrorOptions,
  ) {
    super('D entry dependency is not bound', options);
  }
}

/** Caller already resolved the real login and current employee. The platform
 * settings owner supplies exact selections; an absent release stays disabled. */
export async function readDEntryReleasePolicy(
  _context: RequestContext,
  signal: AbortSignal,
): Promise<DEntryRolloutPolicy> {
  signal.throwIfAborted();
  const policy = await readPublishedPolicy().catch((error) => {
    throw new DEntryDependencyUnavailable('release-policy', { cause: error });
  });
  signal.throwIfAborted();
  return policy;
}
