import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServiceBuildIdentity } from '@allrice/database';

const digest = (bytes: string | Buffer) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const checksum = /^sha256:[a-f0-9]{64}$/;
const fail = (): never => {
  throw Error('DSH_CLOSE_WORKER_IDENTITY_INVALID');
};

/** Private bootstrap authority, distinct from a sealed Dev build identity.
 * An unsealed Worker measures its actual local execution directory once. This
 * proves the scope of this boot's close observations, never a release SHA/tree,
 * Dev admission, dependency installation or semantic shutdown success. Native
 * approval is supplied only after the existing native verifier has succeeded. */
export async function observeDshWorkerCloseIdentity(input: {
  workerId: string;
  workerBootId: string;
  entrypoint: string;
  nativeArtifactId: string;
  serviceBuildIdentity: ServiceBuildIdentity | null;
}) {
  const began = performance.now();
  if (!uuid.test(input.workerId) || !uuid.test(input.workerBootId)) fail();
  if (!checksum.test(input.nativeArtifactId)) fail();
  const sealed = input.serviceBuildIdentity;
  if (sealed) {
    if (
      sealed.service !== 'worker' ||
      sealed.environment !== 'dev' ||
      sealed.mode !== 'production' ||
      sealed.bootId !== input.workerBootId ||
      sealed.pid !== process.pid ||
      !checksum.test(sealed.manifestDigest)
    )
      fail();
    return Object.freeze({
      kind: 'sealed-dev-close-v1' as const,
      identity: Object.freeze({
        workerId: input.workerId,
        workerBootId: input.workerBootId,
        serviceManifestDigest: sealed.manifestDigest,
      }),
      measurement: Object.freeze({
        files: 0,
        bytes: 0,
        durationMs: performance.now() - began,
      }),
    });
  }

  // Worker start/dev both execute dist/index.js. Source runners may execute
  // src/index.ts; that is an observed source boot, never a sealed production one.
  const requested = fileURLToPath(input.entrypoint);
  const entrypoint = await realpath(requested);
  const directory = dirname(entrypoint);
  if (
    requested !== entrypoint ||
    !process.argv[1] ||
    (await realpath(process.argv[1])) !== entrypoint ||
    !['dist/index.js', 'src/index.ts'].includes(
      basename(directory) + '/' + basename(entrypoint),
    ) ||
    (await realpath(directory)) !== directory
  )
    fail();
  const rootStat = await lstat(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail();
  const files: { path: string; bytes: number; checksum: string }[] = [];
  let bytes = 0;
  async function walk(path: string): Promise<void> {
    const before = await lstat(path);
    if (before.isSymbolicLink()) fail();
    if (before.isDirectory()) {
      if (basename(path) === 'node_modules') fail();
      // Only this actual Worker execution directory; no repository or native
      // dependency scan and no second native verification.
      for (const name of (await readdir(path)).sort())
        await walk(join(path, name));
      return;
    }
    if (
      !before.isFile() ||
      before.size > 64 * 1024 ** 2 ||
      files.length >= 10000
    )
      fail();
    const content = await readFile(path);
    const after = await lstat(path);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      content.length !== before.size
    )
      fail();
    bytes += content.length;
    if (bytes > 256 * 1024 ** 2) fail();
    files.push({
      path: relative(directory, path),
      bytes: content.length,
      checksum: digest(content),
    });
  }
  await walk(directory);
  if (!files.some((file) => file.path === basename(entrypoint))) fail();
  const manifest = {
    version: 1,
    kind: 'observed-worker-close-v1',
    executionDirectory: directory,
    entrypoint: basename(entrypoint),
    nodeExecutable: await realpath(process.execPath),
    nodeVersion: process.version,
    nativeArtifactId: input.nativeArtifactId,
    files,
  };
  return Object.freeze({
    kind: 'observed-worker-close-v1' as const,
    identity: Object.freeze({
      workerId: input.workerId,
      workerBootId: input.workerBootId,
      serviceManifestDigest: digest(JSON.stringify(manifest)),
    }),
    scope: Object.freeze({
      executionDirectory: directory,
      entrypoint: basename(entrypoint),
      pid: process.pid,
      nodeVersion: process.version,
      nativeArtifactId: input.nativeArtifactId,
    }),
    measurement: Object.freeze({
      files: files.length,
      bytes,
      durationMs: performance.now() - began,
    }),
  });
}
