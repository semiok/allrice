#!/usr/bin/env node
// Run with the candidate deployment environment BEFORE stopping the old Worker
// (deploy-dev precheck; rollback runs the target's own copy). The path and the
// arguments are fixed: installed release tools call this file by path.
//
// MET-221: contexts bind to the DSH generation and the journal contract, not to
// an artifact ID. This read-only wrapper remeasures the candidate primary,
// checks its launch, then runs checkNativeReleaseCandidate (generation,
// journal contract, storage roots, control history; tested in the Worker).
import { realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const values = process.argv.slice(2);
const option = (key) => {
  const matches = values.filter((v) => v.startsWith('--' + key + '='));
  if (matches.length !== 1) throw Error('NATIVE_RETENTION_ARGUMENT');
  return matches[0].slice(key.length + 3);
};
if (values.length !== 2) throw Error('NATIVE_RETENTION_ARGUMENT');
const root = await realpath(option('root'));
const sha = option('release-sha');
if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('NATIVE_RETENTION_SOURCE');
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (
  git('rev-parse', 'HEAD') !== sha ||
  git('status', '--porcelain=v1', '--untracked-files=normal')
)
  throw Error('NATIVE_RETENTION_SOURCE');
const moduleAt = (path) => import(pathToFileURL(root + path));
const { installDshNativeArtifact, checkedDshNativeLaunch } = await moduleAt(
  '/apps/worker/dist/harness/dsh-native-artifact.js',
);
const { configuredDshNativeLaunch } = await moduleAt(
  '/apps/worker/dist/harness/dsh/runtime-pool.js',
);
const { checkNativeReleaseCandidate } = await moduleAt(
  '/apps/worker/dist/harness/dsh-native-release-check.js',
);
const db = await moduleAt('/packages/database/dist/index.js');
try {
  const primary = await installDshNativeArtifact({
    root,
    expectedId: process.env.ALLRICE_DSH_NATIVE_ARTIFACT_ID ?? '',
    sourceSha: sha,
    sourceTree: git('rev-parse', 'HEAD^{tree}'),
  });
  checkedDshNativeLaunch(configuredDshNativeLaunch());
  const checked = await checkNativeReleaseCandidate(primary);
  console.log(
    JSON.stringify({
      verified: true,
      releaseSha: sha,
      primary,
      ...checked,
      releaseAdmission: 'disabled',
      databaseWritten: false,
    }),
  );
} finally {
  await db.closeDatabase();
}
