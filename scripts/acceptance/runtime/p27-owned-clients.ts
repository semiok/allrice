import type { DshProtocolClient } from '../../../apps/worker/src/harness/dsh-protocol-client.ts';

/** Script-local lifecycle observer, installed before this script creates hosts.
 * Pool inventory excludes a spawned client while initialize is pending. Only
 * the real protocol close promise (child close event) proves process exit.
 */
export function observeP27Clients(Client: typeof DshProtocolClient) {
  const owned = new Set<DshProtocolClient>();
  const closed = new Set<DshProtocolClient>();
  const initialize = Client.prototype.initialize;
  const close = Client.prototype.close;
  let stopping = false;
  async function closeOwned(client: DshProtocolClient) {
    await close.call(client);
    closed.add(client);
  }
  Client.prototype.initialize = async function (...args) {
    owned.add(this);
    if (stopping) {
      await closeOwned(this);
      throw Error('p27_stopping');
    }
    return initialize.apply(this, args);
  };
  Client.prototype.close = async function () {
    await closeOwned(this);
  };
  return {
    async closeAll() {
      stopping = true;
      await Promise.allSettled([...owned].map(closeOwned));
    },
    snapshot: () => ({
      owned: owned.size,
      closed: closed.size,
      allStopped: stopping && [...owned].every((client) => closed.has(client)),
    }),
    restore() {
      Client.prototype.initialize = initialize;
      Client.prototype.close = close;
    },
  };
}
