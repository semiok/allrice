import { readRepositoryGitMaterial } from './repository-git-material.mjs';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  RepositoryBaselineSchema,
  repairProfileId,
  repositorySourceLimits,
} from '../../../packages/database/src/platform-repair-contracts.ts';
import {
  validateRepositoryArchive,
  repositoryMaterialDigest,
  repositoryDependencyDigest,
  repositoryDigest,
  loadRepositoryBaseline,
} from '../../../packages/database/src/platform-repository-source.ts';
import { prepareRepositoryCompiledDependencies } from './repository-compiled-dependencies.ts';

// Operator CLI, not a model or HTTP tool. It cannot change refs or the worktree.
const option = (name: string) =>
  process.argv
    .find((a) => a.startsWith('--' + name + '='))
    ?.slice(name.length + 3);
const directory = option('repository-dir'),
  output = option('output-dir');
if (!directory || !output)
  throw Error('Supply --repository-dir and --output-dir');
const root = realpathSync(resolve(directory));
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64_000_000,
  }).trim();
if (
  git('rev-parse', '--show-toplevel') !== root ||
  ![
    'https://github.com/semiok/allrice.git',
    'https://github.com/semiok/allrice',
    'git@github.com:semiok/allrice.git',
  ].includes(git('remote', 'get-url', 'origin')) ||
  git('status', '--porcelain')
    .split('\n')
    .some((line) => line && line !== '?? .KEEP')
)
  throw Error('REPOSITORY_ROOT_NOT_CLEAN_FIXED_ALLRICE');
const sha = git('rev-parse', 'HEAD'),
  tree = git('rev-parse', 'HEAD^{tree}');
if (
  sha !== git('rev-parse', 'origin/main') ||
  git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0] !== sha
)
  throw Error('REPOSITORY_BASE_NOT_LATEST_MAIN');
const archive = validateRepositoryArchive(readRepositoryGitMaterial(root, sha));
const files = archive.files;
const expanded = Buffer.from(JSON.stringify(archive));
if (expanded.length > repositorySourceLimits.jsonBytes)
  throw Error('REPOSITORY_SOURCE_LIMIT');
const bytes = gzipSync(expanded, { level: 9 }),
  sourceDigest = repositoryMaterialDigest(archive.files);
const compiledNodeVersion = option('compiled-node-version');
const dependencies = compiledNodeVersion
  ? await prepareRepositoryCompiledDependencies(archive, {
      cacheDirectory:
        option('dependency-cache') ??
        join(root, '.local/repository-dependency-cache'),
      nodeVersion: compiledNodeVersion,
      timeoutMs: Number(option('compiled-timeout-ms') ?? 300000),
    })
  : null;
const hash = repositoryDigest(
  sha +
    ':' +
    sourceDigest +
    (dependencies
      ? ':' + repositoryDigest(JSON.stringify(dependencies.descriptor))
      : ''),
).slice(7);
const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
const active = JSON.parse(
  readFileSync('/Users/a123/allrice-dev/.local/active-release.json', 'utf8'),
);
const baseline = RepositoryBaselineSchema.parse({
  version: 1,
  id,
  repositoryId: 'semiok/allrice',
  sourceSha: sha,
  gitTree: tree,
  sourceDigest,
  rootLockChecksum: archive.files.find((f) => f.path === 'pnpm-lock.yaml')
    ?.checksum,
  dependencyConfigurationDigest: repositoryDependencyDigest(archive.files),
  archiveChecksum: repositoryDigest(bytes),
  archiveBytes: bytes.length,
  fileCount: files.length,
  sourceBytes: files.reduce((n, f) => n + f.sizeBytes, 0),
  observedDevSha: active.releaseSha,
  registeredAt: new Date().toISOString(),
  materializer: 'git-tracked-json-gzip-v1',
  profileId: repairProfileId,
  dependencyMode: 'runtime_builtins_only',
  monorepoDependenciesInstalled: false,
  ...(dependencies ? { compiledDependencies: dependencies.descriptor } : {}),
});
const catalog = resolve(output);
mkdirSync(catalog, { recursive: true, mode: 0o700 });
if (realpathSync(catalog) !== catalog) throw Error('REPOSITORY_CATALOG_UNSAFE');
if (existsSync(join(catalog, id))) {
  const prior = loadRepositoryBaseline(catalog, id).baseline;
  if (
    prior.sourceSha !== sha ||
    prior.archiveChecksum !== baseline.archiveChecksum
  )
    throw Error('REPOSITORY_BASELINE_CONFLICT');
  console.log(JSON.stringify(prior));
} else {
  const temporary = join(catalog, id + '.publishing');
  mkdirSync(temporary, { mode: 0o700 });
  try {
    writeFileSync(join(temporary, 'source.json.gz'), bytes, {
      mode: 0o400,
      flag: 'wx',
    });
    writeFileSync(
      join(temporary, 'baseline.json'),
      JSON.stringify(baseline, null, 2) + '\n',
      { mode: 0o400, flag: 'wx' },
    );
    if (dependencies)
      writeFileSync(
        join(temporary, 'dependencies.json.gz'),
        dependencies.bytes,
        { mode: 0o400, flag: 'wx' },
      );
    // Publishing the directory is the only visibility switch, after every byte.
    renameSync(temporary, join(catalog, id));
    console.log(JSON.stringify(baseline));
  } catch (e) {
    rmSync(temporary, { recursive: true, force: true });
    throw e;
  }
}
