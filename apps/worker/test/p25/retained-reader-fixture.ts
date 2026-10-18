/** Historical test source only; production retention still requires the full
 * independently measured artifact, exact SQL pin and original data namespace. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { readFile, mkdir, symlink, realpath, lstat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import manifest from './fixtures/retained-reader/manifest.json' with { type: 'json' };
const exec = promisify(execFile);
function hash(value: Buffer) {
  return createHash('sha256').update(value).digest('hex');
}
export async function retainedReaderFixture(root: string) {
  const source = resolve(
      import.meta.dirname,
      'fixtures/retained-reader/allrice-retained-source.tar.gz',
    ),
    target = join(root, 'retained-reader');
  if (hash(await readFile(source)) !== manifest.bundleSha256)
    throw Error('retained_reader_fixture_archive');
  await mkdir(target, { recursive: true });
  await exec('tar', ['-xzf', source, '-C', target], { timeout: 10000 });
  for (const f of manifest.files) {
    if (
      f.name.includes('/') ||
      hash(await readFile(join(target, f.name))) !== f.sha256
    )
      throw Error('retained_reader_fixture_source');
  }
  const adminRoot = resolve(import.meta.dirname, '../../../dsh-admin');
  const packages = new Map<string, string>(),
    seen = new Set<string>();
  async function locate(
    from: string,
    name: string,
  ): Promise<string | undefined> {
    const req = createRequire(join(from, 'package.json'));
    for (const folder of req.resolve.paths(name) ?? []) {
      const p = join(folder, name);
      try {
        await lstat(join(p, 'package.json'));
        return await realpath(p);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  async function visit(path: string): Promise<void> {
    path = await realpath(path);
    if (seen.has(path)) return;
    seen.add(path);
    const j = JSON.parse(
      await readFile(join(path, 'package.json'), 'utf8'),
    ) as {
      name: string;
      version: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    if (
      j.name.startsWith('@deepseek-ai/dsh-') &&
      j.version !== manifest.version
    )
      throw Error('retained_reader_fixture_generation');
    if (!packages.has(j.name)) packages.set(j.name, path);
    for (const name of new Set([
      ...Object.keys(j.dependencies ?? {}),
      ...Object.keys(j.peerDependencies ?? {}),
    ])) {
      const p = await locate(path, name);
      if (p) await visit(p);
    }
  }
  const dsh = await locate(adminRoot, '@deepseek-ai/dsh');
  if (!dsh) throw Error('retained_reader_fixture_packages');
  await visit(dsh);
  const contracts = await locate(adminRoot, '@allrice/contracts');
  if (!contracts) throw Error('retained_reader_fixture_contracts');
  packages.set('@allrice/contracts', contracts);
  // Public module paths retain their original package boundary and peer graph;
  // no upstream source is copied or patched by this fixture helper.
  for (const [name, path] of packages) {
    const link = join(target, 'node_modules', name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(path, link, 'dir');
  }
  return {
    entrypoint: join(target, 'allrice-jsonrpc-runtime.mjs'),
    profile: join(target, 'allrice-restricted.cordis.yml'),
    version: manifest.version,
  };
}
