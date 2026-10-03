import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
  unlink,
  lstat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as chokidar from 'chokidar';
import { BridgeJournal } from './journal.js';
import { inspectLocalFile } from './local-files.js';
import { fixtureId } from './journal-fixtures.js';
import * as resources from './file-guardian-resources.js';
import {
  FolderTriggerWatcher,
  createFolderTriggerWatcher,
  folderTriggerMaximumFiles,
  type FolderTriggerRule,
  type FolderTriggerScan,
  type FolderTriggerWatcherFactory,
} from './folder-trigger-watcher.js';

vi.mock('chokidar', { spy: true });

const temporaries: string[] = [],
  journals: BridgeJournal[] = [],
  watchers: FolderTriggerWatcher[] = [];
afterEach(async () => {
  for (const watcher of watchers.splice(0)) await watcher.close();
  for (const journal of journals.splice(0)) await journal.close();
  for (const path of temporaries.splice(0))
    await rm(path, { recursive: true, force: true });
  vi.restoreAllMocks();
  // spy:true exposes one shared spy; restoring its property alone does not undo
  // a mockImplementation applied to that same function in the bounded test.
  vi.mocked(chokidar.watch).mockImplementation(
    (await vi.importActual<typeof chokidar>('chokidar')).watch,
  );
  vi.useRealTimers();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'rice-folder-watcher-')),
  );
  temporaries.push(base);
  const root = join(base, 'files');
  await mkdir(root);
  await mkdir(join(root, 'inbox'));
  const journalInput = {
    directory: join(base, 'private'),
    server: 'https://synthetic.example',
    deviceId: fixtureId(11),
  };
  const open = async () => {
    const journal = await BridgeJournal.open(journalInput);
    journals.push(journal);
    return journal;
  };
  const journal = await open();
  const rule: FolderTriggerRule = {
    automationId: fixtureId(20),
    revision: 1,
    deviceId: journalInput.deviceId,
    folderGrantId: fixtureId(21),
    folderGrantVersion: 1,
    relativePath: '.',
    extensions: ['pdf', 'xlsx'],
    ignorePaths: ['output'],
    admissionExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
  let callback!: Parameters<FolderTriggerWatcherFactory>[1];
  const close = vi.fn(async () => undefined);
  const factory: FolderTriggerWatcherFactory = vi.fn(async (_path, options) => {
    callback = options;
    return { ready: Promise.resolve(), close };
  });
  const paths = new Set<string>();
  const write = async (path: string, text: string) => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
    paths.add(path);
  };
  const inspect = vi.fn(async (pathRoot: string, path: string) => {
    try {
      return await inspectLocalFile(pathRoot, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  });
  const scan = vi.fn(async (): Promise<FolderTriggerScan> => {
    const files = [];
    for (const path of paths) {
      const expected = await inspect(root, path);
      if (expected) files.push({ path, expected });
    }
    return { files, complete: true, truncated: false };
  });
  const settle = vi.fn(async (): Promise<void> => {});
  const onError = vi.fn();
  const make = (
    overrides: Partial<
      ConstructorParameters<typeof FolderTriggerWatcher>[0]
    > = {},
  ) => {
    const watcher = new FolderTriggerWatcher({
      rule,
      journal,
      getRoot: async () => root,
      watcherFactory: factory,
      scan,
      inspect,
      settle,
      onError,
      ...overrides,
    });
    watchers.push(watcher);
    return watcher;
  };
  const emit = (path: string, kind: 'add' | 'change' | 'unlink' = 'add') =>
    callback.onChange(kind, path);
  return {
    base,
    root,
    journal,
    open,
    rule,
    paths,
    write,
    scan,
    inspect,
    settle,
    factory,
    close,
    onError,
    make,
    emit,
    options: () => callback,
  };
}

describe('folder stability and scoped watcher lifecycle', () => {
  it('renews the same unexpired admission without any survey/read and rejects scope or root drift', async () => {
    const f = await fixture();
    await f.write('existing.pdf', 'own original');
    const watcher = f.make();
    await watcher.start();
    f.scan.mockClear();
    f.inspect.mockClear();
    await watcher.renewAdmission({
      ...f.rule,
      admissionExpiresAt: new Date(Date.now() + 180_000).toISOString(),
    });
    expect(f.scan).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
    await expect(
      watcher.renewAdmission({ ...f.rule, revision: 2 }),
    ).rejects.toThrow('FOLDER_TRIGGER_SCOPE_CHANGED');
    await rename(f.root, join(f.base, 'original-root'));
    await mkdir(f.root);
    await expect(watcher.renewAdmission(f.rule)).rejects.toThrow(
      'FOLDER_TRIGGER_ROOT_CHANGED',
    );
    await watcher.close();
    expect(f.close).toHaveBeenCalled();
  });
  it('bounds mature watcher registration with explicit no-polling/no-symlink options', async () => {
    const f = await fixture();
    await f.write('source.pdf', 'source');
    const fileMetadata = await lstat(join(f.root, 'source.pdf'));
    const directoryMetadata = await lstat(f.root);
    const emitter = new EventEmitter();
    const close = vi.fn(async () => undefined);
    const handle = Object.assign(emitter, { close });
    const watch = vi.spyOn(chokidar, 'watch').mockImplementation(() => {
      queueMicrotask(() => emitter.emit('ready'));
      return handle as unknown as ReturnType<typeof chokidar.watch>;
    });
    const onError = vi.fn();
    const watching = await createFolderTriggerWatcher(f.root, {
      cwd: f.root,
      depth: 7,
      ignored: () => false,
      awaitWriteFinish: { stabilityThreshold: 2_000, pollInterval: 100 },
      atomic: true,
      onChange: () => undefined,
      onError,
    });
    await watching.ready;
    const options = watch.mock.calls[0]![1]!;
    expect(options).toMatchObject({
      ignoreInitial: true,
      followSymlinks: false,
      usePolling: false,
    });
    expect(typeof options.ignored).toBe('function');
    const ignored = options.ignored as (
      path: string,
      metadata?: typeof fileMetadata,
    ) => boolean;
    expect(ignored(f.root, directoryMetadata)).toBe(false);
    for (let i = 0; i < folderTriggerMaximumFiles; i++)
      expect(ignored(join(f.root, `${i}.pdf`), fileMetadata)).toBe(false);
    expect(ignored(join(f.root, 'over-limit.pdf'), fileMetadata)).toBe(true);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'FOLDER_TRIGGER_WATCH_LIMIT' }),
    );
    emitter.emit('unlink', '0.pdf');
    expect(ignored(join(f.root, 'replacement.pdf'), fileMetadata)).toBe(false);
    await watching.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('records a complete initial baseline without triggering existing files, then deduplicates changes', async () => {
    const f = await fixture();
    await f.write('existing.pdf', 'original');
    const watcher = f.make();
    await watcher.start();
    expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([]);
    expect(f.options()).toMatchObject({
      cwd: f.root,
      depth: 7,
      atomic: true,
      awaitWriteFinish: { stabilityThreshold: 2_000, pollInterval: 100 },
    });
    await f.write('new.pdf', 'complete');
    for (let i = 0; i < 6; i++) f.emit('new.pdf');
    await watcher.idle();
    const events = await f.journal.pendingFolderTriggers(f.rule);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      path: 'new.pdf',
      expected: await inspectLocalFile(f.root, 'new.pdf'),
    });
    f.emit('new.pdf', 'change');
    await watcher.idle();
    expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual(events);
    await watcher.close();
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('half-written/same-size overwritten files never enqueue that observed partial version', async () => {
    const f = await fixture(),
      watcher = f.make();
    await watcher.start();
    const gate = deferred();
    f.settle.mockImplementationOnce(async () => gate.promise);
    await f.write('new.pdf', 'part');
    f.emit('new.pdf');
    await vi.waitFor(() => expect(f.settle).toHaveBeenCalledTimes(1));
    expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([]);
    await f.write('new.pdf', 'full');
    gate.resolve();
    await watcher.idle();
    expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([]);
    expect(f.onError).toHaveBeenCalledWith('FOLDER_TRIGGER_FILE_CHANGED');
    f.emit('new.pdf', 'change');
    await watcher.idle();
    expect(await f.journal.pendingFolderTriggers(f.rule)).toMatchObject([
      {
        expected: {
          checksum: `sha256:${createHash('sha256').update('full').digest('hex')}`,
        },
      },
    ]);
  });
  it('an in-flight notification is observed again, without dropping the latest version', async () => {
    const f = await fixture(),
      watcher = f.make();
    await watcher.start();
    const gate = deferred();
    f.settle.mockImplementationOnce(async () => gate.promise);
    await f.write('new.pdf', 'first');
    f.emit('new.pdf');
    await vi.waitFor(() => expect(f.settle).toHaveBeenCalledTimes(1));
    await f.write('new.pdf', 'second');
    f.emit('new.pdf', 'change');
    gate.resolve();
    await watcher.idle();
    expect(await f.journal.pendingFolderTriggers(f.rule)).toMatchObject([
      { expected: await inspectLocalFile(f.root, 'new.pdf') },
    ]);
  });
  it('ignores temporary/sensitive/output/foreign paths without inspecting bytes', async () => {
    const f = await fixture(),
      watcher = f.make();
    await watcher.start();
    f.inspect.mockClear();
    for (const path of [
      'output/answer.pdf',
      'OUTPUT/answer.pdf',
      '.git/a.pdf',
      '.allrice-id.part',
      '.allrice-file-id.pdf',
      '~$locked.xlsx',
      'inbox/partial.pdf.tmp',
      '../outside.pdf',
      '/outside.pdf',
      'not-an-input.txt',
    ])
      f.emit(path);
    await watcher.idle();
    expect(f.inspect).not.toHaveBeenCalled();
    expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([]);
  });
  it('reconnects from persisted baseline and supplements only versions still present', async () => {
    const f = await fixture();
    await f.write('old.pdf', 'original');
    await f.write('deleted.pdf', 'gone');
    const watcher = f.make();
    await watcher.start();
    await watcher.close();
    await f.journal.close();
    await f.write('old.pdf', 'changed');
    await f.write('new.xlsx', 'new');
    await f.write('short-lived.pdf', 'lost');
    await unlink(join(f.root, 'short-lived.pdf'));
    await unlink(join(f.root, 'deleted.pdf'));
    const journal = await f.open();
    const recovered = f.make({ journal });
    expect(await recovered.start()).toMatchObject({
      complete: true,
      queuedEvents: 2,
    });
    expect(
      (await journal.pendingFolderTriggers(f.rule))
        .map((event) => event.path)
        .sort(),
    ).toEqual(['new.xlsx', 'old.pdf']);
    expect(
      (await journal.folderTriggerSnapshot(f.rule))?.files
        .map((file) => file.path)
        .sort(),
    ).toEqual(['new.xlsx', 'old.pdf']);
  });
  it('incomplete recovery preserves missing snapshot members; incomplete initial scan refuses readiness', async () => {
    const f = await fixture();
    await f.write('existing.pdf', 'old');
    const incomplete = f.make({
      scan: async () => ({ files: [], complete: false, truncated: true }),
    });
    await expect(incomplete.start()).rejects.toThrow(
      'FOLDER_TRIGGER_SCAN_INCOMPLETE',
    );
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    const watcher = f.make();
    await watcher.start();
    f.scan.mockResolvedValueOnce({
      files: [],
      complete: false,
      truncated: true,
    });
    expect(await watcher.reconcile()).toMatchObject({
      complete: false,
      truncated: true,
    });
    expect((await f.journal.folderTriggerSnapshot(f.rule))?.files).toHaveLength(
      1,
    );
  });
  it.each(['root', 'directory'] as const)(
    'same-path %s inode replacement closes without accepting new files',
    async (kind) => {
      const f = await fixture(),
        rule =
          kind === 'directory' ? { ...f.rule, relativePath: 'inbox' } : f.rule;
      const watcher = f.make({ rule });
      await watcher.start();
      const path = kind === 'root' ? f.root : join(f.root, 'inbox');
      await rename(path, path + '-old');
      await mkdir(path);
      if (kind === 'root') await mkdir(join(f.root, 'inbox'));
      await f.write('inbox/a.pdf', 'new directory');
      f.emit('inbox/a.pdf');
      await watcher.idle();
      await watcher.close();
      expect(f.onError).toHaveBeenCalledWith('FOLDER_TRIGGER_ROOT_CHANGED');
      expect(f.close).toHaveBeenCalledTimes(1);
      expect(await f.journal.pendingFolderTriggers(rule)).toEqual([]);
    },
  );
  it('a replaced root stays rejected after restart before creating a watcher', async () => {
    const f = await fixture(),
      first = f.make();
    await first.start();
    await first.close();
    await rename(f.root, f.root + '-old');
    await mkdir(f.root);
    const recovered = f.make();
    await expect(recovered.start()).rejects.toThrow(
      'FOLDER_TRIGGER_ROOT_CHANGED',
    );
    expect(f.factory).toHaveBeenCalledTimes(1);
  });
  it('revocation while waiting for stability prevents event and releases watcher', async () => {
    const f = await fixture();
    let authorized = true;
    const watcher = f.make({ authorize: async () => authorized });
    await watcher.start();
    const gate = deferred();
    f.settle.mockImplementationOnce(async () => gate.promise);
    await f.write('a.pdf', 'a');
    f.emit('a.pdf');
    await vi.waitFor(() => expect(f.settle).toHaveBeenCalledTimes(1));
    authorized = false;
    gate.resolve();
    await watcher.idle();
    await watcher.close();
    expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([]);
    expect(f.onError).toHaveBeenCalledWith('FOLDER_TRIGGER_SCOPE_REVOKED');
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('expires an idle admission and only permits same-scope lease renewal', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const rule = {
      ...f.rule,
      admissionExpiresAt: new Date(Date.now() + 1_000).toISOString(),
    };
    const watcher = f.make({ rule });
    await watcher.start();
    await watcher.reconcile({
      ...rule,
      admissionExpiresAt: new Date(Date.now() + 2_000).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(f.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await watcher.close();
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.onError).toHaveBeenCalledWith('FOLDER_TRIGGER_ADMISSION_EXPIRED');
    expect(await f.journal.pendingFolderTriggers(rule)).toEqual([]);
  });
  it('changed revision cannot reuse an instance or migrate old outbox; close aborts before a late factory resolves', async () => {
    const f = await fixture(),
      watcher = f.make();
    await watcher.start();
    await expect(watcher.reconcile({ ...f.rule, revision: 2 })).rejects.toThrow(
      'FOLDER_TRIGGER_SCOPE_CHANGED',
    );
    await watcher.close();
    const gate = deferred(),
      entered = deferred(),
      close = vi.fn(async () => undefined);
    const late = f.make({
      watcherFactory: async () => {
        entered.resolve();
        await gate.promise;
        return { ready: Promise.resolve(), close };
      },
    });
    const starting = late.start();
    await entered.promise;
    await late.close();
    gate.resolve();
    await expect(starting).rejects.toThrow('FOLDER_TRIGGER_CLOSED');
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('close aborts readiness wait and waits for actual handle release', async () => {
    const f = await fixture(),
      ready = deferred(),
      released = deferred();
    const close = vi.fn(async () => released.promise);
    const watcher = f.make({
      watcherFactory: async () => ({ ready: ready.promise, close }),
    });
    const starting = watcher.start();
    // Own the rejection before cancellation, as real callers must.
    const rejected = expect(starting).rejects.toThrow('FOLDER_TRIGGER_CLOSED');
    await vi.waitFor(() =>
      expect((watcher as unknown as { handle: unknown }).handle).not.toBeNull(),
    );
    let finished = false;
    const stopping = watcher.close().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    released.resolve();
    await stopping;
    await rejected;
  });
});

describe.skipIf(process.platform !== 'darwin')(
  'actual Chokidar and sealed native-byte ports on owned temp',
  () => {
    let executable: string, compileRoot: string;
    beforeAll(async () => {
      compileRoot = await realpath(
        await mkdtemp(join(tmpdir(), 'rice-folder-native-')),
      );
      executable = join(compileRoot, 'FileGuardian');
      await promisify(execFile)(
        '/usr/bin/xcrun',
        [
          'swiftc',
          '-O',
          '-target',
          `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
          new URL('../native/FileGuardian.swift', import.meta.url).pathname,
          '-o',
          executable,
        ],
        { timeout: 30_000, maxBuffer: 64_000 },
      );
    }, 35_000);
    afterAll(async () => {
      if (compileRoot) await rm(compileRoot, { recursive: true, force: true });
    });
    it('uses actual fixed native survey/read CAS, preserves original hash and waits for stable real events', async () => {
      const f = await fixture();
      vi.spyOn(resources, 'inspectFixedFileGuardian').mockReturnValue(
        executable,
      );
      // Only the fixed path loader is test-specific; watcher, scan, read and SQLite are real.
      const watcher = new FolderTriggerWatcher({
        rule: f.rule,
        journal: f.journal,
        getRoot: async () => f.root,
        onError: f.onError,
      });
      watchers.push(watcher);
      await f.write('existing.pdf', 'preexisting');
      expect(await watcher.start()).toMatchObject({
        complete: true,
        queuedEvents: 0,
      });
      const finalBytes = Buffer.from('%PDF-1.7\n合成原始二进制\0\xff');
      await writeFile(join(f.root, 'stable.pdf'), finalBytes.subarray(0, 6));
      await new Promise((done) => setTimeout(done, 120));
      expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([]);
      await writeFile(join(f.root, 'stable.pdf'), finalBytes);
      await vi.waitFor(
        async () =>
          expect(await f.journal.pendingFolderTriggers(f.rule)).toHaveLength(1),
        { timeout: 12_000, interval: 100 },
      );
      expect((await f.journal.pendingFolderTriggers(f.rule))[0]).toMatchObject({
        path: 'stable.pdf',
        expected: await inspectLocalFile(f.root, 'stable.pdf'),
      });
      expect(f.onError).not.toHaveBeenCalled();
      await watcher.close();
      await writeFile(join(f.root, 'closed.pdf'), 'closed');
      await new Promise((done) => setTimeout(done, 150));
      expect(await f.journal.pendingFolderTriggers(f.rule)).toHaveLength(1);
    }, 18_000);
  },
);
