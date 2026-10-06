import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  compiledRepairProfileId,
  type CompiledDependencyDescriptor,
} from './platform-repair-compiled-contracts.ts';
import { dependencyMaterialDigest } from './platform-repair-dependencies.ts';
import { repositoryDigest } from './platform-repository-source.ts';

/** Transport fixtures only: these small archives are not package/build proof. */
export function compiledDependencyFixture() {
  const file = (path: string, text: string) => ({
    path,
    sizeBytes: Buffer.byteLength(text),
    checksum: repositoryDigest(text),
    contentBase64: Buffer.from(text).toString('base64'),
  });
  const packages = [
    ['@types/node', '22.20.1'],
    ['@types/ws', '8.18.1'],
    ['typescript', '5.9.3'],
    ['undici-types', '6.21.0'],
    ['ws', '8.21.3'],
    ['yaml', '2.9.0'],
    ['zod', '4.4.3'],
  ].map(([name, version], i) => {
    const text = 'synthetic-archive-' + i;
    return {
      name: name!,
      version: version!,
      integrity: 'sha512-' + createHash('sha512').update(text).digest('base64'),
      checksum: repositoryDigest(text),
      sizeBytes: Buffer.byteLength(text),
    };
  });
  const files = [
    file('manager.tgz', 'synthetic-manager'),
    ...packages.map((_, i) =>
      file(`archives/${i}.tgz`, 'synthetic-archive-' + i),
    ),
    file('workspace/package.json', '{}'),
    file('workspace/pnpm-lock.yaml', 'lockfileVersion: 9.0'),
    file(
      'workspace/pnpm-workspace.yaml',
      "packages: ['packages/contracts','packages/project-runtime']",
    ),
  ];
  const baseline = {
    rootLockChecksum: repositoryDigest('original lock'),
    dependencyConfigurationDigest: repositoryDigest('original configuration'),
  };
  const bundle = {
    version: 1,
    profileId: compiledRepairProfileId,
    ...baseline,
    files,
  };
  const bytes = gzipSync(Buffer.from(JSON.stringify(bundle)));
  const descriptor: CompiledDependencyDescriptor = {
    version: 1,
    profileId: compiledRepairProfileId,
    ...baseline,
    bundleChecksum: repositoryDigest(bytes),
    bundleBytes: bytes.length,
    materialDigest: dependencyMaterialDigest(files),
    planDigest: dependencyMaterialDigest(
      files.filter((f) => f.path.startsWith('workspace/')),
    ),
    nodeVersion: 'v22.23.2',
    timeoutMs: 300_000,
    memoryMiB: 768,
    compilerHeapMiB: 384,
    manager: {
      version: '10.33.3',
      checksum: files[0]!.checksum,
      sizeBytes: files[0]!.sizeBytes,
    },
    packages,
  };
  return { baseline, bytes, descriptor, bundle };
}
