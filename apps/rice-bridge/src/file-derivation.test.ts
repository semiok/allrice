import { randomUUID, createHash } from 'node:crypto';
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  FileDerivationPayloadSchema,
  LocalFileObjectSchema,
  type LocalFileVersion,
} from '@allrice/contracts';
import { inspectLocalFile, LocalFileError } from './local-files.js';
import { executeFileDerivation } from './file-derivation.js';
import { createFileArchive, readFileArchive } from './file-archives.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const checksum = (b: Uint8Array) =>
  'sha256:' + createHash('sha256').update(b).digest('hex');
// Codec orchestration has an internal byte port. Native read/race checks are
// performed by the actual compiled FileGuardian suite on macOS separately.
async function fixtureSource(
  root: string,
  path: string,
  expected: LocalFileVersion,
  controls: { signal: AbortSignal; authorize: () => Promise<boolean> },
) {
  if (controls.signal.aborted || !(await controls.authorize()))
    throw new LocalFileError('FILE_CANCELED');
  const current = await inspectLocalFile(root, path);
  if (
    Object.entries(current).some(
      ([key, value]) => expected[key as keyof LocalFileVersion] !== value,
    )
  )
    throw new LocalFileError('FILE_CHANGED');
  return readFile(join(root, path));
}
async function fixture(bytes = Buffer.from([0, 255, 14, 0, 1, 34])) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-derived-')),
  );
  roots.push(root);
  const path = '中文 原始.bin';
  await writeFile(join(root, path), bytes);
  const expected = await inspectLocalFile(root, path),
    objectId = randomUUID();
  const captured: Uint8Array[] = [];
  const upload = vi.fn(async (metadata: unknown, output: Uint8Array) => {
    const object = LocalFileObjectSchema.parse({
      ...(metadata as object),
      objectId,
    });
    expect(object.checksum).toBe(checksum(output));
    expect(object.sizeBytes).toBe(output.length);
    captured.push(output);
    return object;
  });
  const payload = FileDerivationPayloadSchema.parse({
    capability: 'local.file.derive',
    arguments: {
      inputs: [{ path, expected }],
      request: { kind: 'zip_pack', fileName: '打包.zip' },
    },
    outputObjectId: objectId,
  });
  return {
    root,
    path,
    bytes,
    payload,
    captured,
    options: { authorize: async () => true, upload, readSource: fixtureSource },
  };
}
it('packs the selected physical bytes into a distinct verified object without changing sources', async () => {
  const f = await fixture(),
    result = await executeFileDerivation(f.root, f.payload, f.options);
  expect(result.status).toBe('derived');
  expect(result.object?.objectId).toBe(f.payload.outputObjectId);
  const entries = await readFileArchive(f.captured[0]!);
  expect(entries).toEqual([{ path: f.path, bytes: f.bytes }]);
  expect(await readFile(join(f.root, f.path))).toEqual(f.bytes);
});
it('lists actual ZIP bytes without uploading or creating host paths', async () => {
  const zip = await createFileArchive([
    { path: '目录/原始.bin', bytes: Buffer.from([1, 2, 0, 255]) },
  ]);
  const f = await fixture(Buffer.from(zip));
  const payload = FileDerivationPayloadSchema.parse({
    ...f.payload,
    arguments: { ...f.payload.arguments, request: { kind: 'zip_list' } },
    outputObjectId: null,
  });
  const result = await executeFileDerivation(f.root, payload, f.options);
  expect(result.status).toBe('listed');
  expect(result.entries[0]).toEqual({
    path: '目录/原始.bin',
    checksum: checksum(Buffer.from([1, 2, 0, 255])),
    sizeBytes: 4,
  });
  expect(f.options.upload).not.toHaveBeenCalled();
  expect(await readFile(join(f.root, f.path))).toEqual(zip);
});
it('extracts exactly one named entry as a private output, retaining the ZIP and other entries', async () => {
  const bytes = Buffer.from([0, 4, 255, 1]),
    zip = await createFileArchive([
      { path: '目录/a.bin', bytes },
      { path: 'b.bin', bytes: Buffer.from('other') },
    ]);
  const f = await fixture(Buffer.from(zip));
  const payload = FileDerivationPayloadSchema.parse({
    ...f.payload,
    arguments: {
      ...f.payload.arguments,
      request: {
        kind: 'zip_extract',
        entry: '目录/a.bin',
        fileName: '提取.bin',
      },
    },
  });
  const result = await executeFileDerivation(f.root, payload, f.options);
  expect(result.object?.fileName).toBe('提取.bin');
  expect(f.captured).toEqual([bytes]);
  expect(await readFile(join(f.root, f.path))).toEqual(zip);
  await expect(readFile(join(f.root, '提取.bin'))).rejects.toThrow();
});
it('rejects a stale source CAS before any attachment upload', async () => {
  const f = await fixture();
  await writeFile(join(f.root, f.path), Buffer.from('changed'));
  await expect(
    executeFileDerivation(f.root, f.payload, f.options),
  ).rejects.toMatchObject({ code: 'FILE_CHANGED' });
  expect(f.options.upload).not.toHaveBeenCalled();
});
it('rejects a source replaced by an outside symbolic link', async () => {
  const f = await fixture(),
    outside = join(f.root, 'outside');
  await writeFile(outside, f.bytes);
  await rm(join(f.root, f.path));
  await symlink(outside, join(f.root, f.path));
  await expect(
    executeFileDerivation(f.root, f.payload, f.options),
  ).rejects.toThrow();
  expect(f.options.upload).not.toHaveBeenCalled();
});
it('revoked authority and cancellation cannot publish an output', async () => {
  const f = await fixture();
  await expect(
    executeFileDerivation(f.root, f.payload, {
      ...f.options,
      authorize: async () => false,
    }),
  ).rejects.toMatchObject({ code: 'FILE_CANCELED' });
  const controller = new AbortController();
  controller.abort();
  await expect(
    executeFileDerivation(f.root, f.payload, {
      ...f.options,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(f.options.upload).not.toHaveBeenCalled();
});
it('an acknowledged object different from the reserved output is unknown, never a successful deliverable', async () => {
  const f = await fixture();
  await expect(
    executeFileDerivation(f.root, f.payload, {
      ...f.options,
      upload: async (metadata) =>
        LocalFileObjectSchema.parse({ ...metadata, objectId: randomUUID() }),
    }),
  ).rejects.toMatchObject({
    code: 'FILE_DERIVATION_RESULT_UNKNOWN',
    unknown: true,
  });
  expect(await readFile(join(f.root, f.path))).toEqual(f.bytes);
});
it('a wrong upload ACK checksum or byte count is unknown even for the reserved object', async () => {
  const f = await fixture();
  for (const altered of [
    { checksum: checksum(Buffer.from('different')) },
    { sizeBytes: 0 },
  ])
    await expect(
      executeFileDerivation(f.root, f.payload, {
        ...f.options,
        upload: async (metadata) =>
          LocalFileObjectSchema.parse({
            ...metadata,
            objectId: f.payload.outputObjectId,
            ...altered,
          }),
      }),
    ).rejects.toMatchObject({
      code: 'FILE_DERIVATION_RESULT_UNKNOWN',
      unknown: true,
    });
});
it('rejects an absent or malformed archive entry without publishing an approximation', async () => {
  const zip = await createFileArchive([
      { path: 'a.txt', bytes: Buffer.from('a') },
    ]),
    f = await fixture(Buffer.from(zip));
  const payload = FileDerivationPayloadSchema.parse({
    ...f.payload,
    arguments: {
      ...f.payload.arguments,
      request: { kind: 'zip_extract', entry: 'b.txt', fileName: 'b.txt' },
    },
  });
  await expect(
    executeFileDerivation(f.root, payload, f.options),
  ).rejects.toMatchObject({ code: 'FILE_ARCHIVE_ENTRY_NOT_FOUND' });
  expect(f.options.upload).not.toHaveBeenCalled();
});
it('new document processing retains the physical stop receipt and canonical output type', async () => {
  const f = await fixture(),
    bytes = Buffer.from('%PDF synthetic trusted-port output');
  const payload = FileDerivationPayloadSchema.parse({
    ...f.payload,
    arguments: {
      ...f.payload.arguments,
      request: { kind: 'pdf_rotate', degrees: 90, fileName: '旋转.pdf' },
    },
  });
  const processing = {
    stopped: true as const,
    reason: 'completed' as const,
    guardianPid: 12,
    readerPid: 13,
    observedPeakRssBytes: 1,
  };
  const output = await executeFileDerivation(f.root, payload, {
    ...f.options,
    transform: async () => ({ bytes, processing }),
  });
  expect(output.processing).toEqual(processing);
  expect(output.object?.mediaType).toBe('application/pdf');
  expect(f.captured).toEqual([bytes]);
});
it('a document without physical completion or beyond formal 8MB cannot upload', async () => {
  const f = await fixture();
  const payload = FileDerivationPayloadSchema.parse({
    ...f.payload,
    arguments: {
      ...f.payload.arguments,
      request: { kind: 'pdf_extract', pages: [1], fileName: '提取.pdf' },
    },
  });
  for (const result of [
    { bytes: Buffer.from('x'), processing: undefined },
    {
      bytes: Buffer.alloc(8_000_001),
      processing: {
        stopped: true,
        reason: 'completed',
        guardianPid: 12,
        readerPid: 13,
        observedPeakRssBytes: 1,
      },
    },
  ])
    await expect(
      executeFileDerivation(f.root, payload, {
        ...f.options,
        transform: async () => result as never,
      }),
    ).rejects.toThrow();
  expect(f.options.upload).not.toHaveBeenCalled();
});
it('extracted text keeps its canonical media type for subsequent reading', async () => {
  const zip = await createFileArchive([
    { path: '样本.txt', bytes: Buffer.from('原文') },
  ]);
  const f = await fixture(Buffer.from(zip));
  const payload = FileDerivationPayloadSchema.parse({
    ...f.payload,
    arguments: {
      ...f.payload.arguments,
      request: { kind: 'zip_extract', entry: '样本.txt', fileName: '输出.txt' },
    },
  });
  expect(
    (await executeFileDerivation(f.root, payload, f.options)).object?.mediaType,
  ).toBe('text/plain');
});
