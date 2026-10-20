import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertVirginNativeNamespace,
  NativeOriginStorageError,
} from './native-origin-storage.js';

const roots: string[] = [];
const live = () => new AbortController().signal;
async function fixture() {
  // macOS tmpdir may contain /var or /tmp symlinks; the caller must supply its
  // actual canonical namespace, not rely on the checker resolving those aliases.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'allrice-origin-')));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('assertVirginNativeNamespace', () => {
  it('accepts missing descendants without creating any path', async () => {
    const root = await fixture();
    const namespace = join(root, 'absent-parent', 'absent-namespace');
    await expect(
      assertVirginNativeNamespace(namespace, live()),
    ).resolves.toBeUndefined();
    expect(await readdir(root)).toEqual([]);
    await expect(lstat(namespace)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts a completely empty existing namespace without changing it', async () => {
    const root = await fixture();
    const namespace = join(root, 'namespace');
    await mkdir(namespace);
    const before = await lstat(namespace, { bigint: true });
    await expect(
      assertVirginNativeNamespace(namespace, live()),
    ).resolves.toBeUndefined();
    const after = await lstat(namespace, { bigint: true });
    expect(await readdir(namespace)).toEqual([]);
    expect({
      ino: after.ino,
      mtime: after.mtimeNs,
      ctime: after.ctimeNs,
      mode: after.mode,
    }).toEqual({
      ino: before.ino,
      mtime: before.mtimeNs,
      ctime: before.ctimeNs,
      mode: before.mode,
    });
  });

  it.each(['other-generation.jsonl', '.journal', 'unknown-extension.data'])(
    'rejects any existing entry, including %s, without reading or modifying its body',
    async (name) => {
      const root = await fixture();
      const namespace = join(root, 'namespace');
      await mkdir(namespace);
      const file = join(namespace, name);
      await writeFile(file, 'private-body-must-stay-unchanged', {
        mode: 0o000,
      });
      try {
        await expect(
          assertVirginNativeNamespace(namespace, live()),
        ).rejects.toMatchObject({
          code: 'DSH_NATIVE_ORIGIN_STORAGE_NOT_VIRGIN',
          message: 'DSH_NATIVE_ORIGIN_STORAGE_NOT_VIRGIN',
        });
      } finally {
        await chmod(file, 0o600);
      }
      expect(await readFile(file, 'utf8')).toBe(
        'private-body-must-stay-unchanged',
      );
      expect(await readdir(namespace)).toEqual([name]);
    },
  );

  it('rejects even an empty subdirectory from another generation', async () => {
    const root = await fixture();
    const namespace = join(root, 'namespace');
    await mkdir(join(namespace, 'different-generation'), { recursive: true });
    await expect(
      assertVirginNativeNamespace(namespace, live()),
    ).rejects.toMatchObject({
      code: 'DSH_NATIVE_ORIGIN_STORAGE_NOT_VIRGIN',
    });
    expect(await readdir(namespace)).toEqual(['different-generation']);
  });

  it('rejects namespace symlinks rather than following an empty target', async () => {
    const root = await fixture();
    const target = join(root, 'target');
    const namespace = join(root, 'link');
    await mkdir(target);
    await symlink(target, namespace, 'dir');
    await expect(
      assertVirginNativeNamespace(namespace, live()),
    ).rejects.toMatchObject({
      code: 'DSH_NATIVE_ORIGIN_STORAGE_NOT_VIRGIN',
    });
    expect((await lstat(namespace)).isSymbolicLink()).toBe(true);
    expect(await readdir(target)).toEqual([]);
  });

  it.each([false, true])(
    'rejects a symlink ancestor even when its target is missing=%s',
    async (dangling) => {
      const root = await fixture();
      const target = join(root, 'target');
      if (!dangling) await mkdir(target);
      const alias = join(root, 'alias');
      await symlink(target, alias, 'dir');
      await expect(
        assertVirginNativeNamespace(join(alias, 'missing'), live()),
      ).rejects.toMatchObject({
        code: 'DSH_NATIVE_ORIGIN_STORAGE_NOT_VIRGIN',
      });
    },
  );

  it.each([false, true])(
    'rejects a file namespace/ancestor (descendant=%s)',
    async (descendant) => {
      const root = await fixture();
      const file = join(root, 'file');
      await writeFile(file, 'unchanged');
      await expect(
        assertVirginNativeNamespace(
          descendant ? join(file, 'child') : file,
          live(),
        ),
      ).rejects.toMatchObject({
        code: 'DSH_NATIVE_ORIGIN_STORAGE_NOT_VIRGIN',
      });
      expect(await readFile(file, 'utf8')).toBe('unchanged');
    },
  );

  it('requires a lexical canonical absolute namespace', async () => {
    const root = await fixture();
    const invalid = [
      '',
      relative(process.cwd(), root),
      root + sep + '.' + sep + 'namespace',
      root + sep + '..' + sep + 'namespace',
      root + sep + sep + 'namespace',
      root + sep,
      root + '\0private-path',
    ];
    for (const namespace of invalid) {
      await expect(
        assertVirginNativeNamespace(namespace, live()),
      ).rejects.toMatchObject({
        code: 'DSH_NATIVE_ORIGIN_STORAGE_INVALID_NAMESPACE',
      });
    }
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects an already aborted call without leaking its reason or creating paths', async () => {
    const root = await fixture();
    const abort = new AbortController();
    abort.abort(new Error(root + '/private-reason'));
    await expect(
      assertVirginNativeNamespace(join(root, 'missing'), abort.signal),
    ).rejects.toMatchObject({
      code: 'DSH_NATIVE_ORIGIN_STORAGE_ABORTED',
      message: 'DSH_NATIVE_ORIGIN_STORAGE_ABORTED',
    });
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects an abort while filesystem checks are pending', async () => {
    const root = await fixture();
    const abort = new AbortController();
    const checking = assertVirginNativeNamespace(
      join(root, 'missing'),
      abort.signal,
    );
    queueMicrotask(() => abort.abort('private-abort-reason'));
    await expect(checking).rejects.toMatchObject({
      code: 'DSH_NATIVE_ORIGIN_STORAGE_ABORTED',
    });
    expect(await readdir(root)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    'rejects permission errors and returns no filesystem path/cause',
    async () => {
      const root = await fixture();
      const namespace = join(root, 'unreadable');
      await mkdir(namespace);
      await chmod(namespace, 0o000);
      let caught: unknown;
      try {
        await assertVirginNativeNamespace(namespace, live()).catch(
          (error: unknown) => {
            caught = error;
          },
        );
      } finally {
        await chmod(namespace, 0o700);
      }
      expect(caught).toBeInstanceOf(NativeOriginStorageError);
      expect(caught).toMatchObject({
        code: 'DSH_NATIVE_ORIGIN_STORAGE_UNAVAILABLE',
      });
      expect(String(caught)).not.toContain(root);
      expect(caught).not.toHaveProperty('cause');
      expect(await readdir(namespace)).toEqual([]);
    },
  );
});
