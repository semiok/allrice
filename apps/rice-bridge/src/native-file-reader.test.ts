import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  stat,
  mkdir,
  rename,
  symlink,
  link,
  rm,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import * as guardian from './file-guardian.js';
import { readNativeFileBytes } from './native-file-reader.js';
import { inspectLocalFile } from './local-files.js';

vi.mock('node:child_process', { spy: true });
const execute = promisify(execFile);
const checksum = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const identity = {
  dev: 17,
  ino: 12345,
  size: 4,
  mtimeMs: 1700000000123.456,
  ctimeMs: 1700000000124.789,
};
const unitBytes = Buffer.from([0, 255, 34, 10]);
const selected = {
  checksum: checksum(unitBytes),
  sizeBytes: unitBytes.length,
  mediaType: 'application/octet-stream',
  version: checksum(
    Buffer.from(
      JSON.stringify([
        '原始.bin',
        identity.dev,
        identity.ino,
        identity.size,
        identity.mtimeMs,
        identity.ctimeMs,
        checksum(unitBytes),
      ]),
    ),
  ),
};
const response = () => ({
  checksum: selected.checksum,
  sizeBytes: selected.sizeBytes,
  identity: { ...identity },
  bytesBase64: unitBytes.toString('base64'),
});
afterEach(() => vi.restoreAllMocks());

describe('strict native read receipt validation', () => {
  it('forwards exact PR3 selection and returns bytes without base64 receipt', async () => {
    const invoke = vi
      .spyOn(guardian, 'invokeFileGuardian')
      .mockResolvedValue(response());
    const result = await readNativeFileBytes(
      '/owned',
      '原始.bin',
      selected,
      {},
      '/test/helper',
    );
    expect(Buffer.from(result).equals(unitBytes)).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      { mode: 'read', root: '/owned', path: '原始.bin', expected: selected },
      {},
      '/test/helper',
    );
  });
  it.each(['checksum', 'size', 'identity', 'time', 'base64', 'extra'] as const)(
    'rejects mismatched %s without returning bytes',
    async (kind) => {
      const result = response();
      if (kind === 'checksum') result.checksum = `sha256:${'f'.repeat(64)}`;
      if (kind === 'size') result.sizeBytes++;
      if (kind === 'identity') result.identity.ino++;
      if (kind === 'time') result.identity.ctimeMs++;
      if (kind === 'base64') result.bytesBase64 += '\n';
      if (kind === 'extra') Object.assign(result, { untrusted: true });
      vi.spyOn(guardian, 'invokeFileGuardian').mockResolvedValue(result);
      await expect(
        readNativeFileBytes('/owned', '原始.bin', selected, {}, '/test/helper'),
      ).rejects.toBeInstanceOf(guardian.FileGuardianError);
    },
  );
  it('rejects mediaType changes before any native call', async () => {
    const invoke = vi.spyOn(guardian, 'invokeFileGuardian');
    await expect(
      readNativeFileBytes(
        '/owned',
        '原始.bin',
        { ...selected, mediaType: 'image/png' },
        {},
        '/test/helper',
      ),
    ).rejects.toMatchObject({ code: 'FILE_CHANGED', unknown: false });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('rechecks revoked authority after receipt and never publishes returned bytes', async () => {
    vi.spyOn(guardian, 'invokeFileGuardian').mockResolvedValue(response());
    await expect(
      readNativeFileBytes(
        '/owned',
        '原始.bin',
        selected,
        { authorize: async () => false },
        '/test/helper',
      ),
    ).rejects.toMatchObject({ code: 'FILE_CANCELED', unknown: false });
  });
});

describe.skipIf(process.platform !== 'darwin')(
  'actual descriptor-relative Swift reads',
  () => {
    let suiteRoot: string, executable: string;
    const owned: string[] = [];
    beforeAll(async () => {
      suiteRoot = await realpath(
        await mkdtemp(join(tmpdir(), 'rice-native-read-')),
      );
      executable = join(suiteRoot, 'FileGuardian');
      await execute(
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
        { timeout: 30000, maxBuffer: 64000 },
      );
    }, 35000);
    afterEach(async () => {
      for (const root of owned.splice(0))
        await rm(root, { recursive: true, force: true });
    });
    afterAll(async () => {
      if (suiteRoot) await rm(suiteRoot, { recursive: true, force: true });
    });
    async function fixture(bytes = Buffer.from([0, 255, 10, 13, 34, 92, 1])) {
      const root = await mkdtemp(join(suiteRoot, 'files-'));
      owned.push(root);
      const path = '子目录/中文 原始.bin';
      await mkdir(join(root, '子目录'));
      await writeFile(join(root, path), bytes);
      return {
        root,
        path,
        bytes,
        expected: await inspectLocalFile(root, path),
      };
    }
    it('exactly matches Node sub-ms identities and original PR3 version formula', async () => {
      const f = await fixture();
      await utimes(join(f.root, f.path), 1700000000.123456, 1700000000.987654);
      const expected = await inspectLocalFile(f.root, f.path),
        native = (await guardian.invokeFileGuardian(
          { mode: 'read', root: f.root, path: f.path, expected },
          {},
          executable,
        )) as ReturnType<typeof response>;
      const original = await stat(join(f.root, f.path));
      expect(native.identity).toEqual({
        dev: original.dev,
        ino: original.ino,
        size: original.size,
        mtimeMs: original.mtimeMs,
        ctimeMs: original.ctimeMs,
      });
      expect(expected.version).toBe(
        checksum(
          Buffer.from(
            JSON.stringify([
              f.path,
              native.identity.dev,
              native.identity.ino,
              native.identity.size,
              native.identity.mtimeMs,
              native.identity.ctimeMs,
              native.checksum,
            ]),
          ),
        ),
      );
      const bytes = await readNativeFileBytes(
        f.root,
        f.path,
        expected,
        {},
        executable,
      );
      expect(Buffer.from(bytes).equals(f.bytes)).toBe(true);
    });
    it('returns all 9,000,000 physical binary bytes within read-only larger output budget', async () => {
      const bytes = Buffer.alloc(9_000_000);
      for (let offset = 0; offset < bytes.length; offset++)
        bytes[offset] = offset % 256;
      const f = await fixture(bytes);
      const result = await readNativeFileBytes(
        f.root,
        f.path,
        f.expected,
        {},
        executable,
      );
      expect(result.byteLength).toBe(9_000_000);
      expect(Buffer.from(result).equals(bytes)).toBe(true);
      expect((await readFile(join(f.root, f.path))).equals(bytes)).toBe(true);
    });
    it('rejects a replaced authorized absolute ancestor, even when outside bytes match', async () => {
      const parent = await mkdtemp(join(suiteRoot, 'ancestor-'));
      owned.push(parent);
      const root = join(parent, 'grant');
      await mkdir(root);
      const path = 'original.bin',
        bytes = Buffer.from('selected');
      await writeFile(join(root, path), bytes);
      const expected = await inspectLocalFile(root, path);
      await rename(parent, `${parent}-old`);
      owned.push(`${parent}-old`);
      const outside = await mkdtemp(join(suiteRoot, 'outside-'));
      owned.push(outside);
      await mkdir(join(outside, 'grant'));
      await writeFile(join(outside, 'grant', path), bytes);
      await symlink(outside, parent);
      await expect(
        readNativeFileBytes(root, path, expected, {}, executable),
      ).rejects.toMatchObject({ code: 'FILE_SYMLINK', unknown: false });
    });
    it.each(['parent', 'leaf', 'hardlink'] as const)(
      'rejects %s substitutions after ordinary inspection',
      async (kind) => {
        const f = await fixture();
        if (kind === 'parent') {
          await rename(join(f.root, '子目录'), join(f.root, 'original-parent'));
          await symlink(
            join(f.root, 'original-parent'),
            join(f.root, '子目录'),
          );
        } else if (kind === 'leaf') {
          await rename(join(f.root, f.path), join(f.root, 'original.bin'));
          await symlink(join(f.root, 'original.bin'), join(f.root, f.path));
        } else await link(join(f.root, f.path), join(f.root, 'other.bin'));
        await expect(
          readNativeFileBytes(f.root, f.path, f.expected, {}, executable),
        ).rejects.toMatchObject({
          code:
            kind === 'hardlink' ? 'FILE_HARD_LINK_UNSUPPORTED' : 'FILE_SYMLINK',
          unknown: false,
        });
      },
    );
    it('rejects changed content and same-content inode replacement using old version CAS', async () => {
      const f = await fixture();
      await writeFile(join(f.root, f.path), Buffer.alloc(f.bytes.length, 99));
      await expect(
        readNativeFileBytes(f.root, f.path, f.expected, {}, executable),
      ).rejects.toMatchObject({ code: 'FILE_CHANGED', unknown: false });
      await rm(join(f.root, f.path));
      await writeFile(join(f.root, f.path), f.bytes);
      await expect(
        readNativeFileBytes(f.root, f.path, f.expected, {}, executable),
      ).rejects.toMatchObject({ code: 'FILE_CHANGED', unknown: false });
    });
    it('physically stops a spawned native reader on cancellation and classifies it read-only', async () => {
      const f = await fixture(Buffer.alloc(9_000_000, 42)),
        controller = new AbortController();
      vi.mocked(spawn).mockClear();
      const promise = readNativeFileBytes(
        f.root,
        f.path,
        f.expected,
        { signal: controller.signal },
        executable,
      );
      const timer = setTimeout(() => controller.abort(), 5);
      try {
        await expect(promise).rejects.toMatchObject({
          code: 'FILE_CANCELED_OR_LIMIT',
          unknown: false,
        });
      } finally {
        clearTimeout(timer);
      }
      const child = vi.mocked(spawn).mock.results[0]?.value;
      expect(child?.pid).toBeGreaterThan(0);
      expect(child?.signalCode).toBe('SIGKILL');
      expect(() => process.kill(child!.pid!, 0)).toThrow();
    });
    it('aborting awaited admission starts no native subprocess', async () => {
      const f = await fixture(),
        controller = new AbortController();
      vi.mocked(spawn).mockClear();
      await expect(
        readNativeFileBytes(
          f.root,
          f.path,
          f.expected,
          {
            signal: controller.signal,
            authorize: async () => {
              controller.abort();
              return true;
            },
          },
          executable,
        ),
      ).rejects.toMatchObject({ code: 'FILE_CANCELED', unknown: false });
      expect(spawn).not.toHaveBeenCalled();
    });
    it('native stdio EOF revokes read before output and the actual process closes', async () => {
      const f = await fixture(Buffer.alloc(9_000_000, 42));
      const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      child.stdout.on('data', (bytes: Buffer) => chunks.push(bytes));
      child.stderr.resume();
      child.stdin.end(
        JSON.stringify({
          mode: 'read',
          root: f.root,
          path: f.path,
          expected: f.expected,
        }) + '\n',
      );
      const code = await new Promise<number | null>((resolve) =>
        child.once('close', resolve),
      );
      expect([65, 74]).toContain(code);
      const text = Buffer.concat(chunks).toString('utf8');
      expect(text).not.toContain('bytesBase64');
      expect(() => process.kill(child.pid!, 0)).toThrow();
    });
  },
);
