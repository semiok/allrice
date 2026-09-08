/** Expected validation/quota conflicts roll back but do not poison SQLite.
 * Actual SQLite/I/O failures still stop all new work through BridgeJournal. */
export class BridgeJournalError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
