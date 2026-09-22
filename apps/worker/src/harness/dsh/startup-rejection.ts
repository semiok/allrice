import { HandlerError } from '../../errors.js';

/** In-process proof from the adapter's fresh-host, pre-bind boundary only.
 * Never reconstruct this class from RPC errors, events or stored JSON.
 * A fresh host does not prove an old attempt was unused: the ledger must also
 * require a newly frozen subscription snapshot and preserve prior receipts. */
export class DshStartupRejection extends HandlerError {
  readonly #runId: string;
  readonly #attempt: number;

  constructor(error: unknown, runId: string, attempt: number) {
    super(
      error instanceof HandlerError ? error.code : 'CONVERSATION_FAILED',
      error instanceof Error ? error.message : 'DSH assistant startup failed',
      error instanceof HandlerError ? error.retryable : false,
    );
    Object.defineProperty(this, 'cause', { value: error, configurable: true });
    this.#runId = runId;
    this.#attempt = attempt;
  }

  belongsTo(runId: string, attempt: number) {
    return this.#runId === runId && this.#attempt === attempt;
  }
}
