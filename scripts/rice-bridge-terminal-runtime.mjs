/** Fixed native human-terminal resources shared by App and CLI. Copies the
 * installed lockfile closure; it never downloads, compiles or installs npm. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyTerminalRuntime } from './rice-bridge-terminal-loader.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const entryPackages = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-api-terminal-controller',
  '@deepseek-ai/dsh-subprocess-local',
];

async function packageRoot(require, name) {
  try {
    return await realpath(dirname(require.resolve(`${name}/package.json`)));
  } catch {
    let directory = dirname(require.resolve(name));
    for (;;) {
      const metadata = await readFile(join(directory, 'package.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      if (metadata?.name === name) return await realpath(directory);
      if (directory === dirname(directory))
        throw Error('HUMAN_TERMINAL_PACKAGE_UNRESOLVED');
      directory = dirname(directory);
    }
  }
}

export async function prepareTerminalRuntime(
  output,
  projectRoot = process.cwd(),
  architecture = process.env.ALLRICE_BRIDGE_APP_ARCH ?? process.arch,
) {
  if (!['x64', 'arm64'].includes(architecture))
    throw Error('HUMAN_TERMINAL_ARCHITECTURE_UNSUPPORTED');
  const require = createRequire(
    join(resolve(projectRoot), 'apps/rice-bridge/package.json'),
  );
  const sources = new Map();
  const queue = entryPackages.map((name) => ({ name, require }));
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const item = queue[cursor];
    const root = await packageRoot(item.require, item.name);
    const metadata = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    );
    if (metadata.name !== item.name)
      throw Error('HUMAN_TERMINAL_PACKAGE_MISMATCH');
    const prior = sources.get(metadata.name);
    if (prior) {
      if (prior.version !== metadata.version)
        throw Error('HUMAN_TERMINAL_PACKAGE_CONFLICT');
      continue;
    }
    if (
      metadata.name.startsWith('@deepseek-ai/dsh-') &&
      metadata.version !== '0.2.1-rc.2'
    )
      throw Error('HUMAN_TERMINAL_DSH_VERSION_NOT_LOCKED');
    sources.set(metadata.name, {
      name: metadata.name,
      version: metadata.version,
      root,
    });
    const dependencies = {
      ...metadata.dependencies,
      ...Object.fromEntries(
        Object.entries(metadata.peerDependencies ?? {}).filter(
          ([name]) => !metadata.peerDependenciesMeta?.[name]?.optional,
        ),
      ),
    };
    const sourceRequire = createRequire(join(root, 'package.json'));
    for (const name of Object.keys(dependencies))
      queue.push({ name, require: sourceRequire });
  }
  const koffi = sources.get('koffi');
  const nativeName = `@koromix/koffi-darwin-${architecture}`;
  const nativeRoot = process.env.ALLRICE_BRIDGE_TERMINAL_NATIVE_PACKAGE_DIR
    ? await realpath(
        resolve(process.env.ALLRICE_BRIDGE_TERMINAL_NATIVE_PACKAGE_DIR),
      )
    : await packageRoot(
        createRequire(join(koffi.root, 'package.json')),
        nativeName,
      );
  const nativeMetadata = JSON.parse(
    await readFile(join(nativeRoot, 'package.json'), 'utf8'),
  );
  if (nativeMetadata.name !== nativeName || nativeMetadata.version !== '3.1.1')
    throw Error('HUMAN_TERMINAL_NATIVE_VERSION_NOT_LOCKED');
  sources.set(nativeName, {
    name: nativeName,
    version: nativeMetadata.version,
    root: nativeRoot,
  });
  const runtime = resolve(output) + '.terminal-runtime';
  await mkdir(runtime, { mode: 0o755 });
  const files = [];
  let totalBytes = 0;
  async function copy(input, path) {
    const stat = await lstat(input);
    if (stat.isSymbolicLink()) throw Error('HUMAN_TERMINAL_RESOURCE_SYMLINK');
    if (stat.isDirectory()) {
      for (const name of (await readdir(input)).sort()) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        await copy(join(input, name), `${path}/${name}`);
      }
    } else {
      if (
        !stat.isFile() ||
        stat.size > 32 * 1024 * 1024 ||
        files.length >= 10_000 ||
        totalBytes + stat.size > 96 * 1024 * 1024
      )
        throw Error('HUMAN_TERMINAL_RESOURCE_INVALID');
      const target = join(runtime, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await copyFile(input, target);
      const executable = path.endsWith('/spawn-helper');
      await chmod(target, executable ? 0o755 : 0o644);
      if (
        (path.endsWith('.node') || executable) &&
        process.env.ALLRICE_BRIDGE_SIGNING_MODE === 'developer-id'
      )
        execFileSync(
          '/usr/bin/codesign',
          [
            '--force',
            '--sign',
            process.env.ALLRICE_BRIDGE_SIGNING_IDENTITY,
            '--timestamp',
            '--options',
            'runtime',
            target,
          ],
          { stdio: 'inherit' },
        );
      const bytes = await readFile(target);
      files.push({
        path,
        sizeBytes: bytes.length,
        sha256: digest(bytes),
        executable,
      });
      totalBytes += bytes.length;
    }
  }
  for (const source of sources.values()) {
    const paths =
      source.name === 'node-pty'
        ? ['package.json', 'LICENSE', 'lib', `prebuilds/darwin-${architecture}`]
        : source.name === 'koffi'
          ? [
              'package.json',
              'LICENSE.txt',
              'index.js',
              'index.cjs',
              'indirect.js',
              'indirect.cjs',
              'src/koffi/index.cjs',
              'src/koffi/indirect.cjs',
            ]
          : ['.'];
    for (const path of paths) {
      if (path === '.') {
        for (const name of (await readdir(source.root)).sort()) {
          if (name !== 'node_modules' && !name.startsWith('.'))
            await copy(
              join(source.root, name),
              `node_modules/${source.name}/${name}`,
            );
        }
      } else
        await copy(
          join(source.root, path),
          `node_modules/${source.name}/${path}`,
        );
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (files.reduce((sum, file) => sum + file.sizeBytes, 0) > 96 * 1024 * 1024)
    throw Error('HUMAN_TERMINAL_RUNTIME_TOO_LARGE');
  const manifest = {
    version: 1,
    platform: `macos-${architecture}`,
    packages: [...sources.values()]
      .map(({ name, version }) => ({ name, version }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en')),
    files,
  };
  const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(join(runtime, 'manifest.json'), manifestBytes, {
    mode: 0o644,
    flag: 'wx',
  });
  verifyTerminalRuntime(runtime, manifest, {
    platform: 'darwin',
    architecture,
    nodeVersion: '22.23.2',
  });
  return { runtime, manifest, manifestSha256: digest(manifestBytes) };
}

export function terminalSeaPlugin(manifest) {
  const loader = fileURLToPath(
    new URL('./rice-bridge-terminal-loader.mjs', import.meta.url),
  );
  return {
    name: 'allrice-fixed-human-terminal-runtime',
    setup(build) {
      build.onResolve(
        {
          filter:
            /^@deepseek-ai\/(cordis|dsh-api-terminal-controller|dsh-subprocess-local)(?:\/.*)?$/,
        },
        (args) => {
          if (!entryPackages.includes(args.path))
            throw Error('HUMAN_TERMINAL_SUBPATH_NOT_DECLARED');
          return { path: args.path, namespace: 'allrice-human-terminal' };
        },
      );
      build.onLoad(
        { filter: /.*/, namespace: 'allrice-human-terminal' },
        (args) => ({
          contents: `const { loadTerminalRuntime } = require(${JSON.stringify(loader)}); module.exports = loadTerminalRuntime(${JSON.stringify(manifest)}, ${JSON.stringify(args.path)});`,
          resolveDir: dirname(loader),
          loader: 'js',
        }),
      );
    },
  };
}

export async function verifyTerminalPackage(
  core,
  expected,
  run = execFileSync,
) {
  const root = `${core}.terminal-runtime`;
  const bytes = await readFile(join(root, 'manifest.json'));
  if (digest(bytes) !== expected.manifestSha256)
    throw Error('HUMAN_TERMINAL_RUNTIME_INTEGRITY_FAILED');
  const manifest = JSON.parse(bytes.toString('utf8'));
  verifyTerminalRuntime(root, manifest, {
    platform: 'darwin',
    architecture: expected.architecture,
    nodeVersion: '22.23.2',
  });
  for (const item of manifest.files.filter(
    (file) => file.path.endsWith('.node') || file.executable,
  )) {
    const path = join(root, item.path);
    const architecture =
      expected.architecture === 'x64' ? 'x86_64' : expected.architecture;
    const actual = run('/usr/bin/lipo', ['-archs', path], { encoding: 'utf8' })
      .trim()
      .split(/\s+/);
    if (actual.length !== 1 || actual[0] !== architecture)
      throw Error('HUMAN_TERMINAL_PACKAGE_ARCHITECTURE_MISMATCH');
    if (expected.signing?.mode === 'developer-id')
      run(
        '/usr/bin/codesign',
        [
          '--verify',
          '--strict',
          '-R',
          `anchor apple generic and certificate leaf[subject.OU] = "${expected.signing.teamId}"`,
          path,
        ],
        { stdio: 'pipe' },
      );
  }
  return manifest;
}
