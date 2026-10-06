#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, rename, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { prepareServiceBuildManifest } from '../../packages/database/dist/service-build-identity.js';

const args = process.argv.slice(2);
const option = (key) => {
  const values = args.filter((s) => s.startsWith(key + '='));
  if (values.length !== 1) throw Error('DEV_BUILD_PREPARATION_ARGUMENT');
  return values[0].slice(key.length + 1);
};
if (args.length !== 2) throw Error('DEV_BUILD_PREPARATION_ARGUMENT');
const root = await realpath(resolve(option('--root'))),
  sourceSha = option('--release-sha');
if (!/^\/Users\/a123\/allrice-(dev-releases|worktrees)\/[^/]+$/.test(root))
  throw Error('DEV_BUILD_ROOT_NOT_ALLOWED');
const git = (...values) =>
  execFileSync('git', values, { cwd: root, encoding: 'utf8' }).trim();
if (
  git('rev-parse', 'HEAD') !== sourceSha ||
  git('status', '--porcelain=v1', '--untracked-files=normal')
)
  throw Error('DEV_BUILD_SOURCE_NOT_CLEAN');
const manifest = await prepareServiceBuildManifest({
  root,
  sourceSha,
  sourceTree: git('rev-parse', 'HEAD^{tree}'),
});
await mkdir(join(root, '.local'), { recursive: true, mode: 0o700 });
const target = join(root, '.local/dev-build-identity.json'),
  temp = target + '.tmp';
await writeFile(temp, JSON.stringify(manifest, null, 2) + '\n', {
  mode: 0o600,
  flag: 'wx',
});
await rename(temp, target);
console.log(
  JSON.stringify({
    sourceSha,
    sourceTree: manifest.sourceTree,
    manifestDigest: manifest.manifestDigest,
    fileCount: manifest.files.length,
    webBuildId: manifest.webBuildId,
    releaseAdmission: 'disabled',
  }),
);
