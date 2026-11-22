import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  assertStrictDshMembers,
  validateLocalDshImageInputs,
} from './pack-dsh-native-vm-image.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cli = 'node_modules/@deepseek-ai/dsh/lib/bin.js';
const script = fileURLToPath(
  new URL('./pack-dsh-native-vm-image.mjs', import.meta.url),
);
const member = (path, contents = 'synthetic code\n') => ({
  path,
  mode: 0o644,
  kind: 'file',
  bytes: Buffer.byteLength(contents),
  sha256: sha(contents),
});
function archive(files) {
  const blocks = [];
  for (const [name, contents] of files) {
    const bytes = Buffer.from(contents),
      header = Buffer.alloc(512);
    header.write(name);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write(
      [...header]
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
    );
    blocks.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
async function fixture(t, change = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-input-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const source = [
    [cli, 'synthetic CLI\n'],
    ['package-lock.json', '{}\n'],
  ];
  const bytes = archive(source);
  const manifest = {
    platform: 'linux-arm64-gnu',
    containsAuthFiles: false,
    archive: { bytes: bytes.length, sha256: sha(bytes) },
    files: source.map(([name, contents]) => member(name, contents)),
  };
  change(manifest);
  const raw = JSON.stringify(manifest);
  const input = {
    archive: join(root, 'public.tar'),
    manifest: join(root, 'manifest.json'),
  };
  await writeFile(input.archive, bytes);
  await writeFile(input.manifest, raw);
  return {
    input,
    root,
    locks: {
      manifestSha256: sha(raw),
      manifestBytes: Buffer.byteLength(raw),
      archiveSha256: sha(bytes),
      archiveBytes: bytes.length,
      cliSha256: sha(source[0][1]),
      packageLockSha256: sha(source[1][1]),
    },
  };
}

test('validates actual input bytes and recipe hash; descriptor is never image/flat ready', async (t) => {
  const { input, locks } = await fixture(t);
  const descriptor = await validateLocalDshImageInputs(input, locks);
  assert.equal(descriptor.inputValidated, true);
  assert.equal(descriptor.archiveSha256, locks.archiveSha256);
  assert.equal(
    descriptor.recipeSha256,
    sha(
      await readFile(
        new URL('../infra/docker/Dockerfile.dsh-native-vm', import.meta.url),
      ),
    ),
  );
  assert.equal(descriptor.imageDigest, null);
  assert.equal(descriptor.flatPrepared, false);
  assert.equal(descriptor.buildExecuted, false);
  assert.equal(descriptor.runtimeReady, false);
});
test('strict policy rejects even an internal .bin symlink before touching the archive', async (t) => {
  const { input, locks } = await fixture(t, (manifest) =>
    manifest.files.push({
      path: 'node_modules/.bin/dsh',
      kind: 'symlink',
      mode: 0o755,
      target: '../@deepseek-ai/dsh/lib/bin.js',
    }),
  );
  await rm(input.archive);
  await assert.rejects(validateLocalDshImageInputs(input, locks), {
    code: 'DSH_IMAGE_SYMLINK_FORBIDDEN',
  });
});
test('rejects changed manifest and same-size changed archive against trusted pins', async (t) => {
  const { input, locks } = await fixture(t);
  const raw = await readFile(input.manifest);
  await writeFile(input.manifest, Buffer.alloc(raw.length, 32));
  await assert.rejects(validateLocalDshImageInputs(input, locks), {
    code: 'DSH_IMAGE_INPUT_DIGEST_MISMATCH',
  });
  await writeFile(input.manifest, raw);
  await writeFile(input.archive, Buffer.alloc(locks.archiveBytes, 32));
  await assert.rejects(validateLocalDshImageInputs(input, locks), {
    code: 'DSH_IMAGE_INPUT_DIGEST_MISMATCH',
  });
});
test('rejects bad code pins, auth-bearing manifest, and final-component symlink', async (t) => {
  const { input, locks, root } = await fixture(t);
  await assert.rejects(
    validateLocalDshImageInputs(input, { ...locks, cliSha256: 'a'.repeat(64) }),
    { code: 'DSH_IMAGE_CODE_PIN_MISMATCH' },
  );
  const auth = await fixture(t, (manifest) => {
    manifest.containsAuthFiles = true;
  });
  await assert.rejects(validateLocalDshImageInputs(auth.input, auth.locks), {
    code: 'DSH_IMAGE_MANIFEST_LOCK_MISMATCH',
  });
  const link = join(root, 'manifest-link.json');
  await symlink(input.manifest, link);
  await assert.rejects(
    validateLocalDshImageInputs({ ...input, manifest: link }, locks),
    { code: 'ELOOP' },
  );
});
test('rejects escaping paths, special types, setuid/setgid, duplicate and file-parent paths', () => {
  for (const path of [
    '/abs',
    '../escape',
    'a/../escape',
    'a//b',
    'a\\b',
    'a\0b',
  ])
    assert.throws(() => assertStrictDshMembers([member(path)]), {
      code: 'DSH_IMAGE_MEMBER_PATH_INVALID',
    });
  for (const kind of ['hardlink', 'fifo', 'character', 'block', 'socket'])
    assert.throws(() => assertStrictDshMembers([{ ...member('file'), kind }]), {
      code: 'DSH_IMAGE_MEMBER_TYPE_FORBIDDEN',
    });
  for (const mode of [0o4755, 0o2755])
    assert.throws(() => assertStrictDshMembers([{ ...member('file'), mode }]), {
      code: 'DSH_IMAGE_MEMBER_MODE_FORBIDDEN',
    });
  assert.throws(
    () => assertStrictDshMembers([member('same'), member('same')]),
    { code: 'DSH_IMAGE_MEMBER_DUPLICATE' },
  );
  assert.throws(() => assertStrictDshMembers([member('a'), member('a/b')]), {
    code: 'DSH_IMAGE_MEMBER_PARENT_INVALID',
  });
  assert.equal(
    assertStrictDshMembers([
      { path: 'dir', kind: 'directory', mode: 0o755 },
      member('dir/file'),
    ]).size,
    2,
  );
});
test('real CLI cannot override release locks or write a descriptor for an unpinned manifest', async (t) => {
  const { input, root } = await fixture(t),
    output = join(root, 'descriptor.json');
  const child = spawnSync(
    process.execPath,
    [script, input.archive, input.manifest, output],
    { encoding: 'utf8' },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stderr).code, 'DSH_IMAGE_INPUT_SIZE_MISMATCH');
  assert.equal(child.stdout, '');
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});
