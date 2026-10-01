import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalFileObjectSchema,
  LocalFilePayloadSchema,
  localFileMaximumBytes,
  type LocalFileObject,
} from '@allrice/contracts';
import {
  executeLocalFile,
  inspectLocalFile,
  LocalFileError,
  type LocalFileTransport,
} from './local-files.js';
import { BridgeJournal } from './journal.js';
import { fixtureId } from './journal-fixtures.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
const hash = (b: Uint8Array) =>
  `sha256:${createHash('sha256').update(b).digest('hex')}`;
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-met164-files-')),
  );
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, '目录 带 空格');
  await mkdir(workspace);
  const stored = new Map<string, Buffer>();
  const transport: LocalFileTransport = {
    async upload(file, fileName, stream, ref) {
      const bytes = Buffer.from(await new Response(stream).arrayBuffer());
      expect(bytes.length).toBe(file.sizeBytes);
      expect(hash(bytes)).toBe(file.checksum);
      const object = LocalFileObjectSchema.parse({
        objectId: ref?.objectId ?? randomUUID(),
        checksum: file.checksum,
        sizeBytes: file.sizeBytes,
        mediaType: file.mediaType,
        fileName,
        deliverableVersionId: null,
        deliverableVersion: null,
      });
      stored.set(object.objectId, bytes);
      return object;
    },
    async download(ref) {
      const bytes = stored.get(ref.objectId);
      if (!bytes) throw Error('missing bytes');
      return new ReadableStream({
        start(c) {
          for (let i = 0; i < bytes.length; i += 2048)
            c.enqueue(bytes.subarray(i, i + 2048));
          c.close();
        },
      });
    },
  };
  return { root, workspace, transport, stored, authorize: async () => true };
}
const binary = Buffer.concat([
  Buffer.from([0x50, 0x4b, 3, 4, 0, 0xff, 0xfe, 0]),
  Buffer.from('中文资料\0'),
  Buffer.alloc(125_000, 0xa5),
]);
describe('MET164 binary file handoff on real files', () => {
  it.each(['docx', 'xlsx', 'pptx', 'pdf', 'png'])(
    'round-trips %s bytes, Chinese/spaces, and a usable saved version',
    async (extension) => {
      const f = await fixture(),
        path = `原始 中文 文件.${extension}`;
      await writeFile(join(f.workspace, path), binary, { mode: 0o600 });
      const expected = await inspectLocalFile(f.workspace, path);
      const object = LocalFileObjectSchema.parse({
        objectId: randomUUID(),
        checksum: expected.checksum,
        sizeBytes: expected.sizeBytes,
        mediaType: expected.mediaType,
        fileName: path,
        deliverableVersionId: null,
        deliverableVersion: null,
      });
      const imported = await executeLocalFile(
        f.workspace,
        LocalFilePayloadSchema.parse({
          capability: 'local.file.import',
          arguments: { path, expected, object },
        }),
        f,
      );
      expect(imported).toMatchObject({
        status: 'uploaded',
        platformUploaded: true,
        localSaved: false,
      });
      const outputPath = `保存 副本.${extension}`;
      const saved = await executeLocalFile(
        f.workspace,
        {
          capability: 'local.file.save',
          arguments: { path: outputPath, object },
        },
        f,
      );
      expect(saved).toMatchObject({
        status: 'saved',
        platformUploaded: false,
        localSaved: true,
      });
      expect(await readFile(join(f.workspace, outputPath))).toEqual(binary);
      expect(await inspectLocalFile(f.workspace, outputPath)).toEqual(
        saved.file,
      );
      expect((await stat(join(f.workspace, outputPath))).mode & 0o111).toBe(0);
      expect(
        (await readdir(f.workspace)).filter((n) => n.endsWith('.part')),
      ).toEqual([]);
      const openFile = vi.fn(async () => undefined);
      await executeLocalFile(
        f.workspace,
        {
          capability: 'local.file.open',
          arguments: { path: outputPath, expected: saved.file },
        },
        { ...f, openFile },
      );
      expect(openFile).toHaveBeenCalledWith(
        join(f.workspace, outputPath),
        false,
      );
    },
  );
  it('does not import changed/moved files or follow a symlink outside the folder', async () => {
    const f = await fixture(),
      path = '输入.xlsx';
    await writeFile(join(f.workspace, path), binary);
    const expected = await inspectLocalFile(f.workspace, path);
    const object: LocalFileObject = {
      objectId: randomUUID(),
      checksum: expected.checksum,
      sizeBytes: expected.sizeBytes,
      mediaType: expected.mediaType,
      fileName: path,
      deliverableVersionId: null,
      deliverableVersion: null,
    };
    const upload = vi.spyOn(f.transport, 'upload');
    await writeFile(join(f.workspace, path), Buffer.alloc(binary.length, 1));
    await expect(
      executeLocalFile(
        f.workspace,
        {
          capability: 'local.file.import',
          arguments: { path, expected, object },
        },
        f,
      ),
    ).rejects.toMatchObject({ code: 'FILE_CHANGED' });
    await rename(join(f.workspace, path), join(f.workspace, 'moved.xlsx'));
    await expect(
      executeLocalFile(
        f.workspace,
        {
          capability: 'local.file.import',
          arguments: { path, expected, object },
        },
        f,
      ),
    ).rejects.toThrow();
    await writeFile(join(f.root, 'outside.xlsx'), binary);
    await symlink(join(f.root, 'outside.xlsx'), join(f.workspace, path));
    await expect(inspectLocalFile(f.workspace, path)).rejects.toThrow();
    expect(upload).not.toHaveBeenCalled();
  });
  it('native picker cancellation or an out-of-folder choice never uploads', async () => {
    const f = await fixture(),
      upload = vi.spyOn(f.transport, 'upload');
    const payload = {
      capability: 'local.file.select' as const,
      arguments: { path: '.' as const, objectId: randomUUID() },
    };
    await expect(
      executeLocalFile(f.workspace, payload, {
        ...f,
        chooseFile: async () => null,
      }),
    ).rejects.toMatchObject({ code: 'FILE_CANCELED' });
    await writeFile(join(f.root, 'outside.pdf'), binary);
    await expect(
      executeLocalFile(f.workspace, payload, {
        ...f,
        chooseFile: async () => join(f.root, 'outside.pdf'),
      }),
    ).rejects.toThrow();
    expect(upload).not.toHaveBeenCalled();
  });
  it('server cancellation aborts an unanswered native picker without uploading', async () => {
    const f = await fixture(),
      upload = vi.spyOn(f.transport, 'upload');
    let calls = 0,
      pickerClosed = false;
    await expect(
      executeLocalFile(
        f.workspace,
        {
          capability: 'local.file.select',
          arguments: { path: '.', objectId: randomUUID() },
        },
        {
          ...f,
          authorize: async () => ++calls < 2,
          chooseFile: async (_root, signal) =>
            new Promise((resolve) => {
              signal?.addEventListener(
                'abort',
                () => {
                  pickerClosed = true;
                  resolve(null);
                },
                { once: true },
              );
            }),
        },
      ),
    ).rejects.toMatchObject({ code: 'FILE_CANCELED' });
    expect(pickerClosed).toBe(true);
    expect(upload).not.toHaveBeenCalled();
  });
  it('saves opaque original bytes with their source MIME without making them executable', async () => {
    const f = await fixture(),
      object = LocalFileObjectSchema.parse({
        objectId: randomUUID(),
        checksum: hash(binary),
        sizeBytes: binary.length,
        mediaType: 'application/zip',
        fileName: '原始成果.zip',
      });
    f.stored.set(object.objectId, binary);
    const saved = await executeLocalFile(
      f.workspace,
      {
        capability: 'local.file.save',
        arguments: { path: object.fileName, object },
      },
      f,
    );
    expect(saved.file.mediaType).toBe('application/zip');
    expect(await readFile(join(f.workspace, object.fileName))).toEqual(binary);
    const expected = await inspectLocalFile(f.workspace, object.fileName);
    await expect(
      executeLocalFile(
        f.workspace,
        {
          capability: 'local.file.open',
          arguments: { path: object.fileName, expected },
        },
        f,
      ),
    ).rejects.toMatchObject({ code: 'FILE_OPEN_UNSUPPORTED' });
  });
  it('refuses oversized inputs and never overwrites or leaves partial saves', async () => {
    const f = await fixture();
    await writeFile(
      join(f.workspace, 'large.pdf'),
      Buffer.alloc(localFileMaximumBytes + 1),
    );
    await expect(
      inspectLocalFile(f.workspace, 'large.pdf'),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    const object = LocalFileObjectSchema.parse({
      objectId: randomUUID(),
      checksum: hash(binary),
      sizeBytes: binary.length,
      mediaType: 'application/pdf',
      fileName: 'report.pdf',
    });
    f.stored.set(object.objectId, binary);
    await writeFile(join(f.workspace, 'report.pdf'), 'preserve');
    await expect(
      executeLocalFile(
        f.workspace,
        {
          capability: 'local.file.save',
          arguments: { path: 'report.pdf', object },
        },
        f,
      ),
    ).rejects.toMatchObject({ code: 'PATH_ALREADY_EXISTS' });
    expect(await readFile(join(f.workspace, 'report.pdf'), 'utf8')).toBe(
      'preserve',
    );
    let calls = 0;
    await expect(
      executeLocalFile(
        f.workspace,
        {
          capability: 'local.file.save',
          arguments: { path: 'canceled.pdf', object },
        },
        { ...f, authorize: async () => ++calls < 5 },
      ),
    ).rejects.toMatchObject({ code: 'FILE_CANCELED' });
    expect(await readdir(f.workspace)).toEqual(['large.pdf', 'report.pdf']);
    const wrong = { ...object, checksum: hash(Buffer.from('wrong')) };
    await expect(
      executeLocalFile(
        f.workspace,
        {
          capability: 'local.file.save',
          arguments: { path: 'wrong.pdf', object: wrong },
        },
        f,
      ),
    ).rejects.toMatchObject({ code: 'FILE_CHECKSUM_MISMATCH' });
    expect(await readdir(f.workspace)).toEqual(['large.pdf', 'report.pdf']);
  });
  it('retains unknown after commit evidence fails and refuses executable content/default-app failure', async () => {
    const f = await fixture();
    const object = LocalFileObjectSchema.parse({
      objectId: randomUUID(),
      checksum: hash(binary),
      sizeBytes: binary.length,
      mediaType: 'application/pdf',
      fileName: 'unknown.pdf',
    });
    f.stored.set(object.objectId, binary);
    await expect(
      executeLocalFile(
        f.workspace,
        {
          capability: 'local.file.save',
          arguments: { path: 'unknown.pdf', object },
        },
        {
          ...f,
          checkpoint: async () => {
            throw Error('lost journal');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'FILE_SAVE_UNKNOWN', unknown: true });
    expect(await readFile(join(f.workspace, 'unknown.pdf'))).toEqual(binary);
    await writeFile(join(f.workspace, 'script.txt'), '#!/bin/sh\necho unsafe');
    const openFile = vi.fn(async () => undefined),
      expected = await inspectLocalFile(f.workspace, 'script.txt');
    await expect(
      executeLocalFile(
        f.workspace,
        {
          capability: 'local.file.open',
          arguments: { path: 'script.txt', expected },
        },
        { ...f, openFile },
      ),
    ).rejects.toMatchObject({ code: 'FILE_OPEN_UNSUPPORTED' });
    expect(openFile).not.toHaveBeenCalled();
    const pdf = await inspectLocalFile(f.workspace, 'unknown.pdf');
    await expect(
      executeLocalFile(
        f.workspace,
        {
          capability: 'local.file.open',
          arguments: { path: 'unknown.pdf', expected: pdf },
        },
        {
          ...f,
          openFile: async () => {
            throw new LocalFileError('DEFAULT_APPLICATION_UNAVAILABLE');
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'DEFAULT_APPLICATION_UNAVAILABLE',
      unknown: false,
    });
  });
  it('uses the existing SQLite journal for same-command idempotency and crash uncertainty', async () => {
    const f = await fixture();
    const input = {
      directory: join(f.root, 'journal'),
      server: 'https://tenant.example',
      deviceId: fixtureId(11),
    };
    let journal = await BridgeJournal.open(input);
    cleanup.push(() => journal.close());
    const command = {
      id: fixtureId(100),
      deviceId: fixtureId(11),
      folderGrantId: fixtureId(12),
      status: 'claimed' as const,
      payload: {
        capability: 'local.file.inspect' as const,
        arguments: { path: 'report.pdf' },
      },
      leaseToken: fixtureId(15),
      createdAt: new Date().toISOString(),
      timeoutAt: new Date(Date.now() + 60000).toISOString(),
    };
    expect(await journal.beginFileCommand(command)).toBe(true);
    expect(await journal.beginFileCommand(command)).toBe(false);
    await journal.close();
    journal = await BridgeJournal.open(input);
    cleanup.push(() => journal.close());
    expect(await journal.beginFileCommand(command)).toBe(false);
    expect((await journal.pendingFileCommands())[0]?.receipt.status).toBe(
      'unknown',
    );
    expect(await journal.diagnosticCounts()).toMatchObject({
      pendingReceipts: 1,
      unknownOperations: 1,
    });
    await journal.acknowledgeFileCommand(command.id);
    expect(await journal.pendingFileCommands()).toEqual([]);
  });
  it('prunes only acknowledged known command receipts to avoid permanent capacity exhaustion', async () => {
    const f = await fixture(),
      journal = await BridgeJournal.open({
        directory: join(f.root, 'small-journal'),
        server: 'https://tenant.example',
        deviceId: fixtureId(11),
        limits: { entries: 2, bytes: 8_000_000 },
      });
    cleanup.push(() => journal.close());
    const command = (n: number) => ({
      id: fixtureId(n),
      deviceId: fixtureId(11),
      folderGrantId: fixtureId(12),
      status: 'claimed' as const,
      payload: {
        capability: 'local.file.inspect' as const,
        arguments: { path: 'report.pdf' },
      },
      leaseToken: fixtureId(n + 100),
      createdAt: new Date().toISOString(),
      timeoutAt: new Date(Date.now() + 60000).toISOString(),
    });
    for (const n of [101, 102, 103, 104]) {
      const c = command(n);
      expect(await journal.beginFileCommand(c)).toBe(true);
      await journal.completeFileCommand(c, {
        leaseToken: c.leaseToken,
        status: 'failed',
        summary: 'no file',
        errorCode: 'ENOENT',
      });
      await journal.acknowledgeFileCommand(c.id);
    }
    const uncertain = command(200);
    await journal.beginFileCommand(uncertain);
    await journal.completeFileCommand(uncertain, {
      leaseToken: uncertain.leaseToken,
      status: 'unknown',
      summary: 'uncertain',
    });
    await journal.acknowledgeFileCommand(uncertain.id);
    expect(await journal.diagnosticCounts()).toMatchObject({
      unknownOperations: 1,
    });
    expect(await journal.beginFileCommand(uncertain)).toBe(false);
  });
});
