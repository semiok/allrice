/* global AbortController */
/** @typedef {{ employeeInstanceId: string, threadId: string | null }} EmployeeThreadSelection */
/**
 * A root owner must stop actual HTTP, WS and resource readers in abort(),
 * release every retained native SessionReference, then dispose its Client and
 * Cordis root in destroy(). This port deliberately contains no route or token.
 * @typedef {{
 *   openSession: (nativeSessionId: string, signal: AbortSignal) => void | Promise<void>,
 *   abort: () => void | Promise<void>,
 *   releaseSessionReferences: () => void | Promise<void>,
 *   destroy: () => void | Promise<void>
 * }} EmployeeClientRoot
 */

/**
 * UI navigation ownership, independent of the native Agent/session lifecycle.
 * The admission owner validates identity and resolves the native session. Only
 * its remountKey can authorize reusing a root; employee labels and thread IDs
 * never select a Host or transport.
 * @template {{ remountKey: string }} Mount
 */
export class EmployeeClientNavigation {
  /**
   * @param {{
   *   admit: (selection: EmployeeThreadSelection, signal: AbortSignal) => Promise<{ mount: Mount, nativeSessionId: string }>,
   *   create: (mount: Mount, signal: AbortSignal) => Promise<EmployeeClientRoot>
   * }} port
   */
  constructor(port) {
    this.port = port;
    /** @type {{ key: string, employeeInstanceId: string, lifetime: AbortController, root: EmployeeClientRoot } | null} */
    this.active = null;
    /** @type {AbortController | null} */
    this.pending = null;
    /** @type {Promise<unknown>} */
    this.tail = Promise.resolve();
    this.disposed = false;
    /** @type {unknown} */
    this.teardownFailure = null;
  }

  /**
   * @param {EmployeeThreadSelection} selection
   * @returns {Promise<'opened' | 'superseded'>}
   */
  select(selection) {
    if (this.disposed)
      return Promise.reject(new Error('Client navigation disposed'));
    this.pending?.abort();
    const request = new AbortController();
    this.pending = request;
    const operation = this.tail
      .catch(() => {})
      .then(async () => {
        if (request.signal.aborted) return /** @type {const} */ ('superseded');
        if (this.teardownFailure) throw this.teardownFailure;
        if (
          this.active &&
          this.active.employeeInstanceId !== selection.employeeInstanceId
        )
          await this.closeActive();
        if (request.signal.aborted) return /** @type {const} */ ('superseded');
        let admitted;
        try {
          admitted = await this.port.admit(selection, request.signal);
        } catch (error) {
          if (!request.signal.aborted) await this.closeActive();
          throw error;
        }
        if (request.signal.aborted) return /** @type {const} */ ('superseded');
        if (this.active?.key !== admitted.mount.remountKey) {
          await this.closeActive();
          if (request.signal.aborted)
            return /** @type {const} */ ('superseded');
          const lifetime = new AbortController();
          const cancelCreation = () => lifetime.abort();
          request.signal.addEventListener('abort', cancelCreation, {
            once: true,
          });
          try {
            const root = await this.port.create(
              admitted.mount,
              lifetime.signal,
            );
            this.active = {
              key: admitted.mount.remountKey,
              employeeInstanceId: selection.employeeInstanceId,
              lifetime,
              root,
            };
            if (request.signal.aborted) {
              await this.closeActive();
              return /** @type {const} */ ('superseded');
            }
          } catch (error) {
            lifetime.abort();
            throw error;
          } finally {
            request.signal.removeEventListener('abort', cancelCreation);
          }
        }
        await this.active.root.openSession(
          admitted.nativeSessionId,
          request.signal,
        );
        return request.signal.aborted
          ? /** @type {const} */ ('superseded')
          : /** @type {const} */ ('opened');
      })
      .catch((error) => {
        if (request.signal.aborted) return /** @type {const} */ ('superseded');
        throw error;
      });
    this.tail = operation;
    return operation;
  }

  /** @returns {Promise<void>} */
  async closeActive() {
    const active = this.active;
    if (!active) return;
    this.active = null;
    active.lifetime.abort();
    const failures = [];
    for (const cleanup of [
      () => active.root.abort(),
      () => active.root.releaseSessionReferences(),
      () => active.root.destroy(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      this.teardownFailure = new AggregateError(
        failures,
        'Previous client did not close',
      );
      throw this.teardownFailure;
    }
  }

  /** Abort immediately and resolve only after the last root has been destroyed. */
  dispose() {
    if (!this.disposed) {
      this.disposed = true;
      this.pending?.abort();
      this.active?.lifetime.abort();
      this.tail = this.tail.catch(() => {}).then(() => this.closeActive());
    }
    return this.tail.then(() => {});
  }
}
