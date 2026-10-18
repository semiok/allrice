import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { assertStoredNativeSession } from './dsh-native-storage.js';
import type { NativeSessionDescriptor } from '@allrice/database';
import manifest from './fixtures/dsh-legacy-v0/manifest.json' with { type: 'json' };

let root: string;
const entry = resolve(
  import.meta.dirname,
  '../../dsh/allrice-jsonrpc-runtime.mjs',
);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allrice-stored-native-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const descriptor = (id: string) =>
  ({
    nativeSessionId: id,
    storageNamespace: join(root, 'sessions'),
  }) as NativeSessionDescriptor;
it('refuses an absent target even when its parent exists without materializing any file', async () => {
  await mkdir(join(root, 'sessions'));
  await expect(
    assertStoredNativeSession(
      entry,
      descriptor('dsh-' + randomUUID()),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'DSH_NATIVE_SESSION_STORAGE_UNAVAILABLE' });
  expect(await readdir(root, { recursive: true })).toEqual(['sessions']);
});
it('does not create a missing namespace while checking a known historical identity', async () => {
  await expect(
    assertStoredNativeSession(
      entry,
      descriptor('dsh-' + randomUUID()),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'DSH_NATIVE_SESSION_STORAGE_UNAVAILABLE' });
  expect(await readdir(root)).toEqual([]);
});
it.each(manifest.files)(
  'reads the native header of $file without rewriting or migrating history',
  async (fact) => {
    const text = await readFile(
      resolve(import.meta.dirname, 'fixtures/dsh-legacy-v0', fact.file),
    );
    const dir = join(
      root,
      'sessions',
      '--allrice-legacy-fixture--',
      fact.sessionId,
    );
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'session.jsonl'), text);
    await assertStoredNativeSession(
      entry,
      descriptor(fact.sessionId),
      new AbortController().signal,
    );
    expect(await readdir(dir)).toEqual(['session.jsonl']);
    expect(await readFile(join(dir, 'session.jsonl'))).toEqual(text);
    await expect(
      assertStoredNativeSession(
        entry,
        descriptor('dsh-absent-target'),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'DSH_NATIVE_SESSION_STORAGE_UNAVAILABLE' });
  },
);
