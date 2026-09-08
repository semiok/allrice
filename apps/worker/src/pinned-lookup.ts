import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';

/** Adapt an already validated address to both Node DNS callback contracts.
 * This does not resolve or authorize addresses; callers must do that first. */
export function createPinnedLookup(resolved: LookupAddress): LookupFunction {
  const { address, family } = resolved;
  return (_hostname, options, callback) => {
    // Node's automatic family selection requests all:true, even for one IP.
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}
