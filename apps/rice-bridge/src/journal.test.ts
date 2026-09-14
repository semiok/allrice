import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BridgeJournal } from './journal.js';
import { fixtureId, journalDispatch } from './journal-fixtures.js';
import { journalOwnerFixture } from './journal-owner-fixture.js';

const temporaries: string[] = [];
const journals: BridgeJournal[] = [];
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close();
  for (const path of temporaries.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-p03b-journal-')),
  );
  temporaries.push(root);
  const input = {
    directory: join(root, 'private'),
    server: 'https://tenant.example',
    deviceId: fixtureId(11),
  };
  return { root, input, dispatch: journalDispatch(root) };
}

async function openJournal(input: Parameters<typeof BridgeJournal.open>[0]) {
  const journal = await BridgeJournal.open(input);
  journals.push(journal);
  return journal;
}

async function expectLiveOwnerLocked(
  owner: ReturnType<typeof journalOwnerFixture>,
  input: Parameters<typeof BridgeJournal.open>[0],
) {
  const before = owner.evidence();
  let contender: BridgeJournal | undefined;
  let rejectedWithLock = false;
  try {
    contender = await BridgeJournal.open(input);
  } catch (error) {
    rejectedWithLock = error instanceof Error && /locked/.test(error.message);
  } finally {
    // An unexpected acquisition must not leak a live DB handle into cleanup.
    await contender?.close();
  }
  const after = owner.evidence();
  // Keep the acquisition evidence even if the owner exits between the open
  // attempt and the acknowledgement; that is the historical blind spot.
  const acknowledgement = await owner.command('probe').catch(() => null);
  expect(
    {
      acquired: !!contender,
      rejectedWithLock,
      beforeState: before.state,
      beforeExit: before.exitCode,
      beforeSignal: before.signalCode,
      afterState: after.state,
      afterExit: after.exitCode,
      afterSignal: after.signalCode,
      acknowledgedState: acknowledgement?.state ?? 'unavailable',
    },
    JSON.stringify({
      before,
      after,
      afterProbe: owner.evidence(),
      acknowledgement,
    }),
  ).toEqual({
    acquired: false,
    rejectedWithLock: true,
    beforeState: 'held',
    beforeExit: null,
    beforeSignal: null,
    afterState: 'held',
    afterExit: null,
    afterSignal: null,
    acknowledgedState: 'held',
  });
}

describe('durable Bridge journal (real SQLite/filesystem)', () => {
  it.each(['BEGIN IMMEDIATE', 'COMMIT'])(
    'poisons on SQLite %s IO failure even when rollback succeeds',
    async (statement) => {
      const { input, dispatch, root } = await fixture();
      const journal = await openJournal(input);
      await journal.receive(dispatch);
      await journal.begin(fixtureId(6));
      await writeFile(join(root, 'effect.txt'), 'effect happened');
      const database = (
        journal as unknown as { database: { exec(sql: string): void } }
      ).database;
      const execute = database.exec.bind(database);
      let injected = false;
      const fault = vi.spyOn(database, 'exec').mockImplementation((sql) => {
        if (sql === statement && !injected) {
          injected = true;
          throw new Error('injected SQLITE_IOERR');
        }
        return execute(sql);
      });
      await expect(
        journal.outcome(fixtureId(6), {
          status: 'succeeded',
          effects: 'applied',
          summary: 'done',
        }),
      ).rejects.toThrow('SQLITE_IOERR');
      expect(injected).toBe(true);
      await expect(journal.pending()).rejects.toThrow('JOURNAL_UNAVAILABLE');
      await expect(journal.receive(dispatch)).rejects.toThrow(
        'JOURNAL_UNAVAILABLE',
      );
      fault.mockRestore();
      await journal.close();
      const recovered = await openJournal(input);
      expect((await recovered.pending())[0]?.signal).toEqual({
        type: 'operation.uncertain',
        reason: 'receipt_missing',
      });
      expect(await readFile(join(root, 'effect.txt'), 'utf8')).toBe(
        'effect happened',
      );
    },
  );
  it('does not allow a second handle or a plaintext remote execution channel', async () => {
    const { input } = await fixture();
    const journal = await openJournal(input);
    expect(() => journal.assertWorkspace('/')).toThrow(
      'WORKSPACE_CONTAINS_JOURNAL',
    );
    await expect(BridgeJournal.open(input)).rejects.toThrow(
      'JOURNAL_ALREADY_OPEN',
    );
    await expect(
      BridgeJournal.open({ ...input, server: 'http://tenant.example' }),
    ).rejects.toThrow('JOURNAL_SERVER_INVALID');
    await expect(journal.pending()).resolves.toEqual([]);
  });
  it('uses private files, retains result and dedup tombstone after close/reopen', async () => {
    const { input, dispatch } = await fixture();
    const journal = await openJournal(input);
    expect(await journal.receive(dispatch)).toBe('new');
    await journal.begin(fixtureId(6));
    const receipt = await journal.outcome(fixtureId(6), {
      status: 'succeeded',
      effects: 'applied',
      output: { written: true },
      summary: 'written',
    });
    await journal.close();
    const reopened = await openJournal(input);
    expect(await reopened.receive(dispatch)).toBe('duplicate');
    expect(await reopened.pending()).toEqual([receipt]);
    await reopened.acknowledge(receipt.receiptId);
    await reopened.close();
    const third = await openJournal(input);
    expect(await third.pending()).toEqual([]);
    expect(await third.receive(dispatch)).toBe('duplicate');
    await expect(third.begin(fixtureId(6))).rejects.toMatchObject({
      code: 'JOURNAL_EXECUTION_ALREADY_CLAIMED',
    });
    expect((await lstat(input.directory)).mode & 0o777).toBe(0o700);
    expect(
      (await lstat(join(input.directory, 'journal.sqlite'))).mode & 0o777,
    ).toBe(0o600);
  });

  it('rejects changed payload/fence/lease and identity rather than replaying', async () => {
    const { input, dispatch } = await fixture();
    const journal = await openJournal(input);
    await journal.receive(dispatch);
    const wrong = structuredClone(dispatch);
    wrong.snapshot.binding.attempt.fence++;
    await expect(journal.receive(wrong)).rejects.toMatchObject({
      code: 'JOURNAL_DISPATCH_CONFLICT',
    });
    await expect(
      journal.receive({ ...dispatch, leaseToken: fixtureId(50) }),
    ).rejects.toMatchObject({ code: 'JOURNAL_DISPATCH_CONFLICT' });
    expect(() =>
      journal.assertIdentity('https://other.example', input.deviceId),
    ).toThrow('JOURNAL_IDENTITY_MISMATCH');
    await journal.close();
    await expect(
      BridgeJournal.open({ ...input, deviceId: fixtureId(99) }),
    ).rejects.toMatchObject({ code: 'JOURNAL_IDENTITY_MISMATCH' });
  });

  it.each(['effect_without_result', 'result_committed'])(
    'retains exclusive OS lock across commits and SIGKILL: %s',
    async (stage) => {
      const { input, dispatch, root } = await fixture();
      const owner = journalOwnerFixture({
        journal: input,
        dispatch,
        effect: join(root, 'effect.txt'),
        stage: stage as 'effect_without_result' | 'result_committed',
      });
      try {
        expect((await owner.command('start')).state).toBe('held');
        // The child has COMMITTED its executing marker, not left it uncommitted.
        await expectLiveOwnerLocked(owner, input);
        // GC does not release a journal retained by a live owner's command loop.
        expect((await owner.command('gc')).state).toBe('held');
        await expectLiveOwnerLocked(owner, input);
        await owner.kill();
        const recovered = await openJournal(input);
        expect(await readFile(join(root, 'effect.txt'), 'utf8')).toBe(
          'effect happened',
        );
        if (stage === 'result_committed') {
          expect((await recovered.pending())[0]?.signal).toMatchObject({
            type: 'operation.outcome',
            result: { status: 'succeeded', effects: 'applied' },
          });
        } else {
          expect((await recovered.pending())[0]?.signal).toEqual({
            type: 'operation.uncertain',
            reason: 'receipt_missing',
          });
        }
        expect(await recovered.receive(dispatch)).toBe('duplicate');
        await expect(recovered.begin(fixtureId(6))).rejects.toThrow(
          'JOURNAL_EXECUTION_ALREADY_CLAIMED',
        );
      } finally {
        await owner.kill();
      }
    },
    20_000,
  );

  it('distinguishes stdout noise and a live released process from a journal owner', async () => {
    const { input, dispatch, root } = await fixture();
    const owner = journalOwnerFixture({
      journal: input,
      dispatch,
      effect: join(root, 'effect.txt'),
      stage: 'result_committed',
    });
    try {
      expect((await owner.command('probe')).state).toBe('booting');
      // The child emitted stdout but has not opened the journal. Waiting for
      // arbitrary stdout, as the historical test did, cannot prove ownership.
      await expect.poll(() => owner.evidence().stdoutBytes).toBeGreaterThan(0);
      await (await openJournal(input)).close();
      expect((await owner.command('start')).state).toBe('held');
      await expectLiveOwnerLocked(owner, input);
      expect((await owner.command('release')).state).toBe('released');
      expect(owner.evidence()).toMatchObject({
        exitCode: null,
        signalCode: null,
        connected: true,
      });
      await (await openJournal(input)).close();
      expect((await owner.command('probe')).state).toBe('released');
    } finally {
      await owner.kill();
    }
  }, 20_000);

  it.skipIf(process.platform === 'win32')(
    'detects a live owner losing its OS lock after injected same-inode fd close',
    async () => {
      const { input, dispatch, root } = await fixture();
      const owner = journalOwnerFixture({
        journal: input,
        dispatch,
        effect: join(root, 'effect.txt'),
        stage: 'result_committed',
      });
      try {
        expect((await owner.command('start')).state).toBe('held');
        await expectLiveOwnerLocked(owner, input);
        await owner.command('drop-os-lock-for-control');
        // This deliberately injected SQLite/POSIX misuse must fail the exact
        // same assertion used above, even with a live, responsive owner.
        await expect(expectLiveOwnerLocked(owner, input)).rejects.toMatchObject(
          {
            actual: expect.objectContaining({
              acquired: true,
              rejectedWithLock: false,
              beforeState: 'held',
              beforeExit: null,
              afterState: 'held',
              afterExit: null,
              acknowledgedState: 'held',
            }),
          },
        );
      } finally {
        await owner.kill();
      }
    },
    20_000,
  );

  it('records a provable not-started failure on recovery of received only', async () => {
    const { input, dispatch } = await fixture();
    const journal = await openJournal(input);
    await journal.receive(dispatch);
    await journal.close();
    const recovered = await openJournal(input);
    expect((await recovered.pending())[0]?.signal).toMatchObject({
      type: 'operation.outcome',
      result: { status: 'failed', effects: 'none' },
    });
  });

  it('fails closed at quota, but still durably records the reserved result', async () => {
    const { input, dispatch } = await fixture();
    const journal = await openJournal({
      ...input,
      limits: { entries: 1, bytes: 2_000_000 },
    });
    await journal.receive(dispatch);
    const second = structuredClone(dispatch);
    second.snapshot.binding.attempt.operationId = fixtureId(66);
    await expect(journal.receive(second)).rejects.toThrow(
      'JOURNAL_CAPACITY_REACHED',
    );
    await journal.begin(fixtureId(6));
    await expect(
      journal.outcome(fixtureId(6), {
        status: 'succeeded',
        effects: 'applied',
        summary: 'done',
        output: 'x'.repeat(500_000),
      }),
    ).rejects.toThrow('JOURNAL_RESULT_TOO_LARGE');
    await journal.outcome(fixtureId(6), {
      status: 'succeeded',
      effects: 'applied',
      summary: 'done; output omitted',
    });
    expect(await journal.pending()).toHaveLength(1);
  });

  it('refuses unsafe directory/file permissions, symlinks and hardlinks', async () => {
    const { input, root } = await fixture();
    await symlink(root, input.directory);
    await expect(BridgeJournal.open(input)).rejects.toThrow(
      'JOURNAL_UNSAFE_PATH',
    );
    await rm(input.directory);
    const journal = await openJournal(input);
    await journal.close();
    const file = join(input.directory, 'journal.sqlite');
    await chmod(file, 0o644);
    await expect(BridgeJournal.open(input)).rejects.toThrow(
      'JOURNAL_UNSAFE_PATH',
    );
    await chmod(file, 0o600);
    await link(file, join(root, 'hardlink'));
    await expect(BridgeJournal.open(input)).rejects.toThrow(
      'JOURNAL_UNSAFE_PATH',
    );
  });

  it('detects replacement of the journal file instead of writing into another inode', async () => {
    const { input } = await fixture();
    const journal = await openJournal(input);
    await rm(join(input.directory, 'journal.sqlite'));
    await writeFile(join(input.directory, 'journal.sqlite'), '', {
      mode: 0o600,
    });
    await expect(journal.pending()).rejects.toThrow('JOURNAL_FILE_CHANGED');
  });
});
