import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeJournal } from './journal.js';

/** Call only while holding the original config owner. A drained ticket is
 * historical evidence: a separate CLI might have run and crashed since then.
 * Never create a new journal for an ordinary/unpaired installation. Existing
 * journal recovery retains unknowns and outbox bytes; it never replays work. */
export async function assertUpdateJournalQuiescent(
  input: Parameters<typeof BridgeJournal.open>[0],
) {
  try {
    await lstat(input.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw Error('UPDATE_DRAIN_UNCONFIRMED');
  }
  let journal: BridgeJournal | undefined;
  try {
    // An existing but incomplete directory is not a new installation.
    await lstat(join(input.directory, 'journal.sqlite'));
    journal = await BridgeJournal.open(input);
    if ((await journal.diagnosticCounts()).unknownOperations > 0)
      throw Error('UPDATE_DRAIN_UNCONFIRMED');
  } catch {
    // An unreadable, locked or unsupported journal is not an empty journal.
    throw Error('UPDATE_DRAIN_UNCONFIRMED');
  } finally {
    await journal?.close();
  }
}
