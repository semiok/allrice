/** Build-time only. Copies the already locked package, never installs anything. */
import { createHash } from 'node:crypto';
import {
  copyFile,
  chmod,
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

export const PLAYWRIGHT_RUNTIME_VERSION = '1.62.1';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function preparePlaywrightRuntime(
  output,
  projectRoot = process.cwd(),
) {
  const require = createRequire(
    join(resolve(projectRoot), 'apps/rice-bridge/package.json'),
  );
  const source = await realpath(
    dirname(require.resolve('playwright-core/package.json')),
  );
  const metadata = JSON.parse(
    await readFile(join(source, 'package.json'), 'utf8'),
  );
  if (
    metadata.name !== 'playwright-core' ||
    metadata.version !== PLAYWRIGHT_RUNTIME_VERSION
  )
    throw Error('BRIDGE_PLAYWRIGHT_VERSION_NOT_LOCKED');
  const files = [];
  async function scan(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      if (name.startsWith('.') || !/^[A-Za-z0-9_+@. -]+$/.test(name))
        throw Error('BRIDGE_PLAYWRIGHT_SOURCE_UNEXPECTED');
      const path = prefix + name,
        input = join(directory, name),
        stat = await lstat(input);
      if (stat.isSymbolicLink())
        throw Error('BRIDGE_PLAYWRIGHT_SOURCE_SYMLINK');
      if (stat.isDirectory()) await scan(input, path + '/');
      else if (stat.isFile() && stat.size <= 32 * 1024 * 1024) {
        const bytes = await readFile(input);
        files.push({ path, sha256: digest(bytes), sizeBytes: bytes.length });
      } else throw Error('BRIDGE_PLAYWRIGHT_SOURCE_UNEXPECTED');
    }
  }
  await scan(source);
  if (
    !files.length ||
    files.length > 2000 ||
    files.reduce((n, f) => n + f.sizeBytes, 0) > 100 * 1024 * 1024
  )
    throw Error('BRIDGE_PLAYWRIGHT_SOURCE_TOO_LARGE');
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const manifest = {
    version: 1,
    package: { name: 'playwright-core', version: PLAYWRIGHT_RUNTIME_VERSION },
    files,
  };
  const runtime = resolve(output) + '.runtime';
  // A partial/previous distribution is never silently overwritten.
  await mkdir(runtime, { mode: 0o755 });
  for (const f of files) {
    const target = join(runtime, 'playwright-core', f.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await copyFile(join(source, f.path), target);
    await chmod(target, 0o644);
    if (digest(await readFile(target)) !== f.sha256)
      throw Error('BRIDGE_PLAYWRIGHT_COPY_CHANGED');
  }
  const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(join(runtime, 'manifest.json'), manifestBytes, {
    mode: 0o644,
    flag: 'wx',
  });
  return { runtime, manifest, manifestSha256: digest(manifestBytes) };
}

export function playwrightSeaPlugin(manifest) {
  const loader = fileURLToPath(
    new URL('./rice-bridge-playwright-loader.mjs', import.meta.url),
  );
  return {
    name: 'allrice-fixed-playwright-runtime',
    setup(build) {
      build.onResolve({ filter: /^playwright-core(?:\/.*)?$/ }, (args) => {
        if (args.path !== 'playwright-core')
          throw Error('BRIDGE_PLAYWRIGHT_SUBPATH_NOT_DECLARED');
        return { path: 'fixed-playwright', namespace: 'allrice-playwright' };
      });
      build.onLoad({ filter: /.*/, namespace: 'allrice-playwright' }, () => ({
        contents: `const { loadPlaywrightRuntime } = require(${JSON.stringify(loader)}); module.exports = loadPlaywrightRuntime(${JSON.stringify(manifest)});`,
        resolveDir: dirname(loader),
        loader: 'js',
      }));
    },
  };
}
