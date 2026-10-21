#!/usr/bin/env node
import { mkdir, writeFile, rename, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import process from 'node:process';
import { log } from 'node:console';
import {
  measureDshNativeArtifact,
  nativeArtifactPath,
} from '../dist/harness/dsh-native-artifact.js';
const values = process.argv.slice(2);
if (values.length !== 1 || !values[0].startsWith('--root='))
  throw Error('NATIVE_ARTIFACT_PREPARATION_ARGUMENT');
const root = await realpath(resolve(values[0].slice('--root='.length)));
const artifact = await measureDshNativeArtifact(root, undefined, {
  schemaVersion: 2,
});
await mkdir(join(root, '.local'), { recursive: true, mode: 0o700 });
const target = join(root, nativeArtifactPath),
  temp = target + '.tmp';
await writeFile(temp, JSON.stringify(artifact, null, 2) + '\n', {
  mode: 0o600,
  flag: 'wx',
});
await rename(temp, target);
log(
  JSON.stringify({
    artifactId: artifact.artifactId,
    nativeArtifactSchemaVersion: artifact.content.schemaVersion,
    packageCount: artifact.content.packages.length,
    approvalRequired: true,
    approvalGranted: false,
  }),
);
