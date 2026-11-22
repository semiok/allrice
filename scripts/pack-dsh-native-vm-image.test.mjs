import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  assertStrictDshMembers,
  publishReadonlyDshDirectory,
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
// Independent fixed release fixture, not the implementation's allowlist.
const DSH_BIN_NAMES =
  'anthropic-ai-sdk cordis crc32 dsh dsoffice is-docker is-inside-container js-yaml node-which pi-ai playwright playwright-core semver which-command xlsx yaml'.split(
    ' ',
  );
const targets = [
  '../@anthropic-ai/sdk/bin/cli',
  '../@deepseek-ai/cordis/bin.js',
  '../crc-32/bin/crc32.njs',
  '../@deepseek-ai/dsh/lib/bin.js',
  '../@deepseek-ai/libreoffice-kit/lib/cli.js',
  '../is-docker/cli.js',
  '../is-inside-container/cli.js',
  '../js-yaml/bin/js-yaml.js',
  '../which/bin/node-which',
  '../@earendil-works/pi-ai/dist/cli.js',
  '../playwright/cli.js',
  '../playwright-core/cli.js',
  '../semver/bin/semver.js',
  '../which/which.js',
  '../xlsx/bin/xlsx.njs',
  '../yaml/bin.mjs',
];
async function removeFixture(path) {
  const s = await lstat(path);
  if (s.isDirectory()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path))
      await removeFixture(join(path, name));
  }
  await rm(path, { recursive: true, force: true });
}
function archive(entries, contents) {
  const blocks = [];
  for (const entry of entries) {
    const bytes =
        entry.kind === 'file'
          ? Buffer.from(contents.get(entry.path))
          : Buffer.alloc(0),
      header = Buffer.alloc(512);
    header.write(entry.path);
    header.write(entry.mode.toString(8).padStart(7, '0') + '\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header[156] = {
      file: 48,
      directory: 53,
      symlink: 50,
      hardlink: 49,
      character: 51,
      block: 52,
      fifo: 54,
    }[entry.kind];
    if (entry.target) header.write(entry.target, 157);
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
async function fixture(t, change = () => {}, changeTar = () => {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'dsh-image-input-')),
  );
  t.onTestFinished(() => removeFixture(root));
  const contents = new Map([
    [cli, 'synthetic CLI\n'],
    ['package-lock.json', '{}\n'],
  ]);
  const links = DSH_BIN_NAMES.map((name, i) => ({
    path: `node_modules/.bin/${name}`,
    kind: 'symlink',
    mode: 0o755,
    target: targets[i],
  }));
  for (const e of links)
    contents.set(
      posix.normalize(posix.join('node_modules/.bin', e.target)),
      'synthetic CLI\n',
    );
  const files = [...contents].map(([name, text]) => member(name, text));
  const dirs = new Set();
  for (const e of [...files, ...links]) {
    let parent = dirname(e.path);
    while (parent !== '.') {
      dirs.add(parent);
      parent = dirname(parent);
    }
  }
  files.unshift(
    ...[...dirs]
      .sort()
      .map((path) => ({ path, kind: 'directory', mode: 0o755 })),
  );
  files.push(...links);
  const tarFiles = globalThis.structuredClone(files);
  changeTar(tarFiles, contents);
  const bytes = archive(tarFiles, contents);
  const manifest = {
    platform: 'linux-arm64-gnu',
    containsAuthFiles: false,
    archive: { bytes: bytes.length, sha256: sha(bytes) },
    files,
  };
  change(manifest);
  const raw = JSON.stringify(manifest),
    input = {
      archive: join(root, 'public.tar'),
      manifest: join(root, 'manifest.json'),
    };
  await writeFile(input.archive, bytes);
  await writeFile(input.manifest, raw);
  return {
    input,
    root,
    manifest,
    locks: {
      manifestSha256: sha(raw),
      manifestBytes: Buffer.byteLength(raw),
      archiveSha256: sha(bytes),
      archiveBytes: bytes.length,
      cliSha256: files.find((e) => e.path === cli).sha256,
      packageLockSha256: files.find((e) => e.path === 'package-lock.json')
        .sha256,
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
test('all original16 relative links are admitted only after the exact manifest has been authenticated', async (t) => {
  const f = await fixture(t);
  const result = await validateLocalDshImageInputs(f.input, f.locks);
  assert.equal(result.inputValidated, true);
  assert.equal(f.manifest.files.filter((e) => e.kind === 'symlink').length, 16);
  for (const [index, name] of DSH_BIN_NAMES.entries())
    assert.equal(
      f.manifest.files.find((e) => e.path === `node_modules/.bin/${name}`)
        .target,
      targets[index],
    );
  const unapproved = await fixture(t, (m) =>
    m.files.push({
      path: 'node_modules/.bin/extra',
      kind: 'symlink',
      mode: 0o755,
      target: targets[0],
    }),
  );
  await rm(unapproved.input.archive);
  await assert.rejects(
    validateLocalDshImageInputs(unapproved.input, unapproved.locks),
    { code: 'DSH_IMAGE_SYMLINK_FORBIDDEN' },
  );
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

test('link rules reject absolute/escaping/dangling/link-to-link and absent or linked ancestors', () => {
  const dirs = [
    { path: 'node_modules', kind: 'directory', mode: 0o755 },
    { path: 'node_modules/.bin', kind: 'directory', mode: 0o755 },
  ];
  const file = member('node_modules/target'),
    link = {
      path: 'node_modules/.bin/dsh',
      kind: 'symlink',
      mode: 0o755,
      target: '../target',
    };
  for (const target of [
    '/abs',
    '../../../outside',
    '../missing',
    './dsh',
    '../target\0',
    '..\\target',
  ]) {
    const bad = { ...link, target };
    assert.throws(
      () =>
        assertStrictDshMembers(
          [...dirs, file, bad],
          new Map([[bad.path, target]]),
        ),
      { code: 'DSH_IMAGE_SYMLINK_FORBIDDEN' },
    );
  }
  assert.throws(() => assertStrictDshMembers([...dirs, file, link]), {
    code: 'DSH_IMAGE_SYMLINK_FORBIDDEN',
  });
  assert.throws(() => assertStrictDshMembers([member('absent/file')]), {
    code: 'DSH_IMAGE_MEMBER_PARENT_INVALID',
  });
  assert.throws(
    () =>
      assertStrictDshMembers(
        [...dirs, link, member(link.path + '/child')],
        new Map([[link.path, link.target]]),
      ),
    { code: 'DSH_IMAGE_MEMBER_PARENT_INVALID' },
  );
});

test('real Python safe publisher preserves exact16 links, seals full tree and reuses without replacement', async (t) => {
  const f = await fixture(t),
    parent = join(f.root, 'releases');
  const receipt = await publishReadonlyDshDirectory(
    { ...f.input, parent },
    { locks: f.locks },
  );
  const root = receipt.hostDirectory,
    descriptor = JSON.parse(await readFile(receipt.descriptorPath));
  assert.equal(descriptor.kind, 'allrice-dsh-readonly-directory-v1');
  assert.equal(
    descriptor.baseImage,
    'docker.io/library/node@sha256:af0bb4bf5b7318e3269417a7684a9e116c3c22eaf05382578b0d0d33de597ad2',
  );
  assert.equal((await lstat(root)).mode & 0o777, 0o555);
  assert.equal((await lstat(receipt.descriptorPath)).mode & 0o777, 0o600);
  for (const [i, name] of DSH_BIN_NAMES.entries()) {
    const path = join(root, 'node_modules/.bin', name);
    assert.equal((await lstat(path)).isSymbolicLink(), true);
    assert.equal(await readlink(path), targets[i]);
    assert.equal((await lstat(await realpath(path))).isFile(), true);
  }
  assert.equal(await readFile(join(root, cli), 'utf8'), 'synthetic CLI\n');
  const inode = (await lstat(root)).ino;
  assert.deepEqual(
    await publishReadonlyDshDirectory(
      { ...f.input, parent },
      { locks: f.locks },
    ),
    receipt,
  );
  assert.equal((await lstat(root)).ino, inode);
  await chmod(join(root, cli), 0o644);
  await writeFile(join(root, cli), 'corrupted');
  await assert.rejects(
    publishReadonlyDshDirectory({ ...f.input, parent }, { locks: f.locks }),
    { code: 'DSH_IMAGE_PUBLISH_FAILED' },
  );
  assert.equal(await readFile(join(root, cli), 'utf8'), 'corrupted'); // Never repair or overwrite.
});

test('actual tar type/mode/link drift and partial data failure roll back only the owned private stage', async (t) => {
  for (const mutate of [
    (entries) => {
      entries.find((e) => e.kind === 'symlink').target = '../different';
    },
    (entries) => {
      entries.find((e) => e.kind === 'file').mode = 0o4755;
    },
    (entries) => {
      entries.splice(
        entries.findIndex((e) => e.kind === 'file'),
        1,
      );
    },
    (entries) => {
      entries.push(member('extra'));
    },
    ...['hardlink', 'character', 'block', 'fifo'].map((kind) => (entries) => {
      entries.find((e) => e.kind === 'file').kind = kind;
    }),
  ]) {
    const f = await fixture(
      t,
      () => {},
      (entries, contents) => {
        mutate(entries);
        contents.set('extra', 'synthetic code\n');
      },
    );
    const parent = join(f.root, 'releases');
    await assert.rejects(
      publishReadonlyDshDirectory({ ...f.input, parent }, { locks: f.locks }),
      { code: 'DSH_IMAGE_PUBLISH_FAILED' },
    );
    assert.deepEqual(await readdir(parent), ['.publish.lock']);
  }
  const f = await fixture(t, (m) => {
    m.files.find((e) => e.path === cli).sha256 = 'a'.repeat(64);
  });
  const parent = join(f.root, 'releases');
  await assert.rejects(
    publishReadonlyDshDirectory(
      { ...f.input, parent },
      { locks: { ...f.locks, cliSha256: 'a'.repeat(64) } },
    ),
    { code: 'DSH_IMAGE_PUBLISH_FAILED' },
  );
  assert.deepEqual(await readdir(parent), ['.publish.lock']);
});

test('preexisting unsafe destination and concurrent publication lock are preserved and rejected', async (t) => {
  const f = await fixture(t),
    parent = join(f.root, 'releases');
  await mkdir(parent, { mode: 0o700 });
  const target = join(parent, f.locks.archiveSha256);
  await symlink(f.root, target);
  await assert.rejects(
    publishReadonlyDshDirectory({ ...f.input, parent }, { locks: f.locks }),
    { code: 'DSH_IMAGE_PUBLISH_FAILED' },
  );
  assert.equal(await readlink(target), f.root);
  await rm(target);
  const holder = spawn(
    '/usr/bin/python3',
    [
      '-c',
      'import fcntl,sys;f=open(sys.argv[1],"w");fcntl.flock(f,fcntl.LOCK_EX);print("ready",flush=True);sys.stdin.read()',
      join(parent, '.publish.lock'),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const joined = once(holder, 'close');
  holder.stderr.resume();
  try {
    await once(holder.stdout, 'data');
    await chmod(join(parent, '.publish.lock'), 0o600);
    await assert.rejects(
      publishReadonlyDshDirectory({ ...f.input, parent }, { locks: f.locks }),
      { code: 'DSH_IMAGE_PUBLISH_FAILED' },
    );
  } finally {
    holder.stdin.end();
    assert.deepEqual(await joined, [0, null]);
  }
});

test('cooperative cancellation reaches the actual publisher and joins its real child close', async (t) => {
  const f = await fixture(t),
    parent = join(f.root, 'releases');
  const child = spawn(
    '/usr/bin/python3',
    [
      '-c',
      `import importlib.util,json,signal,sys
spec=importlib.util.spec_from_file_location("publisher",sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
def cancelled(signum,frame):
    module.cancel(signum,frame)
    print("cancelled",flush=True)
signal.signal(signal.SIGTERM,cancelled)
print("ready",flush=True)
sys.stdin.buffer.read(1)
try:
    module.publish(json.loads(sys.argv[2]))
except RuntimeError as error:
    sys.exit(1 if str(error)=="DSH_IMAGE_CANCELLED" else 2)
except BaseException:
    sys.exit(2)
sys.exit(0)
`,
      fileURLToPath(
        new URL('./publish-dsh-native-directory.py', import.meta.url),
      ),
      JSON.stringify({
        ...f.input,
        parent,
        locks: f.locks,
        gateSha256: 'a'.repeat(64),
      }),
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' },
    },
  );
  const joined = once(child, 'close');
  const output = createInterface({ input: child.stdout });
  child.stderr.resume();
  const line = () =>
    Promise.race([
      once(output, 'line').then(([text]) => text),
      joined.then(() => {
        throw new Error('publisher exited before handshake');
      }),
    ]);
  try {
    assert.equal(await line(), 'ready');
    const acknowledged = line();
    assert.equal(child.kill('SIGTERM'), true);
    assert.equal(await acknowledged, 'cancelled');
    child.stdin.end('x');
    assert.deepEqual(await joined, [1, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await joined;
    output.close();
  }
  await assert.rejects(lstat(parent), { code: 'ENOENT' });
  const stopped = new globalThis.AbortController();
  stopped.abort();
  await assert.rejects(
    publishReadonlyDshDirectory(
      { ...f.input, parent },
      { locks: f.locks, signal: stopped.signal },
    ),
  );
});
