import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeJournal } from './journal.js';
import { fixtureId } from './journal-fixtures.js';
import type {
  FolderTriggerFile,
  FolderTriggerRule,
} from './folder-trigger-watcher.js';

const roots: string[] = [],
  journals: BridgeJournal[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) await journal.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const hash = (value: string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
function file(path: string, value: string): FolderTriggerFile {
  return {
    path,
    expected: {
      checksum: hash(value),
      version: hash(path + ':' + value),
      sizeBytes: Buffer.byteLength(value),
      mediaType: 'application/pdf',
    },
  };
}
async function fixture(limits?: { entries: number; bytes: number }) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'rice-folder-journal-')),
  );
  roots.push(directory);
  const input = {
    directory: join(directory, 'journal'),
    server: 'https://synthetic.example',
    deviceId: fixtureId(11),
    ...(limits ? { limits } : {}),
  };
  const open = async () => {
    const journal = await BridgeJournal.open(input);
    journals.push(journal);
    return journal;
  };
  const journal = await open();
  const rule: FolderTriggerRule = {
    automationId: fixtureId(20),
    revision: 1,
    deviceId: input.deviceId,
    folderGrantId: fixtureId(21),
    folderGrantVersion: 1,
    relativePath: '.',
    extensions: ['pdf'],
    ignorePaths: ['output'],
    admissionExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
  const root = {
    path: '/synthetic-root',
    dev: 3,
    ino: 40,
    directoryDev: 3,
    directoryIno: 40,
  };
  const observedAt = new Date().toISOString();
  const baseline = async (files: FolderTriggerFile[] = []) =>
    journal.commitFolderTriggerSnapshot(
      rule,
      root,
      { files, complete: true, truncated: false },
      observedAt,
    );
  return { journal, rule, root, observedAt, open, baseline };
}

describe('folder trigger SQLite snapshot and outbox', () => {
  it('ACK clears the payload while digest tombstones prevent the same version firing after disappearance', async () => {
    const f = await fixture();
    await f.baseline();
    const original = file('a.pdf', 'same physical version');
    const event = await f.journal.recordFolderTrigger(
      f.rule,
      f.root,
      original.path,
      original.expected,
      f.observedAt,
    );
    await f.journal.acknowledgeFolderTrigger(f.rule, event!.eventId);
    const database = (
      f.journal as unknown as {
        database: {
          prepare(sql: string): {
            get(...args: string[]): Record<string, unknown>;
          };
        };
      }
    ).database;
    expect(
      database
        .prepare(
          'SELECT body,delivered FROM folder_trigger_events WHERE event_id=?',
        )
        .get(event!.eventId),
    ).toMatchObject({ body: null, delivered: 1 });
    await f.journal.forgetFolderTriggerPath(f.rule, f.root, original.path);
    const replacement = file('a.pdf', 'another physical version');
    const replacementEvent = await f.journal.recordFolderTrigger(
      f.rule,
      f.root,
      replacement.path,
      replacement.expected,
      f.observedAt,
    );
    await f.journal.acknowledgeFolderTrigger(f.rule, replacementEvent!.eventId);
    await f.journal.close();
    const reopened = await f.open();
    expect(
      await reopened.recordFolderTrigger(
        f.rule,
        f.root,
        original.path,
        original.expected,
        new Date(Date.now() + 1_000).toISOString(),
      ),
    ).toBeNull();
    expect(await reopened.pendingFolderTriggers(f.rule)).toEqual([]);
    expect((await reopened.folderTriggerSnapshot(f.rule))?.files).toEqual([
      original,
    ]);
  });
  it('does not trigger existing baseline files; queues exact versions once across reopen and ACK', async () => {
    const f = await fixture();
    expect(await f.baseline([file('已有.pdf', 'old')])).toEqual([]);
    expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([]);
    const changed = file('已有.pdf', 'new');
    const event = await f.journal.recordFolderTrigger(
      f.rule,
      f.root,
      changed.path,
      changed.expected,
      f.observedAt,
    );
    expect(event).toMatchObject({
      ruleId: f.rule.automationId,
      revision: 1,
      grantId: f.rule.folderGrantId,
      grantVersion: 1,
      path: changed.path,
      expected: changed.expected,
    });
    await f.journal.close();
    const reopened = await f.open();
    expect(await reopened.pendingFolderTriggers(f.rule)).toEqual([event]);
    expect(
      await reopened.recordFolderTrigger(
        f.rule,
        f.root,
        changed.path,
        changed.expected,
        new Date(Date.now() + 100).toISOString(),
      ),
    ).toBeNull();
    await reopened.acknowledgeFolderTrigger(f.rule, event!.eventId);
    await reopened.acknowledgeFolderTrigger(f.rule, event!.eventId);
    await reopened.close();
    const third = await f.open();
    expect(await third.pendingFolderTriggers(f.rule)).toEqual([]);
    expect((await third.folderTriggerSnapshot(f.rule))?.files).toEqual([
      changed,
    ]);
    expect(
      await third.recordFolderTrigger(
        f.rule,
        f.root,
        changed.path,
        changed.expected,
        f.observedAt,
      ),
    ).toBeNull();
  });
  it('keeps old pending facts in their scope; cannot acknowledge them as a new rule/grant/device', async () => {
    const f = await fixture();
    await f.baseline();
    const fresh = file('new.pdf', 'new');
    const event = await f.journal.recordFolderTrigger(
      f.rule,
      f.root,
      fresh.path,
      fresh.expected,
      f.observedAt,
    );
    for (const rule of [
      { ...f.rule, revision: 2 },
      { ...f.rule, folderGrantVersion: 2 },
    ]) {
      expect(await f.journal.pendingFolderTriggers(rule)).toEqual([]);
      expect(await f.journal.folderTriggerSnapshot(rule)).toBeNull();
      await expect(
        f.journal.acknowledgeFolderTrigger(rule, event!.eventId),
      ).rejects.toThrow('JOURNAL_FOLDER_SCOPE_MISMATCH');
    }
    await expect(
      f.journal.pendingFolderTriggers({ ...f.rule, deviceId: fixtureId(12) }),
    ).rejects.toThrow('JOURNAL_IDENTITY_MISMATCH');
    expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([event]);
  });
  it('accepts only lease renewal for the same immutable filter/config', async () => {
    const f = await fixture();
    await f.baseline([file('a.pdf', 'one')]);
    const renewed = {
      ...f.rule,
      admissionExpiresAt: new Date(Date.now() + 180_000).toISOString(),
    };
    expect(await f.journal.folderTriggerSnapshot(renewed)).toMatchObject({
      baselineComplete: true,
    });
    for (const changed of [
      { ...f.rule, ignorePaths: ['another'] },
      { ...f.rule, relativePath: 'another' },
      { ...f.rule, extensions: ['pdf', 'xlsx'] },
    ]) {
      await expect(f.journal.folderTriggerSnapshot(changed)).rejects.toThrow(
        'JOURNAL_FOLDER_SCOPE_MISMATCH',
      );
    }
    await expect(
      f.journal.commitFolderTriggerSnapshot(
        f.rule,
        { ...f.root, ino: 41 },
        { files: [], complete: true, truncated: false },
        f.observedAt,
      ),
    ).rejects.toThrow('JOURNAL_FOLDER_ROOT_CHANGED');
    expect((await f.journal.folderTriggerSnapshot(f.rule))?.root).toEqual(
      f.root,
    );
  });
  it('rejects incomplete first baseline; incomplete recovery never deletes unseen files', async () => {
    const f = await fixture(),
      a = file('a.pdf', 'a'),
      b = file('b.pdf', 'b');
    await expect(
      f.journal.commitFolderTriggerSnapshot(
        f.rule,
        f.root,
        { files: [a], complete: false, truncated: true },
        f.observedAt,
      ),
    ).rejects.toThrow('JOURNAL_FOLDER_BASELINE_INCOMPLETE');
    expect(await f.journal.folderTriggerSnapshot(f.rule)).toBeNull();
    await f.baseline([a, b]);
    const next = file('a.pdf', 'next');
    expect(
      await f.journal.commitFolderTriggerSnapshot(
        f.rule,
        f.root,
        { files: [next], complete: false, truncated: true },
        f.observedAt,
      ),
    ).toHaveLength(1);
    expect((await f.journal.folderTriggerSnapshot(f.rule))?.files).toEqual([
      next,
      b,
    ]);
    expect(
      await f.journal.commitFolderTriggerSnapshot(
        f.rule,
        f.root,
        { files: [next], complete: true, truncated: false },
        f.observedAt,
      ),
    ).toEqual([]);
    expect((await f.journal.folderTriggerSnapshot(f.rule))?.files).toEqual([
      next,
    ]);
  });
  it('unlink only removes snapshot membership, retaining pending receipt facts until ACK', async () => {
    const f = await fixture();
    await f.baseline();
    const fresh = file('a.pdf', 'a');
    const event = await f.journal.recordFolderTrigger(
      f.rule,
      f.root,
      fresh.path,
      fresh.expected,
      f.observedAt,
    );
    await f.journal.forgetFolderTriggerPath(f.rule, f.root, fresh.path);
    expect((await f.journal.folderTriggerSnapshot(f.rule))?.files).toEqual([]);
    expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([event]);
    await expect(f.journal.retireFolderTrigger(f.rule)).rejects.toThrow(
      'JOURNAL_FOLDER_PENDING_EVENTS',
    );
    await f.journal.acknowledgeFolderTrigger(f.rule, event!.eventId);
    await f.journal.retireFolderTrigger(f.rule);
    expect(await f.journal.folderTriggerSnapshot(f.rule)).toBeNull();
  });
  it('expired admission cannot create events, while prior immutable facts remain readable/acknowledgeable', async () => {
    const f = await fixture();
    await f.baseline();
    const fresh = file('a.pdf', 'a');
    const event = await f.journal.recordFolderTrigger(
      f.rule,
      f.root,
      fresh.path,
      fresh.expected,
      f.observedAt,
    );
    const expired = {
      ...f.rule,
      admissionExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    const changed = file('a.pdf', 'changed');
    await expect(
      f.journal.recordFolderTrigger(
        expired,
        f.root,
        changed.path,
        changed.expected,
        f.observedAt,
      ),
    ).rejects.toThrow('JOURNAL_FOLDER_ADMISSION_EXPIRED');
    expect(await f.journal.pendingFolderTriggers(expired)).toEqual([event]);
    await f.journal.acknowledgeFolderTrigger(expired, event!.eventId);
    expect(await f.journal.pendingFolderTriggers(expired)).toEqual([]);
  });
  it('capacity rejection atomically preserves previous snapshot and never loses unacknowledged events', async () => {
    const f = await fixture({ entries: 1, bytes: 4_000_000 });
    await f.baseline();
    const first = file('a.pdf', 'first');
    const event = await f.journal.recordFolderTrigger(
      f.rule,
      f.root,
      first.path,
      first.expected,
      f.observedAt,
    );
    const second = file('a.pdf', 'second');
    await expect(
      f.journal.recordFolderTrigger(
        f.rule,
        f.root,
        second.path,
        second.expected,
        f.observedAt,
      ),
    ).rejects.toThrow('JOURNAL_FOLDER_CAPACITY_REACHED');
    expect((await f.journal.folderTriggerSnapshot(f.rule))?.files).toEqual([
      first,
    ]);
    expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([event]);
    await f.journal.acknowledgeFolderTrigger(f.rule, event!.eventId);
    expect(
      await f.journal.recordFolderTrigger(
        f.rule,
        f.root,
        second.path,
        second.expected,
        f.observedAt,
      ),
    ).toMatchObject({ expected: second.expected });
  });
  it('bounds repeated metadata and excludes unsafe/output paths without poisoning the original journal', async () => {
    const f = await fixture();
    const tooLarge = Array.from({ length: 500 }, (_, i) =>
      file(`${i}${'中'.repeat(990)}.pdf`, 'a'),
    );
    await expect(f.baseline(tooLarge)).rejects.toThrow(
      'JOURNAL_FOLDER_CAPACITY_REACHED',
    );
    for (const path of [
      '../outside.pdf',
      'output/result.pdf',
      '.allrice-file-id.part',
      'secret/a.pdf',
    ])
      await expect(f.baseline([file(path, 'a')])).rejects.toThrow();
    await expect(
      f.baseline([file('a.pdf', 'a'), file('a.pdf', 'a')]),
    ).rejects.toThrow('JOURNAL_FOLDER_INPUT_INVALID');
    expect(await f.journal.pending()).toEqual([]);
    expect(await f.baseline()).toEqual([]);
  });
  it('preserves the actual committed event after lost COMMIT acknowledgement, without replay', async () => {
    const f = await fixture();
    await f.baseline();
    const database = (
      f.journal as unknown as { database: { exec(statement: string): void } }
    ).database;
    const execute = database.exec.bind(database);
    let injected = false;
    vi.spyOn(database, 'exec').mockImplementation((statement) => {
      execute(statement);
      if (statement === 'COMMIT' && !injected) {
        injected = true;
        throw Error('injected lost commit ACK');
      }
    });
    const fresh = file('a.pdf', 'a');
    await expect(
      f.journal.recordFolderTrigger(
        f.rule,
        f.root,
        fresh.path,
        fresh.expected,
        f.observedAt,
      ),
    ).rejects.toThrow('injected lost commit ACK');
    await expect(f.journal.pendingFolderTriggers(f.rule)).rejects.toThrow(
      'JOURNAL_UNAVAILABLE',
    );
    vi.restoreAllMocks();
    await f.journal.close();
    const recovered = await f.open(),
      events = await recovered.pendingFolderTriggers(f.rule);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      path: fresh.path,
      expected: fresh.expected,
      observedAt: f.observedAt,
    });
    expect(
      await recovered.recordFolderTrigger(
        f.rule,
        f.root,
        fresh.path,
        fresh.expected,
        f.observedAt,
      ),
    ).toBeNull();
    expect(await recovered.pending()).toEqual([]);
  });
});
