import type { DEntryRolloutPolicy, RequestContext } from '@allrice/contracts';

export class DEntryDependencyUnavailable extends Error {
  constructor(readonly dependency: 'release-policy' | 'native-route') {
    super('D entry dependency is not bound');
  }
}

/** Published host configuration port. Its management source, defaults and
 * actual person/employee selections still require the release owner's binding.
 * No browser header, env guess or empty policy may silently enable execution. */
export async function readDEntryReleasePolicy(
  _context: RequestContext,
  signal: AbortSignal,
): Promise<DEntryRolloutPolicy> {
  signal.throwIfAborted();
  throw new DEntryDependencyUnavailable('release-policy');
}
