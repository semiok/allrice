/** Release input gate and explicit host readonly-directory publisher.
 * No builder, registry, or Microsandbox calls.
 * Release locks are host-owned; the CLI cannot override them. An accepted
 * descriptor is not an OCI image or evidence of flat/runtime readiness. */
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { open, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DSH_IMAGE_LOCK = Object.freeze({
  manifestSha256:
    '44973b86f10555e9cf1ae07c4376fa97801fb15eec56fdc35549582a8b4cdd6f',
  manifestBytes: 16832328,
  archiveSha256:
    '306d3e314b50b7a369642de939fea21616f582bcbe7b74f2936a00c2240699b8',
  archiveBytes: 1074790400,
  cliSha256: '80112efe368efb1a39720c7ada0af00442e5131fb2744edaaff8a3e8bb499e6f',
  packageLockSha256:
    'fd310231321514b83ce2ed331d05e1fd0c3f8e957ae31dcf09db8679c5d2ec82',
});
const recipe = new URL(
  '../infra/docker/Dockerfile.dsh-native-vm',
  import.meta.url,
);
const cli = 'node_modules/@deepseek-ai/dsh/lib/bin.js';
const DSH_BIN_NAMES = Object.freeze([
  'anthropic-ai-sdk',
  'cordis',
  'crc32',
  'dsh',
  'dsoffice',
  'is-docker',
  'is-inside-container',
  'js-yaml',
  'node-which',
  'pi-ai',
  'playwright',
  'playwright-core',
  'semver',
  'which-command',
  'xlsx',
  'yaml',
]);
const publisher = fileURLToPath(
  new URL('./publish-dsh-native-directory.py', import.meta.url),
);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fail(code) {
  throw Object.assign(new Error(code), { code });
}
const digest = (value) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function assertStrictDshMembers(files, permittedLinks = new Map()) {
  if (!Array.isArray(files) || !files.length) fail('DSH_IMAGE_MEMBERS_INVALID');
  const entries = new Map();
  for (const entry of files) {
    const path = entry?.path;
    if (
      typeof path !== 'string' ||
      !path ||
      path.includes('\0') ||
      path.includes('\\') ||
      posix.isAbsolute(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      fail('DSH_IMAGE_MEMBER_PATH_INVALID');
    if (entries.has(path)) fail('DSH_IMAGE_MEMBER_DUPLICATE');
    if (entry.kind === 'symlink' && permittedLinks.get(path) !== entry.target)
      fail('DSH_IMAGE_SYMLINK_FORBIDDEN');
    if (!['file', 'directory', 'symlink'].includes(entry.kind))
      fail('DSH_IMAGE_MEMBER_TYPE_FORBIDDEN');
    if (
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o7777 ||
      (entry.mode & 0o6000) !== 0
    )
      fail('DSH_IMAGE_MEMBER_MODE_FORBIDDEN');
    if (
      entry.kind === 'file' &&
      (!Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        !digest(entry.sha256))
    )
      fail('DSH_IMAGE_MEMBER_FILE_INVALID');
    entries.set(path, entry);
  }
  for (const path of entries.keys()) {
    let parent = posix.dirname(path);
    while (parent !== '.') {
      if (entries.get(parent)?.kind !== 'directory')
        fail('DSH_IMAGE_MEMBER_PARENT_INVALID');
      parent = posix.dirname(parent);
    }
  }
  for (const entry of entries.values()) {
    if (entry.kind !== 'symlink') continue;
    const target = entry.target;
    if (
      typeof target !== 'string' ||
      !target ||
      target.includes('\0') ||
      target.includes('\\') ||
      posix.isAbsolute(target)
    )
      fail('DSH_IMAGE_SYMLINK_FORBIDDEN');
    const resolved = posix.normalize(
      posix.join(posix.dirname(entry.path), target),
    );
    if (
      resolved === '..' ||
      resolved.startsWith('../') ||
      entries.get(resolved)?.kind !== 'file'
    )
      fail('DSH_IMAGE_SYMLINK_FORBIDDEN');
  }
  return entries;
}

async function readLockedFile(path, bytes, expectedDigest, contents = false) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== bytes)
      fail('DSH_IMAGE_INPUT_SIZE_MISMATCH');
    const hash = createHash('sha256');
    let count = 0;
    const pieces = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > bytes) fail('DSH_IMAGE_INPUT_SIZE_MISMATCH');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (contents) pieces.push(Buffer.from(chunk));
    }
    const after = await handle.stat();
    if (
      count !== bytes ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      hash.digest('hex') !== expectedDigest
    )
      fail('DSH_IMAGE_INPUT_DIGEST_MISMATCH');
    return contents ? Buffer.concat(pieces) : undefined;
  } finally {
    await handle.close();
  }
}

/** A trusted release caller supplies locks; tests use small synthetic locks.
 * These are never accepted from CLI/env, guest claims, or the input manifest. */
async function qualifiedManifest(input, locks) {
  for (const key of [
    'manifestSha256',
    'archiveSha256',
    'cliSha256',
    'packageLockSha256',
  ])
    if (!digest(locks[key])) fail('DSH_IMAGE_RELEASE_LOCK_INVALID');
  for (const key of ['manifestBytes', 'archiveBytes'])
    if (!Number.isSafeInteger(locks[key]) || locks[key] <= 0)
      fail('DSH_IMAGE_RELEASE_LOCK_INVALID');
  const bytes = await readLockedFile(
    input.manifest,
    locks.manifestBytes,
    locks.manifestSha256,
    true,
  );
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('DSH_IMAGE_MANIFEST_INVALID');
  }
  if (
    manifest.platform !== 'linux-arm64-gnu' ||
    manifest.containsAuthFiles !== false ||
    manifest.archive?.sha256 !== locks.archiveSha256 ||
    manifest.archive?.bytes !== locks.archiveBytes
  )
    fail('DSH_IMAGE_MANIFEST_LOCK_MISMATCH');
  // The manifest bytes were authenticated above. Only its exact original bin
  // paths/target strings may authorize a link; never derive trust from tar data.
  const links = manifest.files?.filter((entry) => entry.kind === 'symlink');
  if (
    !Array.isArray(links) ||
    links.length !== DSH_BIN_NAMES.length ||
    DSH_BIN_NAMES.some(
      (name) =>
        !links.some((entry) => entry.path === `node_modules/.bin/${name}`),
    )
  )
    fail('DSH_IMAGE_SYMLINK_FORBIDDEN');
  const entries = assertStrictDshMembers(
    manifest.files,
    new Map(links.map((entry) => [entry.path, entry.target])),
  );
  const cliSha256 = locks.cliSha256;
  const lockSha256 = locks.packageLockSha256;
  if (
    entries.get(cli)?.sha256 !== cliSha256 ||
    entries.get('package-lock.json')?.sha256 !== lockSha256
  )
    fail('DSH_IMAGE_CODE_PIN_MISMATCH');
  return manifest;
}

export async function validateLocalDshImageInputs(
  input,
  locks = DSH_IMAGE_LOCK,
) {
  await qualifiedManifest(input, locks);
  await readLockedFile(input.archive, locks.archiveBytes, locks.archiveSha256);
  return Object.freeze({
    kind: 'allrice-dsh-local-image-input-v1',
    inputValidated: true,
    archiveSha256: locks.archiveSha256,
    archiveBytes: locks.archiveBytes,
    manifestSha256: locks.manifestSha256,
    recipeSha256: sha256(await readFile(recipe)),
    baseImage:
      'node@sha256:af0bb4bf5b7318e3269417a7684a9e116c3c22eaf05382578b0d0d33de597ad2',
    platform: 'linux/arm64',
    nodeVersion: '22.23.2',
    dshVersion: '0.2.1-rc.2',
    cliPath: `/opt/allrice/dsh/rc2-306d3e31/${cli}`,
    cliSha256: locks.cliSha256,
    lockSha256: locks.packageLockSha256,
    buildExecuted: false,
    imageDigest: null,
    flatPrepared: false,
    runtimeReady: false,
  });
}

/** Host-only release caller. Cooperative abort waits for the actual Python close;
 * an outer deadline/kill is not proof of rollback or publication outcome. */
export async function publishReadonlyDshDirectory(
  input,
  { locks = DSH_IMAGE_LOCK, signal, cleanupSignal } = {},
) {
  signal?.throwIfAborted();
  cleanupSignal?.throwIfAborted();
  if (
    typeof input.parent !== 'string' ||
    !isAbsolute(input.parent) ||
    resolve(input.parent) !== input.parent ||
    input.parent.includes(':') ||
    input.parent.includes('\0')
  )
    fail('DSH_IMAGE_HOST_PATH');
  await qualifiedManifest(input, locks); // Archive hash/copy happens once in Python.
  signal?.throwIfAborted();
  cleanupSignal?.throwIfAborted();
  const request = {
    ...input,
    locks,
    gateSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
  };
  return new Promise((fulfil, reject) => {
    const child = spawn('/usr/bin/python3', [publisher], {
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let failed = false,
      bytes = 0,
      errorBytes = 0;
    const pieces = [],
      errors = [];
    const abort = () => {
      child.kill('SIGTERM');
    };
    const kill = () => {
      failed = true;
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', abort, { once: true });
    cleanupSignal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024)
        kill(); // Only a compact publication receipt, never the tree seal.
      else pieces.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errorBytes += chunk.length;
      if (errorBytes <= 1024) errors.push(chunk);
    }); // Always consume; no raw stderr reaches the error/log.
    child.on('error', () => {
      failed = true;
    });
    child.stdin.on('error', () => {
      failed = true;
      abort();
    });
    child.on('close', (code, termination) => {
      signal?.removeEventListener('abort', abort);
      cleanupSignal?.removeEventListener('abort', kill);
      if (
        failed ||
        code !== 0 ||
        termination ||
        signal?.aborted ||
        cleanupSignal?.aborted
      ) {
        let detail;
        try {
          const value = JSON.parse(Buffer.concat(errors).toString('utf8'));
          if (
            errorBytes <= 1024 &&
            typeof value.reason === 'string' &&
            /^(DSH_IMAGE_[A-Z_]{1,64}|OS_ERROR|UNEXPECTED_ERROR)$/.test(
              value.reason,
            )
          )
            detail = {
              reason: value.reason,
              errno: Number.isInteger(value.errno) ? value.errno : null,
            };
        } catch {
          // Malformed diagnostics never change failure or join semantics.
        }
        reject(
          Object.assign(
            new Error('DSH_IMAGE_PUBLISH_FAILED', {
              cause: { childExitCode: code, termination, detail },
            }),
            {
              code: 'DSH_IMAGE_PUBLISH_FAILED',
            },
          ),
        );
        return;
      }
      try {
        fulfil(JSON.parse(Buffer.concat(pieces).toString('utf8')));
      } catch {
        reject(
          Object.assign(new Error('DSH_IMAGE_PUBLISH_FAILED'), {
            code: 'DSH_IMAGE_PUBLISH_FAILED',
          }),
        );
      }
    });
    child.stdin.end(JSON.stringify(request));
    if (signal?.aborted) abort();
    if (cleanupSignal?.aborted) kill();
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    const publish = args[0] === '--publish-readonly';
    if (publish) args.shift();
    const [archive, manifest, output, ...extra] = args;
    if (
      extra.length ||
      ![archive, manifest, output].every(
        (path) => typeof path === 'string' && isAbsolute(path),
      )
    )
      fail('DSH_IMAGE_USAGE');
    if (publish) {
      const controller = new globalThis.AbortController();
      const abort = () => controller.abort();
      process.on('SIGTERM', abort);
      process.on('SIGINT', abort);
      try {
        const result = await publishReadonlyDshDirectory(
          { archive, manifest, parent: output },
          { signal: controller.signal },
        );
        process.stdout.write(JSON.stringify(result) + '\n');
      } finally {
        process.removeListener('SIGTERM', abort);
        process.removeListener('SIGINT', abort);
      }
    } else {
      const descriptor = await validateLocalDshImageInputs({
        archive,
        manifest,
      });
      await writeFile(output, JSON.stringify(descriptor, null, 2) + '\n', {
        mode: 0o600,
        flag: 'wx',
      });
      process.stdout.write(
        JSON.stringify({ inputValidated: true, imageReady: false }) + '\n',
      );
    }
  } catch (error) {
    const code =
      typeof error?.code === 'string' && error.code.startsWith('DSH_IMAGE_')
        ? error.code
        : 'DSH_IMAGE_INPUT_FAILED';
    process.stderr.write(
      JSON.stringify({ code, inputValidated: false }) + '\n',
    );
    process.exitCode = 1;
  }
}
