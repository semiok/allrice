import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { BridgeInstanceLock } from './instance-lock.js';
import { BridgeJournal } from './journal.js';
import { fixtureId, journalDispatch } from './journal-fixtures.js';
import { assertUpdateJournalQuiescent } from './update-quiescence.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'p14-quiescence-')));
  roots.push(root);
  return {
    root,
    input: {
      directory: join(root, 'journal'),
      server: 'https://tenant.example',
      deviceId: fixtureId(11),
    },
  };
}
it('does not create a journal for a new installation', async () => {
  const f = await fixture();
  await assertUpdateJournalQuiescent(f.input);
  await expect(
    readFile(join(f.input.directory, 'journal.sqlite')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects an incomplete existing journal directory instead of creating a blank replacement', async () => {
  const f = await fixture();
  await mkdir(f.input.directory, { mode: 0o700 });
  await expect(assertUpdateJournalQuiescent(f.input)).rejects.toThrow(
    'UPDATE_DRAIN_UNCONFIRMED',
  );
  await expect(
    readFile(join(f.input.directory, 'journal.sqlite')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
it('retains known completed outbox receipts unchanged without sending or replaying them', async () => {
  const f = await fixture();
  let journal = await BridgeJournal.open(f.input);
  await journal.receive(journalDispatch(f.root));
  await journal.begin(fixtureId(6));
  await journal.outcome(fixtureId(6), {
    status: 'succeeded',
    effects: 'applied',
    summary: 'known completed synthetic effect',
  });
  const pending = await journal.pending();
  await journal.close();
  const owner = await BridgeInstanceLock.acquire(join(f.root, 'config'));
  try {
    await assertUpdateJournalQuiescent(f.input);
  } finally {
    owner.close();
  }
  journal = await BridgeJournal.open(f.input);
  try {
    expect(await journal.pending()).toEqual(pending);
  } finally {
    await journal.close();
  }
});
it('rejects durable unknown left by a separate CLI after the drained ticket and owner exit', async () => {
  const f = await fixture();
  const ownerPath = join(f.root, 'config');
  const prior = await BridgeInstanceLock.acquire(ownerPath);
  const ticket = join(f.root, 'drained-synthetic.json');
  await writeFile(ticket, 'historical-drain-evidence', { mode: 0o600 });
  prior.close();
  const journalModule = new URL('./journal.ts', import.meta.url).href;
  const lockModule = new URL('./instance-lock.ts', import.meta.url).href;
  await promisify(execFile)(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    const { BridgeJournal } = await import(${JSON.stringify(journalModule)});
    const { BridgeInstanceLock } = await import(${JSON.stringify(lockModule)});
    const owner = await BridgeInstanceLock.acquire(${JSON.stringify(ownerPath)});
    const journal = await BridgeJournal.open(${JSON.stringify(f.input)});
    await journal.receive(${JSON.stringify(journalDispatch(f.root))});
    await journal.begin(${JSON.stringify(fixtureId(6))});
    await journal.close(); owner.close();
  `,
    ],
    {
      timeout: 20000,
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: {
        ...process.env,
        // A clean CI checkout runs tests before building workspace packages.
        // The separate CLI must resolve the same source graph as Vitest.
        TSX_TSCONFIG_PATH: fileURLToPath(
          new URL('../../../tsconfig.base.json', import.meta.url),
        ),
      },
    },
  );
  const owner = await BridgeInstanceLock.acquire(ownerPath);
  try {
    await expect(assertUpdateJournalQuiescent(f.input)).rejects.toThrow(
      'UPDATE_DRAIN_UNCONFIRMED',
    );
  } finally {
    owner.close();
  }
  expect(await readFile(ticket, 'utf8')).toBe('historical-drain-evidence');
  const recovered = await BridgeJournal.open(f.input);
  try {
    expect((await recovered.diagnosticCounts()).unknownOperations).toBe(1);
    expect(
      (await recovered.pending()).some(
        (row) => row.signal.type === 'operation.uncertain',
      ),
    ).toBe(true);
  } finally {
    await recovered.close();
  }
}, 30000);
it('does not treat a still-owned journal as quiescent', async () => {
  const f = await fixture();
  const journal = await BridgeJournal.open(f.input);
  try {
    await expect(assertUpdateJournalQuiescent(f.input)).rejects.toThrow(
      'UPDATE_DRAIN_UNCONFIRMED',
    );
  } finally {
    await journal.close();
  }
});
it('does not treat an unsupported journal generation as a missing journal', async () => {
  const f = await fixture();
  const journal = await BridgeJournal.open(f.input);
  await journal.close();
  const database = new DatabaseSync(join(f.input.directory, 'journal.sqlite'));
  database.exec('PRAGMA user_version=99;');
  database.close();
  await expect(assertUpdateJournalQuiescent(f.input)).rejects.toThrow(
    'UPDATE_DRAIN_UNCONFIRMED',
  );
});
