import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import {
  RuntimeBridgeDispatchSchema,
  RuntimeBridgeReceiptSchema,
  RuntimeLocalCommandResultSchema,
  ChangesetFileResultSchema,
  type ChangesetFileResult,
  type RuntimeLocalCommandResult,
  canonicalRuntimeBridgeJson,
  type RuntimeBridgeDispatch,
  type RuntimeBridgeReceipt,
} from '@allrice/contracts';
import { initialChangesetResults } from './changeset-executor.js';

export const maximumReceiptBytes = 500_000;
const reservePerEntry = maximumReceiptBytes + 32_768;
const openDirectories = new Set<string>();

export class BridgeJournalError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export function bridgeDigest(value: unknown) {
  return `sha256:${createHash('sha256')
    .update(canonicalRuntimeBridgeJson(value))
    .digest('hex')}`;
}

function secureMetadata(metadata: Stats, directory = false) {
  if (
    (directory ? !metadata.isDirectory() : !metadata.isFile()) ||
    metadata.isSymbolicLink() ||
    (!directory && metadata.nlink !== 1) ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid && metadata.uid !== process.getuid())
  ) {
    throw new BridgeJournalError('JOURNAL_UNSAFE_PATH');
  }
}

async function syncDirectory(path: string) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface EntryRow {
  operation_id: string;
  fingerprint: string;
  dispatch: string;
  state: 'received' | 'executing' | 'completed' | 'unknown';
  start_receipt_id: string;
}

/**
 * Local execution evidence, NOT the scheduling/authorization authority.
 * SQLite EXCLUSIVE locking_mode retains the OS lock across durable commits;
 * only one live process can execute/recover this device journal at a time.
 */
export class BridgeJournal {
  private closed = false;
  private poisoned = false;
  private recoveryCursor = 0;

  private constructor(
    private readonly database: DatabaseSync,
    private readonly directory: string,
    private readonly directoryIdentity: { dev: number; ino: number },
    private readonly fileIdentity: { dev: number; ino: number },
    private readonly identity: { server: string; deviceId: string },
    private readonly limits: { entries: number; bytes: number },
  ) {}

  static async open(input: {
    directory: string;
    server: string;
    deviceId: string;
    limits?: { entries: number; bytes: number };
  }): Promise<BridgeJournal> {
    const server = new URL(input.server).origin;
    const origin = new URL(server);
    if (
      origin.protocol !== 'https:' &&
      !(
        origin.protocol === 'http:' &&
        ['127.0.0.1', '[::1]'].includes(origin.hostname)
      )
    ) {
      throw new BridgeJournalError('JOURNAL_SERVER_INVALID');
    }
    const parent = await realpath(dirname(resolve(input.directory)));
    const directory = join(parent, basename(input.directory));
    // Never open/close another raw descriptor for a DB already open in this
    // process: POSIX descriptor close can otherwise disturb SQLite's locks.
    if (openDirectories.has(directory))
      throw new BridgeJournalError('JOURNAL_ALREADY_OPEN');
    openDirectories.add(directory);
    try {
      await mkdir(directory, { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        },
      );
      const metadata = await lstat(directory);
      secureMetadata(metadata, true);
      if ((await realpath(directory)) !== directory) {
        throw new BridgeJournalError('JOURNAL_UNSAFE_PATH');
      }
      const path = join(directory, 'journal.sqlite');
      const existing = await lstat(path).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        },
      );
      if (existing) secureMetadata(existing);
      const handle = await open(
        path,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        secureMetadata(await handle.stat());
        await handle.sync();
      } finally {
        await handle.close();
      }
      // SQLite may need to recover its own hot journal after a process crash.
      for (const suffix of ['-journal', '-wal', '-shm']) {
        const sidecar = await lstat(`${path}${suffix}`).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          },
        );
        if (sidecar) secureMetadata(sidecar);
      }
      // Loaded only by the opt-in path; old Bridge startup has no SQLite dependency.
      const { DatabaseSync: SQLite } = await import('node:sqlite');
      const database = new SQLite(path);
      try {
        database.exec(
          'PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON; BEGIN EXCLUSIVE; COMMIT;',
        );
        const version = database
          .prepare('PRAGMA user_version')
          .get()?.user_version;
        if (version !== 0 && version !== 1)
          throw new BridgeJournalError('JOURNAL_VERSION_UNSUPPORTED');
        database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), server TEXT NOT NULL, device_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS entries (
          operation_id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          dispatch TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('received','executing','completed','unknown')),
          start_receipt_id TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS outbox (
          receipt_id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL REFERENCES entries(operation_id),
          body TEXT NOT NULL,
          delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1))
        );
        CREATE TABLE IF NOT EXISTS changeset_files (
          operation_id TEXT NOT NULL REFERENCES entries(operation_id),
          file_index INTEGER NOT NULL CHECK(file_index>=0 AND file_index<32),
          result TEXT NOT NULL,
          PRIMARY KEY(operation_id,file_index)
        );
        PRAGMA user_version=1;
        COMMIT;
      `);
        const stored = database
          .prepare('SELECT server, device_id FROM identity WHERE singleton=1')
          .get();
        if (
          stored &&
          (stored.server !== server || stored.device_id !== input.deviceId)
        ) {
          throw new BridgeJournalError('JOURNAL_IDENTITY_MISMATCH');
        }
        if (!stored)
          database
            .prepare('INSERT INTO identity VALUES (1, ?, ?)')
            .run(server, input.deviceId);
        await syncDirectory(directory);
        await syncDirectory(parent);
        const journal = new BridgeJournal(
          database,
          directory,
          metadata,
          await lstat(path),
          { server, deviceId: input.deviceId },
          input.limits ?? { entries: 1_000, bytes: 128 * 1024 * 1024 },
        );
        // The exclusive OS lock proves a previous live owner cannot still be using
        // this journal. It says nothing about external effects: never replay them.
        for (const row of database
          .prepare(
            "SELECT * FROM entries WHERE state IN ('received','executing')",
          )
          .all() as unknown as EntryRow[]) {
          if (row.state === 'executing') {
            const dispatch = RuntimeBridgeDispatchSchema.parse(
              JSON.parse(row.dispatch),
            );
            if (dispatch.payload.capability === 'local.fs.changeset') {
              const files = initialChangesetResults(dispatch.payload);
              for (const saved of database
                .prepare(
                  'SELECT file_index,result FROM changeset_files WHERE operation_id=?',
                )
                .all(row.operation_id)) {
                const result = ChangesetFileResultSchema.parse(
                  JSON.parse(String(saved.result)),
                );
                files[Number(saved.file_index)] = {
                  ...result,
                  status:
                    result.status === 'prepared' ? 'unknown' : result.status,
                };
              }
              const output = { contractVersion: 1 as const, files };
              const applied = files.filter(
                (f) => f.status === 'applied',
              ).length;
              if (files.some((f) => f.status === 'unknown'))
                await journal.uncertain(row.operation_id, 'receipt_missing', {
                  summary:
                    'Bridge 已重启；逐文件日志保留，结果未知的文件不重做',
                  output,
                });
              else
                await journal.outcome(row.operation_id, {
                  status:
                    applied === files.length
                      ? 'succeeded'
                      : applied
                        ? 'partial'
                        : 'failed',
                  effects:
                    applied === files.length
                      ? 'applied'
                      : applied
                        ? 'partial'
                        : 'none',
                  summary:
                    'Bridge 已重启，按已持久化的逐文件记录收口；未继续写入',
                  output,
                });
            } else await journal.uncertain(row.operation_id, 'receipt_missing');
          } else {
            await journal.outcome(row.operation_id, {
              status: 'failed',
              effects: 'none',
              summary: 'Previous Bridge exited before execution was started',
              errorCode: 'NOT_STARTED_BEFORE_RESTART',
            });
          }
        }
        return journal;
      } catch (error) {
        database.close();
        throw error;
      }
    } catch (error) {
      openDirectories.delete(directory);
      throw error;
    }
  }

  private async guard() {
    if (this.closed || this.poisoned)
      throw new BridgeJournalError('JOURNAL_UNAVAILABLE');
    const current = await lstat(this.directory);
    secureMetadata(current, true);
    if (
      current.dev !== this.directoryIdentity.dev ||
      current.ino !== this.directoryIdentity.ino
    ) {
      this.poisoned = true;
      throw new BridgeJournalError('JOURNAL_DIRECTORY_CHANGED');
    }
    const file = await lstat(join(this.directory, 'journal.sqlite'));
    secureMetadata(file);
    if (
      file.dev !== this.fileIdentity.dev ||
      file.ino !== this.fileIdentity.ino
    ) {
      this.poisoned = true;
      throw new BridgeJournalError('JOURNAL_FILE_CHANGED');
    }
  }

  assertIdentity(server: string, deviceId: string) {
    if (
      new URL(server).origin !== this.identity.server ||
      deviceId !== this.identity.deviceId
    ) {
      throw new BridgeJournalError('JOURNAL_IDENTITY_MISMATCH');
    }
  }

  assertWorkspace(root: string) {
    // Do not let an approved workspace command tamper with its own execution
    // evidence. A home-directory-wide grant needs a narrower project folder.
    const path = relative(root, this.directory);
    if (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)) {
      throw new BridgeJournalError('WORKSPACE_CONTAINS_JOURNAL');
    }
  }

  private transaction<T>(action: () => T): T {
    let began = false;
    try {
      this.database.exec('BEGIN IMMEDIATE');
      began = true;
      const result = action();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      if (began) {
        try {
          this.database.exec('ROLLBACK');
        } catch {
          this.poisoned = true;
        }
      }
      // A disk/SQLite/commit failure is not a transport retry. Stop all new
      // work in this process; restart under the exclusive lock reconciles any
      // committed executing marker to unknown. Expected policy/quota conflicts
      // have made no changes and may safely leave the journal usable.
      if (!(error instanceof BridgeJournalError)) this.poisoned = true;
      throw error;
    }
  }

  private entry(operationId: string): EntryRow {
    const row = this.database
      .prepare('SELECT * FROM entries WHERE operation_id=?')
      .get(operationId) as unknown as EntryRow | undefined;
    if (!row) throw new BridgeJournalError('JOURNAL_OPERATION_MISSING');
    return row;
  }

  async receive(input: RuntimeBridgeDispatch): Promise<'new' | 'duplicate'> {
    const dispatch = RuntimeBridgeDispatchSchema.parse(input);
    await this.guard();
    if (dispatch.snapshot.binding.execution.deviceId !== this.identity.deviceId)
      throw new BridgeJournalError('JOURNAL_DEVICE_MISMATCH');
    if (
      dispatch.snapshot.binding.inputDigest !== bridgeDigest(dispatch.payload)
    )
      throw new BridgeJournalError('JOURNAL_PAYLOAD_MISMATCH');
    const id = dispatch.snapshot.binding.attempt.operationId;
    const fingerprint = bridgeDigest(dispatch);
    return this.transaction(() => {
      const previous = this.database
        .prepare('SELECT fingerprint FROM entries WHERE operation_id=?')
        .get(id);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new BridgeJournalError('JOURNAL_DISPATCH_CONFLICT');
        return 'duplicate';
      }
      const count = Number(
        this.database.prepare('SELECT count(*) AS n FROM entries').get()?.n,
      );
      const pending = Number(
        this.database
          .prepare(
            "SELECT count(*) AS n FROM entries WHERE state IN ('received','executing')",
          )
          .get()?.n,
      );
      const pages = Number(
        this.database.prepare('PRAGMA page_count').get()?.page_count,
      );
      const pageSize = Number(
        this.database.prepare('PRAGMA page_size').get()?.page_size,
      );
      const body = canonicalRuntimeBridgeJson(dispatch);
      if (
        Buffer.byteLength(body) > maximumReceiptBytes ||
        count >= this.limits.entries ||
        pages * pageSize +
          (pending + 1) * reservePerEntry +
          Buffer.byteLength(body) >
          this.limits.bytes
      ) {
        throw new BridgeJournalError('JOURNAL_CAPACITY_REACHED');
      }
      this.database
        .prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?)')
        .run(id, fingerprint, body, 'received', randomUUID());
      return 'new';
    });
  }

  async begin(operationId: string) {
    await this.guard();
    return this.transaction(() => {
      const row = this.entry(operationId);
      if (row.state !== 'received')
        throw new BridgeJournalError('JOURNAL_EXECUTION_ALREADY_CLAIMED');
      this.database
        .prepare("UPDATE entries SET state='executing' WHERE operation_id=?")
        .run(operationId);
      return { receiptId: row.start_receipt_id };
    });
  }

  private append(
    row: EntryRow,
    signal: RuntimeBridgeReceipt['signal'],
    evidence?: RuntimeBridgeReceipt['evidence'],
  ) {
    const dispatch = RuntimeBridgeDispatchSchema.parse(
      JSON.parse(row.dispatch),
    );
    const receipt = RuntimeBridgeReceiptSchema.parse({
      contractVersion: 1,
      receiptId: randomUUID(),
      attempt: dispatch.snapshot.binding.attempt,
      leaseToken: dispatch.leaseToken,
      deviceSequence: 0,
      signal,
      ...(evidence ? { evidence } : {}),
    });
    const body = canonicalRuntimeBridgeJson(receipt);
    if (Buffer.byteLength(body) > maximumReceiptBytes)
      throw new BridgeJournalError('JOURNAL_RESULT_TOO_LARGE');
    this.database
      .prepare(
        'INSERT INTO outbox(receipt_id, operation_id, body) VALUES (?, ?, ?)',
      )
      .run(receipt.receiptId, row.operation_id, body);
    return receipt;
  }

  async outcome(
    operationId: string,
    result: {
      status: 'succeeded' | 'failed' | 'partial';
      effects: 'none' | 'applied' | 'partial';
      summary: string;
      output?: unknown;
      errorCode?: string;
    },
  ) {
    await this.guard();
    return this.transaction(() => {
      const row = this.entry(operationId);
      if (!['received', 'executing'].includes(row.state))
        throw new BridgeJournalError('JOURNAL_RESULT_ALREADY_FINAL');
      const evidence = {
        // Display summaries are bounded independently of the known execution
        // result. Long legal paths must not turn a completed write into unknown.
        summary:
          result.summary
            .trim()
            .slice(0, 500)
            .replace(/[\uD800-\uDBFF]$/, '') || 'Operation result recorded',
        ...(result.output === undefined ? {} : { output: result.output }),
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      };
      const receipt = this.append(
        row,
        {
          type: 'operation.outcome',
          result: {
            status: result.status,
            effects: result.effects,
            evidence: {
              id: randomUUID(),
              recordedAt: new Date().toISOString(),
              digest: bridgeDigest(evidence),
            },
          },
        },
        evidence,
      );
      this.database
        .prepare("UPDATE entries SET state='completed' WHERE operation_id=?")
        .run(operationId);
      return receipt;
    });
  }

  async stopped(operationId: string, output: unknown, summary: string) {
    await this.guard();
    return this.transaction(() => {
      const row = this.entry(operationId);
      if (!['received', 'executing'].includes(row.state))
        throw new BridgeJournalError('JOURNAL_RESULT_ALREADY_FINAL');
      const evidence = { summary: summary.slice(0, 500), output };
      const receipt = this.append(
        row,
        {
          type: 'operation.stopped',
          effects: 'none',
          evidence: {
            id: randomUUID(),
            recordedAt: new Date().toISOString(),
            digest: bridgeDigest(evidence),
          },
        },
        evidence,
      );
      this.database
        .prepare("UPDATE entries SET state='completed' WHERE operation_id=?")
        .run(operationId);
      return receipt;
    });
  }

  async uncertain(
    operationId: string,
    reason: 'receipt_missing' | 'lease_lost' | 'connection_lost',
    evidence?: RuntimeBridgeReceipt['evidence'],
  ) {
    await this.guard();
    return this.transaction(() => {
      const row = this.entry(operationId);
      if (!['received', 'executing'].includes(row.state))
        throw new BridgeJournalError('JOURNAL_RESULT_ALREADY_FINAL');
      const receipt = this.append(
        row,
        { type: 'operation.uncertain', reason },
        evidence,
      );
      this.database
        .prepare("UPDATE entries SET state='unknown' WHERE operation_id=?")
        .run(operationId);
      return receipt;
    });
  }

  async changesetCheckpoint(
    operationId: string,
    index: number,
    input: ChangesetFileResult,
  ) {
    await this.guard();
    const result = ChangesetFileResultSchema.parse(input);
    this.transaction(() => {
      const row = this.entry(operationId),
        dispatch = RuntimeBridgeDispatchSchema.parse(JSON.parse(row.dispatch));
      if (
        row.state !== 'executing' ||
        dispatch.payload.capability !== 'local.fs.changeset' ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= dispatch.payload.arguments.files.length
      )
        throw new BridgeJournalError('JOURNAL_CHANGESET_INVALID');
      const f = dispatch.payload.arguments.files[index]!;
      if (
        result.path !== f.path ||
        result.beforeChecksum !== (f.before?.checksum ?? null) ||
        result.afterChecksum !== (f.after?.checksum ?? null)
      )
        throw new BridgeJournalError('JOURNAL_CHANGESET_INVALID');
      const previous = this.database
        .prepare(
          'SELECT result FROM changeset_files WHERE operation_id=? AND file_index=?',
        )
        .get(operationId, index);
      if (
        previous &&
        ChangesetFileResultSchema.parse(JSON.parse(String(previous.result)))
          .status !== 'prepared'
      )
        throw new BridgeJournalError('JOURNAL_CHANGESET_ALREADY_FINAL');
      this.database
        .prepare(
          'INSERT INTO changeset_files VALUES(?,?,?) ON CONFLICT(operation_id,file_index) DO UPDATE SET result=excluded.result',
        )
        .run(operationId, index, canonicalRuntimeBridgeJson(result));
    });
  }

  async unknownLocalCommands() {
    await this.guard();
    const select = this.database.prepare(
      "SELECT rowid,dispatch FROM entries WHERE state='unknown' AND json_extract(dispatch,'$.payload.capability')='local.process.execute' AND rowid>? ORDER BY rowid LIMIT 16",
    );
    let rows = select.all(this.recoveryCursor);
    if (!rows.length) rows = select.all(0);
    this.recoveryCursor = Number(rows.at(-1)?.rowid ?? 0);
    return rows.map((row) =>
      RuntimeBridgeDispatchSchema.parse(JSON.parse(String(row.dispatch))),
    );
  }

  /** Caller must obtain exact-container terminal evidence from LocalCommandRunner.recover. */
  async reconcileLocalCommand(
    operationId: string,
    input: RuntimeLocalCommandResult,
  ) {
    await this.guard();
    const result = RuntimeLocalCommandResultSchema.parse(input);
    return this.transaction(() => {
      const row = this.entry(operationId),
        dispatch = RuntimeBridgeDispatchSchema.parse(JSON.parse(row.dispatch));
      if (
        row.state !== 'unknown' ||
        dispatch.payload.capability !== 'local.process.execute' ||
        dispatch.payload.arguments.imageDigest !== result.imageDigest
      )
        throw new BridgeJournalError('JOURNAL_RECOVERY_MISMATCH');
      const evidence = {
        summary: `已核实重启前的本地命令：退出 ${result.exitCode}（${result.reason}）；未重跑`,
        output: result,
      };
      const ref = {
        id: randomUUID(),
        recordedAt: new Date().toISOString(),
        digest: bridgeDigest(evidence),
      };
      const receipt = this.append(
        row,
        ['canceled', 'lease_lost'].includes(result.reason)
          ? { type: 'operation.stopped', effects: 'none', evidence: ref }
          : {
              type: 'operation.outcome',
              result: {
                status:
                  result.reason === 'exited' && result.exitCode === 0
                    ? 'succeeded'
                    : 'failed',
                effects: 'none',
                evidence: ref,
              },
            },
        evidence,
      );
      this.database
        .prepare("UPDATE entries SET state='completed' WHERE operation_id=?")
        .run(operationId);
      return receipt;
    });
  }

  async pending(limit = 16): Promise<RuntimeBridgeReceipt[]> {
    await this.guard();
    const bounded = Math.min(32, Math.max(1, Math.floor(limit)));
    return this.database
      .prepare(
        'SELECT body FROM outbox WHERE delivered=0 ORDER BY rowid LIMIT ?',
      )
      .all(bounded)
      .map((row) =>
        RuntimeBridgeReceiptSchema.parse(JSON.parse(String(row.body))),
      );
  }

  async acknowledge(receiptId: string) {
    await this.guard();
    this.database
      .prepare('UPDATE outbox SET delivered=1 WHERE receipt_id=?')
      .run(receiptId);
    // Keep immutable evidence and operation tombstones. An ACK never makes the
    // operation executable again; retention/full-disk requires explicit handling.
  }

  async close() {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
    openDirectories.delete(this.directory);
  }
}
