import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  nativeArtifactPath,
  verifyDshNativeArtifact,
} from './dsh-native-artifact.js';

/** Copy a previously approved measured closure without reinstalling packages or
 * inventing new provenance. This produces bytes, never deployment approval.
 * Failure leaves the exclusive destination marked incomplete for inspection. */
export async function copyDshNativeArtifact(input: {
  root: string;
  target: string;
  expectedId: string;
  sourceSha: string;
  sourceTree: string;
}) {
  if (
    !/^[a-f0-9]{40}$/.test(input.sourceSha) ||
    !/^[a-f0-9]{40}$/.test(input.sourceTree)
  )
    throw Error('DSH_NATIVE_ARTIFACT_COPY_SOURCE_REQUIRED');
  const original = await verifyDshNativeArtifact(input);
  // The preserved legacy v1 identity does not record the loader helper's
  // effective dynamic platform edge. Its approved full root must remain;
  // remeasurement alone cannot prove a portable legacy copy is runnable.
  if (original.content.generation !== 'dsh-0.2.1-rc.2-687f282')
    throw Error('DSH_NATIVE_ARTIFACT_COPY_LEGACY_ORIGINAL_ROOT_REQUIRED');
  const source = original.root;
  const target = resolve(input.target);
  if (
    !isAbsolute(input.target) ||
    input.target !== target ||
    target === source ||
    target.startsWith(source + sep) ||
    source.startsWith(target + sep) ||
    (await realpath(dirname(target))) !== dirname(target)
  )
    throw Error('DSH_NATIVE_ARTIFACT_COPY_TARGET');
  // mkdir is exclusive; never merge into or remove an existing directory.
  await mkdir(target, { mode: 0o700 });
  await writeFile(
    join(target, '.KEEP'),
    'Native artifact copy in progress; no production approval.\n',
    { mode: 0o600, flag: 'wx' },
  );
  const inside = (path: string) => {
    if (!path.startsWith(source + sep))
      throw Error('DSH_NATIVE_ARTIFACT_COPY_OUTSIDE_SOURCE');
    return relative(source, path);
  };
  const file = async (path: string) => {
    const to = join(target, inside(path));
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await copyFile(path, to, constants.COPYFILE_FICLONE);
  };
  for (const fact of original.content.files)
    await file(join(source, fact.path));
  if (original.content.schemaVersion === 2)
    // Parsed/projection-checked support remains necessary for remeasurement.
    // Its unrelated raw bytes do not become native execution authority.
    for (const path of [
      'apps/worker/dsh/distribution.json',
      'pnpm-workspace.yaml',
      'apps/worker/package.json',
    ])
      await file(join(source, path));
  for (const pkg of original.content.packages) {
    const from = join(source, pkg.path);
    const to = join(target, inside(from));
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    if (pkg.name === '@allrice/contracts') {
      await file(join(from, 'package.json'));
      if (original.content.schemaVersion === 2) {
        const runtime = original.content.contractsRuntime;
        if (
          !runtime ||
          runtime.packagePath !== pkg.path ||
          !runtime.files.length
        )
          throw Error('DSH_NATIVE_ARTIFACT_COPY_CONTRACTS_RUNTIME_MISSING');
        for (const member of runtime.files) {
          if (
            !member.path.startsWith('dist/') ||
            !member.path.endsWith('.js') ||
            resolve(from, member.path) !== join(from, member.path) ||
            !resolve(from, member.path).startsWith(from + sep)
          )
            throw Error('DSH_NATIVE_ARTIFACT_COPY_CONTRACTS_RUNTIME_PATH');
          await file(join(from, member.path));
        }
      } else
        await cp(join(from, 'dist'), join(to, 'dist'), {
          recursive: true,
          mode: constants.COPYFILE_FICLONE,
          force: false,
          errorOnExist: true,
        });
    } else
      await cp(from, to, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
        force: false,
        errorOnExist: true,
        filter: (path) =>
          path === from ||
          !relative(from, path).split(sep).includes('node_modules'),
      });
  }
  const links = new Map<string, string>();
  for (const edge of original.content.dependencyEdges) {
    if (edge.target === null) continue;
    let found: string | undefined;
    const from = join(source, edge.importer, 'package.json');
    for (const folder of createRequire(from).resolve.paths(edge.name) ?? []) {
      const path = join(folder, edge.name);
      try {
        await lstat(join(path, 'package.json'));
        if ((await realpath(path)) === join(source, edge.target)) {
          found = inside(path);
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (!found) throw Error('DSH_NATIVE_ARTIFACT_COPY_EDGE_MISSING');
    if (found === edge.target) continue;
    if (links.has(found)) {
      if (links.get(found) !== edge.target)
        throw Error('DSH_NATIVE_ARTIFACT_COPY_EDGE_CONFLICT');
      continue;
    }
    const to = join(target, found);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await symlink(relative(dirname(to), join(target, edge.target)), to);
    links.set(found, edge.target);
  }
  await mkdir(join(target, '.local'), { mode: 0o700 });
  // Preserve the served artifact's original manifest/source, not the next build.
  await writeFile(
    join(target, nativeArtifactPath),
    await readFile(join(source, nativeArtifactPath)),
    { mode: 0o600, flag: 'wx' },
  );
  await verifyDshNativeArtifact({ ...input, root: target });
  const result = {
    copied: true,
    source,
    target,
    artifactId: original.artifactId,
    sourceProvenance: original.source,
    packageInstances: original.content.packages.length,
    recreatedResolverLinks: links.size,
    reinstalled: false,
    storageCopied: false,
    deploymentApprovalGranted: false,
  };
  await writeFile(
    join(target, '.local/native-retention-copy.json'),
    JSON.stringify(result, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  await writeFile(
    join(target, '.KEEP'),
    'Verified measured closure; retain until independently approved references retire.\n',
    { mode: 0o600 },
  );
  return result;
}
