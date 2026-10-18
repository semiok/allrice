#!/usr/bin/env node
// Explicit operator utility. The copy is not permission to launch or to remove
// its original release/storage. Register reviewed ROOT/ID/SOURCE/STORAGE pairs.
import { copyDshNativeArtifact } from '../../apps/worker/dist/harness/dsh-native-artifact-copy.js';
const values = process.argv.slice(2);
const keys = ['root', 'target', 'expected-id', 'source-sha', 'source-tree'];
if (values.length !== keys.length) throw Error('NATIVE_COPY_ARGUMENT');
const option = (key) => {
  const matches = values.filter((v) => v.startsWith('--' + key + '='));
  if (matches.length !== 1) throw Error('NATIVE_COPY_ARGUMENT');
  return matches[0].slice(key.length + 3);
};
console.log(
  JSON.stringify(
    await copyDshNativeArtifact({
      root: option('root'),
      target: option('target'),
      expectedId: option('expected-id'),
      sourceSha: option('source-sha'),
      sourceTree: option('source-tree'),
    }),
  ),
);
