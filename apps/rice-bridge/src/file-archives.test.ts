import { randomBytes } from 'node:crypto';
import { setImmediate as yieldTask } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { Zip, ZipPassThrough, zipSync } from 'fflate';
import {
  createFileArchive,
  FileArchiveError,
  fileArchiveMaximumBytes,
  readFileArchive,
} from './file-archives.js';

// Independent Python stdlib zipfile fixture, with UTF-8 names and DEFLATE:
// 中文 目录/说明.txt = "中文 😀\n00123,-200.00\n", raw.bin = 00 ff 80 50 4b 03 04.
const pythonArchive = Buffer.from(
  'UEsDBBQAAAgIAAAAQ10tYmu7HQAAABoAAAAYAAAA5Lit5paHIOebruW9lS/or7TmmI4udHh0e7Jj7bNp7Qof5s9o4DIwMDQy1tE1MjDQMzDgAgBQSwMEFAAAAAgAAABDXXk+zFMJAAAABwAAAAcAAAByYXcuYmluY/jfEODNzAIAUEsBAhQDFAAACAgAAABDXS1ia7sdAAAAGgAAABgAAAAAAAAAAAAAAKSBAAAAAOS4reaWhyDnm67lvZUv6K+05piOLnR4dFBLAQIUAxQAAAAIAAAAQ115PsxTCQAAAAcAAAAHAAAAAAAAAAAAAACkgVMAAAByYXcuYmluUEsFBgAAAAACAAIAewAAAIEAAAAAAA==',
  'base64',
);
type FixtureFile = {
  path: string;
  bytes?: Uint8Array;
  attrs?: number;
  compression?: number;
};
/** Mature fflate writer intentionally permits malformed metadata for negative
 * fixtures; this helper never reads/parses ZIP structures or file paths. */
function storedArchive(files: FixtureFile[]) {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, bytes) => {
    if (error) throw error;
    chunks.push(bytes);
  });
  for (const file of files) {
    const entry = new ZipPassThrough(file.path);
    entry.os = 3;
    entry.attrs = file.attrs ?? (0o100644 << 16) >>> 0;
    entry.mtime = new Date(1980, 0, 1);
    if (file.compression !== undefined) entry.compression = file.compression;
    zip.add(entry);
    entry.push(file.bytes ?? new Uint8Array(), true);
  }
  zip.end();
  return Buffer.concat(chunks);
}
/** Fixed corruption of the first fixture's central-directory field, rather
 * than replacing yauzl with a mock or implementing another decoder. */
function corruptCentral(archive: Uint8Array, offset: number, value: number) {
  const bytes = Buffer.from(archive);
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  expect(central).toBeGreaterThan(0);
  bytes.writeUInt32LE(value >>> 0, central + offset);
  return bytes;
}
function rejectsArchive(promise: Promise<unknown>, code?: string) {
  return code
    ? expect(promise).rejects.toMatchObject({ code })
    : expect(promise).rejects.toBeInstanceOf(FileArchiveError);
}

describe('MET164 bounded byte-only ZIP codec', () => {
  it('reads independent stdlib DEFLATE bytes, Unicode names and exact binary content', async () => {
    const original = Buffer.from(pythonArchive);
    expect(await readFileArchive(pythonArchive)).toEqual([
      {
        path: '中文 目录/说明.txt',
        bytes: Buffer.from('中文 😀\n00123,-200.00\n'),
      },
      { path: 'raw.bin', bytes: Buffer.from([0, 255, 128, 80, 75, 3, 4]) },
    ]);
    expect(pythonArchive).toEqual(original);
  });

  it('creates deterministic valid ZIPs, including empty files and highly compressible input', async () => {
    const files = [
      { path: '中文 🧪/原始.bin', bytes: randomBytes(180_000) },
      { path: 'empty.txt', bytes: Buffer.alloc(0) },
      { path: '重复内容.txt', bytes: Buffer.alloc(150_000, 0x61) },
    ];
    const bytes = await createFileArchive(files);
    expect(bytes.length).toBeLessThanOrEqual(fileArchiveMaximumBytes);
    expect(await createFileArchive(files)).toEqual(bytes);
    expect(await readFileArchive(bytes)).toEqual(files);
  }, 15_000);

  it('preserves the original byte snapshot while authorization is pending', async () => {
    const input = Buffer.from(pythonArchive);
    const expected = await readFileArchive(input);
    expect(
      await readFileArchive(input, {
        authorize: async () => {
          input.fill(0);
          return true;
        },
      }),
    ).toEqual(expected);
    const source = Buffer.from('original bytes');
    const created = await createFileArchive(
      [{ path: 'snapshot', bytes: source }],
      {
        authorize: async () => {
          source.fill(0);
          return true;
        },
      },
    );
    expect(await readFileArchive(created)).toEqual([
      { path: 'snapshot', bytes: Buffer.from('original bytes') },
    ]);
  });

  it('accepts valid directory markers, but returns only ordinary files', async () => {
    expect(
      await readFileArchive(
        storedArchive([
          { path: '目录/', attrs: (0o40755 << 16) >>> 0 },
          { path: '目录/empty', bytes: Buffer.alloc(0) },
        ]),
      ),
    ).toEqual([{ path: '目录/empty', bytes: Buffer.alloc(0) }]);
    expect(await readFileArchive(await createFileArchive([]))).toEqual([]);
  });

  it.each([
    '/absolute',
    '../escape',
    'a/../escape',
    './escape',
    'C:escape',
    'C:/escape',
    'folder\\escape',
    'folder//escape',
    'bad\0name',
    'bad\nname',
    'bad\u0085name',
    'bad\u202ename',
  ])('rejects unsafe archive and creation path %j', async (path) => {
    await rejectsArchive(readFileArchive(storedArchive([{ path }])));
    await rejectsArchive(
      createFileArchive([{ path, bytes: Buffer.alloc(0) }]),
      'FILE_ARCHIVE_UNSAFE_PATH',
    );
  });

  it.each([
    ['same', 'same'],
    ['same', 'SAME'],
    ['é', 'e\u0301'],
    ['straße', 'STRASSE'],
    ['folder/a', 'FOLDER/b'],
    ['a', 'a/b'],
    ['a/b', 'a'],
  ])('rejects duplicate/case/ancestor collision %j and %j', async (a, b) => {
    await rejectsArchive(
      readFileArchive(storedArchive([{ path: a }, { path: b }])),
      'FILE_ARCHIVE_PATH_CONFLICT',
    );
    await rejectsArchive(
      createFileArchive(
        [a, b].map((path) => ({ path, bytes: Buffer.alloc(0) })),
      ),
      'FILE_ARCHIVE_PATH_CONFLICT',
    );
  });

  it.each([0o120777, 0o10644, 0o60644])(
    'rejects symlinks and other special Unix type %#o',
    async (mode) => {
      await rejectsArchive(
        readFileArchive(
          storedArchive([{ path: 'entry', attrs: (mode << 16) >>> 0 }]),
        ),
        'FILE_ARCHIVE_UNSUPPORTED',
      );
    },
  );

  it('rejects encryption and unsupported compression before reading entry data', async () => {
    const encrypted = storedArchive([
      // Traditional encrypted STORE metadata includes a 12-byte prefix.
      { path: 'safe.txt', bytes: Buffer.alloc(16) },
    ]);
    const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    encrypted.writeUInt16LE(
      encrypted.readUInt16LE(central + 8) | 1,
      central + 8,
    );
    encrypted.writeUInt32LE(4, central + 24);
    await rejectsArchive(
      readFileArchive(encrypted),
      'FILE_ARCHIVE_UNSUPPORTED',
    );
    await rejectsArchive(
      readFileArchive(storedArchive([{ path: 'entry', compression: 99 }])),
      'FILE_ARCHIVE_UNSUPPORTED',
    );
  });

  it('checks actual CRC, missing data, corrupt compressed streams and declared size lies', async () => {
    await rejectsArchive(
      readFileArchive(corruptCentral(pythonArchive, 16, 1)),
      'FILE_ARCHIVE_CRC_MISMATCH',
    );
    await rejectsArchive(
      readFileArchive(pythonArchive.subarray(0, pythonArchive.length - 8)),
    );
    const central = pythonArchive.indexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
    );
    // Keep the central directory/EOCD intact but omit the final DEFLATE byte
    // from the actual stream. A complete output size alone must not pass.
    await rejectsArchive(
      readFileArchive(
        corruptCentral(
          pythonArchive,
          20,
          pythonArchive.readUInt32LE(central + 20) - 1,
        ),
      ),
    );
    const compressed = Buffer.from(pythonArchive);
    // Corrupt actual DEFLATE data, not a model-returned status or checksum.
    const dataOffset = 30 + compressed.readUInt16LE(26);
    compressed[dataOffset] = compressed[dataOffset]! ^ 0xff;
    await rejectsArchive(readFileArchive(compressed));
    await rejectsArchive(readFileArchive(corruptCentral(pythonArchive, 24, 1)));
    await rejectsArchive(
      readFileArchive(corruptCentral(pythonArchive, 24, 31)),
    );
  });

  it('rejects local-header encryption and method/name disagreement with safe central metadata', async () => {
    const encrypted = storedArchive([{ path: 'safe.txt' }]);
    encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 1, 6);
    await rejectsArchive(
      readFileArchive(encrypted),
      'FILE_ARCHIVE_UNSUPPORTED',
    );
    const unsupported = storedArchive([{ path: 'safe.txt' }]);
    unsupported.writeUInt16LE(99, 8);
    await rejectsArchive(
      readFileArchive(unsupported),
      'FILE_ARCHIVE_UNSUPPORTED',
    );
    const disagreement = storedArchive([{ path: 'safe.txt' }]);
    disagreement[30] = 0x2e;
    await rejectsArchive(readFileArchive(disagreement), 'FILE_ARCHIVE_INVALID');
  });

  it('enforces 32 ordinary files and bounded metadata entries', async () => {
    const files = Array.from({ length: 32 }, (_, i) => ({
      path: `file-${i}`,
      bytes: Buffer.alloc(0),
    }));
    expect(await readFileArchive(await createFileArchive(files))).toHaveLength(
      32,
    );
    const excess = [...files, { path: 'excess', bytes: Buffer.alloc(0) }];
    await rejectsArchive(createFileArchive(excess), 'FILE_ARCHIVE_LIMIT');
    await rejectsArchive(
      readFileArchive(storedArchive(excess)),
      'FILE_ARCHIVE_LIMIT',
    );
    await rejectsArchive(
      readFileArchive(
        storedArchive(
          Array.from({ length: 129 }, (_, i) => ({
            path: `d-${i}/`,
            attrs: (0o40755 << 16) >>> 0,
          })),
        ),
      ),
      'FILE_ARCHIVE_LIMIT',
    );
  });

  it('bounds source input, actual archive output, file size and aggregate expanded bytes', async () => {
    await rejectsArchive(
      readFileArchive(Buffer.alloc(fileArchiveMaximumBytes + 1)),
      'FILE_ARCHIVE_LIMIT',
    );
    await rejectsArchive(
      createFileArchive([
        { path: 'large', bytes: Buffer.alloc(fileArchiveMaximumBytes + 1) },
      ]),
      'FILE_ARCHIVE_LIMIT',
    );
    await rejectsArchive(
      createFileArchive([
        { path: 'a', bytes: Buffer.alloc(4_500_001) },
        { path: 'b', bytes: Buffer.alloc(4_500_000) },
      ]),
      'FILE_ARCHIVE_LIMIT',
    );
    // A <=9MB input can still exceed the encoded output bound due to ZIP overhead.
    await rejectsArchive(
      createFileArchive([
        { path: 'random', bytes: randomBytes(fileArchiveMaximumBytes) },
      ]),
      'FILE_ARCHIVE_LIMIT',
    );
    // Each file is within its bound and ratio, but their real total is over 9MB.
    const pattern = randomBytes(1000);
    const repeated = (size: number) => {
      const bytes = Buffer.alloc(size);
      for (let i = 0; i < size; i += pattern.length) pattern.copy(bytes, i);
      return bytes;
    };
    const aggregate = zipSync({
      a: repeated(4_500_001),
      b: repeated(4_500_000),
    });
    expect(aggregate.length).toBeLessThan(fileArchiveMaximumBytes);
    await rejectsArchive(readFileArchive(aggregate), 'FILE_ARCHIVE_LIMIT');
    await rejectsArchive(
      readFileArchive(
        zipSync({ large: repeated(fileArchiveMaximumBytes + 1) }),
      ),
      'FILE_ARCHIVE_LIMIT',
    );
  });

  it('rejects a real high-ratio ZIP rather than trusting its compressed byte size', async () => {
    const bomb = zipSync({ repeated: Buffer.alloc(300_000) });
    expect(bomb.length * 100).toBeLessThan(300_000);
    await rejectsArchive(readFileArchive(bomb), 'FILE_ARCHIVE_LIMIT');
  });

  it('accepts the exact archive input limit and extracts CRC-correct original bytes', async () => {
    // fflate stream headers/descriptor/central+EOCD add a fixed 116 bytes for "a".
    const overhead = storedArchive([{ path: 'a' }]).length;
    const bytes = randomBytes(fileArchiveMaximumBytes - overhead);
    const archive = storedArchive([{ path: 'a', bytes }]);
    expect(archive.length).toBe(fileArchiveMaximumBytes);
    const result = await readFileArchive(archive);
    expect(result.map((file) => file.path)).toEqual(['a']);
    expect(Buffer.from(result[0]!.bytes).equals(bytes)).toBe(true);
  });

  it.each(['create', 'read'] as const)(
    'honors %s cancellation while an authorization response never settles',
    async (operation) => {
      const controller = new AbortController();
      const authorize = vi.fn(() => new Promise<boolean>(() => {}));
      const controls = { signal: controller.signal, authorize };
      const result =
        operation === 'create'
          ? createFileArchive(
              [{ path: 'a', bytes: Buffer.alloc(100) }],
              controls,
            )
          : readFileArchive(pythonArchive, controls);
      const rejection = rejectsArchive(result, 'FILE_ARCHIVE_CANCELED');
      await yieldTask();
      controller.abort();
      await rejection;
      expect(authorize).toHaveBeenCalledOnce();
    },
  );

  it.each(['create', 'read'] as const)(
    'checks %s authority repeatedly during real byte processing',
    async (operation) => {
      let calls = 0;
      const controls = { authorize: async () => ++calls < 6 };
      const bytes = randomBytes(500_000);
      const result =
        operation === 'create'
          ? createFileArchive([{ path: 'a', bytes }], controls)
          : readFileArchive(storedArchive([{ path: 'a', bytes }]), controls);
      await rejectsArchive(result, 'FILE_ARCHIVE_AUTHORITY_LOST');
      expect(calls).toBe(6);
    },
  );

  it.each(['create', 'read'] as const)(
    'checks %s cancellation after processing has actually begun',
    async (operation) => {
      let calls = 0;
      const controller = new AbortController();
      const controls = {
        signal: controller.signal,
        authorize: async () => {
          if (++calls === 6) setImmediate(() => controller.abort());
          return true;
        },
      };
      const bytes = randomBytes(600_000);
      await rejectsArchive(
        operation === 'create'
          ? createFileArchive([{ path: 'a', bytes }], controls)
          : readFileArchive(storedArchive([{ path: 'a', bytes }]), controls),
        'FILE_ARCHIVE_CANCELED',
      );
      expect(calls).toBeGreaterThanOrEqual(6);
    },
  );
});
