// Included in the SEA. Expected hashes come from its bundle, not disk/env.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, basename, join, resolve } from 'node:path';
import { isSea } from 'node:sea';
const digest = (value) => createHash('sha256').update(value).digest('hex');

export function verifyPlaywrightRuntime(root, manifest) {
  try {
    if (
      manifest.version !== 1 ||
      manifest.package.name !== 'playwright-core' ||
      manifest.package.version !== '1.62.1'
    )
      throw Error();
    if (realpathSync(root) !== resolve(root)) throw Error();
    const wantedFiles = new Map(
      manifest.files.map((file) => ['playwright-core/' + file.path, file]),
    );
    const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
    wantedFiles.set('manifest.json', {
      sha256: digest(manifestBytes),
      sizeBytes: Buffer.byteLength(manifestBytes),
    });
    const wantedDirectories = new Set(['']);
    for (const name of wantedFiles.keys()) {
      if (name.includes('..') || name.includes('\\') || name.startsWith('/'))
        throw Error();
      let dir = dirname(name);
      while (dir !== '.') {
        wantedDirectories.add(dir);
        dir = dirname(dir);
      }
    }
    const seen = new Set();
    function scan(path, prefix = '') {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw Error();
      if (stat.isDirectory()) {
        if (!wantedDirectories.has(prefix)) throw Error();
        for (const name of readdirSync(path))
          scan(join(path, name), prefix ? prefix + '/' + name : name);
      } else {
        const expected = wantedFiles.get(prefix);
        if (
          !expected ||
          !stat.isFile() ||
          stat.size !== expected.sizeBytes ||
          digest(readFileSync(path)) !== expected.sha256
        )
          throw Error();
        seen.add(prefix);
      }
    }
    scan(root);
    if (seen.size !== wantedFiles.size) throw Error();
    return join(root, 'playwright-core', 'index.js');
  } catch {
    throw Error('BRIDGE_BROWSER_RUNTIME_INTEGRITY_FAILED');
  }
}

export function loadPlaywrightRuntime(manifest) {
  if (!isSea()) throw Error('BRIDGE_BROWSER_RUNTIME_REQUIRES_SEA');
  const root = join(
    dirname(process.execPath),
    basename(process.execPath) + '.runtime',
  );
  const entry = verifyPlaywrightRuntime(root, manifest);
  try {
    return createRequire(entry)(entry);
  } catch {
    throw Error('BRIDGE_BROWSER_RUNTIME_UNAVAILABLE');
  }
}
