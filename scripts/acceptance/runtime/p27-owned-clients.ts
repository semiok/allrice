import type { DshProtocolClient } from '../../../apps/worker/src/harness/dsh-protocol-client.ts';

/** Script-local lifecycle observer, installed before this script creates hosts.
 * Pool inventory excludes a spawned client while initialize is pending.
 * Physical child exit and confirmed semantic close are recorded separately.
 */
export function observeP27Clients(Client: typeof DshProtocolClient) {
  const owned = new Set<DshProtocolClient>();
  const closed = new Set<DshProtocolClient>();
  const failed = new Map<DshProtocolClient, unknown>();
  const initialize = Client.prototype.initialize;
  const close = Client.prototype.close;
  let stopping = false;
  async function closeOwned(client: DshProtocolClient) {
    try {
      await close.call(client);
      closed.add(client);
    } catch (error) {
      failed.set(client, error);
      throw error;
    }
  }
  Client.prototype.initialize = async function (...args) {
    owned.add(this);
    if (stopping) {
      try {
        await closeOwned(this);
      } catch (error) {
        throw Error('p27_stopping', { cause: error });
      }
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
      const results = await Promise.allSettled([...owned].map(closeOwned));
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(
          failures,
          'P27 owned close remains unconfirmed',
        );
    },
    snapshot: () => {
      const physicallyExited = [...owned].filter((client) => {
        const process = client.processState();
        return process.state === 'exited' && process.stdioClosed;
      }).length;
      return {
        owned: owned.size,
        closed: closed.size,
        physicallyExited,
        closeUnconfirmed: failed.size,
        allStopped:
          stopping && [...owned].every((client) => closed.has(client)),
        allPhysicallyExited: stopping && physicallyExited === owned.size,
      };
    },
    restore() {
      Client.prototype.initialize = initialize;
      Client.prototype.close = close;
    },
  };
}
