import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  openSync,
  closeSync,
  readSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import {
  readRepositoryGitMaterial,
  ciDigest,
  ciMaterialDigest,
} from './repository-git-material.mjs';
const checks = [
  'validate',
  'developer-bootstrap',
  'tenant-workbench-browser',
  'compose-smoke',
];
const root = process.cwd(),
  git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 2_000_000,
    }).trim();
const option = (name) =>
  process.argv
    .find((a) => a.startsWith('--' + name + '='))
    ?.slice(name.length + 3);
const mode = process.argv[2],
  output = option('output');
if (!['capture', 'finish'].includes(mode) || !output)
  throw Error('CI_RECEIPT_ARGUMENTS');
function snapshot() {
  const sha = git('rev-parse', 'HEAD'),
    tree = git('rev-parse', 'HEAD^{tree}');
  if (git('status', '--porcelain', '--untracked-files=no'))
    throw Error('CI_TRACKED_SOURCE_CHANGED');
  const archive = readRepositoryGitMaterial(root, sha),
    files = archive.files;
  const workspace = Buffer.from(
    files.find((f) => f.path === 'pnpm-workspace.yaml').contentBase64,
    'base64',
  ).toString('utf8');
  if (!workspace.startsWith('packages:\n  - apps/*\n  - packages/*\n'))
    throw Error('CI_WORKSPACE_PLAN_CHANGED');
  const packages = files
    .filter((f) => /^(apps|packages)\/[^/]+\/package\.json$/.test(f.path))
    .map((f) => {
      const p = JSON.parse(
        Buffer.from(f.contentBase64, 'base64').toString('utf8'),
      );
      return p.scripts?.build
        ? {
            name: p.name,
            path: dirname(f.path),
            scriptChecksum: ciDigest(p.scripts.build),
          }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    checkoutSha: sha,
    checkoutTree: tree,
    materialDigest: ciMaterialDigest(files),
    rootLockChecksum: files.find((f) => f.path === 'pnpm-lock.yaml').checksum,
    dependencyConfigurationDigest: ciMaterialDigest(
      files.filter(
        (f) =>
          /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|\.pnpmfile\.cjs|\.npmrc)$/.test(
            f.path,
          ) || f.path.startsWith('patches/'),
      ),
    ),
    workflowBlob: git('rev-parse', sha + ':.github/workflows/ci.yml'),
    packages,
  };
}
function outputs(path) {
  const files = [],
    base = join(root, path, path === 'apps/web' ? '.next' : 'dist');
  let bytes = 0;
  function visit(dir) {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'cache' || name === 'node_modules' || name === 'standalone')
        continue;
      const file = join(dir, name),
        s = lstatSync(file);
      if (s.isSymbolicLink()) throw Error('CI_BUILD_SYMLINK');
      if (s.isDirectory()) visit(file);
      else if (s.isFile()) {
        if (files.length >= 50000 || (bytes += s.size) > 1_000_000_000)
          throw Error('CI_BUILD_LIMIT');
        const h = createHash('sha256'),
          fd = openSync(file, 'r'),
          buf = Buffer.alloc(65536);
        try {
          for (;;) {
            const count = readSync(fd, buf, 0, buf.length, null);
            if (!count) break;
            h.update(buf.subarray(0, count));
          }
        } finally {
          closeSync(fd);
        }
        files.push({
          path: file.slice(base.length + 1),
          sizeBytes: s.size,
          checksum: 'sha256:' + h.digest('hex'),
        });
      }
    }
  }
  visit(base);
  if (!files.length || bytes === 0) throw Error('CI_BUILD_OUTPUT_MISSING');
  return {
    outputDigest: ciDigest(JSON.stringify(files)),
    fileCount: files.length,
    sizeBytes: bytes,
  };
}
const current = snapshot();
let result = current;
if (mode === 'finish') {
  const capture = option('capture'),
    job = process.env.GITHUB_JOB;
  if (!capture || !checks.includes(job)) throw Error('CI_CAPTURE_REQUIRED');
  const original = JSON.parse(readFileSync(capture, 'utf8'));
  if (JSON.stringify(original) !== JSON.stringify(current))
    throw Error('CI_CAPTURE_CHANGED');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
    pr = event.pull_request;
  if (
    process.env.GITHUB_REPOSITORY !== 'semiok/allrice' ||
    Number(process.env.GITHUB_REPOSITORY_ID) !== 1323769790
  )
    throw Error('CI_WRONG_REPOSITORY');
  result = {
    version: 1,
    scope: 'allrice.repository-ci.v1',
    repositoryId: 1323769790,
    repository: 'semiok/allrice',
    workflowPath: '.github/workflows/ci.yml',
    workflowBlob: current.workflowBlob,
    workflowRunId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    job,
    event: process.env.GITHUB_EVENT_NAME,
    pullRequest: pr?.number ?? null,
    headSha: pr?.head?.sha ?? null,
    baseSha: pr?.base?.sha ?? null,
    checkoutSha: current.checkoutSha,
    checkoutTree: current.checkoutTree,
    materialDigest: current.materialDigest,
    rootLockChecksum: current.rootLockChecksum,
    dependencyConfigurationDigest: current.dependencyConfigurationDigest,
    nodeVersion: process.version,
    runnerOs: process.env.RUNNER_OS,
    runnerArch: process.env.RUNNER_ARCH,
    build:
      job === 'validate'
        ? {
            rootScript: JSON.parse(
              readFileSync(join(root, 'package.json'), 'utf8'),
            ).scripts.build,
            packages: current.packages.map((p) => ({
              ...p,
              ...outputs(p.path),
            })),
          }
        : null,
  };
}
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
