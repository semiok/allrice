import { gunzipSync } from 'node:zlib';
import {
  CompiledDependencyBundleSchema,
  CompiledDependencyDescriptorSchema,
  compiledRepairLimits,
  type CompiledDependencyDescriptor,
} from './platform-repair-compiled-contracts.ts';
import { repositoryDigest } from './platform-repository-source.ts';

export function dependencyMaterialDigest(
  files: { path: string; sizeBytes: number; checksum: string }[],
) {
  return repositoryDigest(
    JSON.stringify(
      files
        .map(({ path, sizeBytes, checksum }) => ({ path, sizeBytes, checksum }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ),
  );
}
export function readCompiledDependencies(
  bytes: Buffer,
  raw: CompiledDependencyDescriptor,
  baseline: { rootLockChecksum: string; dependencyConfigurationDigest: string },
) {
  const descriptor = CompiledDependencyDescriptorSchema.parse(raw);
  if (
    bytes.length !== descriptor.bundleBytes ||
    repositoryDigest(bytes) !== descriptor.bundleChecksum ||
    descriptor.rootLockChecksum !== baseline.rootLockChecksum ||
    descriptor.dependencyConfigurationDigest !==
      baseline.dependencyConfigurationDigest
  )
    throw Error('REPOSITORY_DEPENDENCIES_CHANGED');
  const bundle = CompiledDependencyBundleSchema.parse(
    JSON.parse(
      gunzipSync(bytes, {
        maxOutputLength: compiledRepairLimits.jsonBytes,
      }).toString('utf8'),
    ),
  );
  const paths = [
    'manager.tgz',
    ...descriptor.packages.map((_, i) => `archives/${i}.tgz`),
    'workspace/package.json',
    'workspace/pnpm-lock.yaml',
    'workspace/pnpm-workspace.yaml',
  ];
  if (
    bundle.rootLockChecksum !== baseline.rootLockChecksum ||
    bundle.dependencyConfigurationDigest !==
      baseline.dependencyConfigurationDigest ||
    dependencyMaterialDigest(bundle.files) !== descriptor.materialDigest ||
    new Set(bundle.files.map((f) => f.path)).size !== paths.length ||
    bundle.files.some((f) => !paths.includes(f.path))
  )
    throw Error('REPOSITORY_DEPENDENCIES_CHANGED');
  for (const f of bundle.files) {
    const b = Buffer.from(f.contentBase64, 'base64');
    if (
      b.toString('base64') !== f.contentBase64 ||
      b.length !== f.sizeBytes ||
      repositoryDigest(b) !== f.checksum
    )
      throw Error('REPOSITORY_DEPENDENCIES_CHANGED');
  }
  for (const [i, p] of [
    {
      checksum: descriptor.manager.checksum,
      sizeBytes: descriptor.manager.sizeBytes,
    },
    ...descriptor.packages,
  ].entries()) {
    const f = bundle.files.find(
      (f) => f.path === (i === 0 ? 'manager.tgz' : `archives/${i - 1}.tgz`),
    )!;
    if (f.checksum !== p.checksum || f.sizeBytes !== p.sizeBytes)
      throw Error('REPOSITORY_DEPENDENCIES_CHANGED');
  }
  if (
    dependencyMaterialDigest(
      bundle.files.filter((f) => f.path.startsWith('workspace/')),
    ) !== descriptor.planDigest
  )
    throw Error('REPOSITORY_DEPENDENCIES_CHANGED');
  return { bytes, descriptor, bundle };
}
