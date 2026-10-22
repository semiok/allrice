/** Included in the SEA. Expected package/file bytes come from the signed core,
 * never from an environment-selected runtime or an on-disk manifest. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { isSea } from 'node:sea';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const roots = new Set([
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-api-terminal-controller',
  '@deepseek-ai/dsh-subprocess-local',
]);

export function verifyTerminalRuntime(
  root,
  manifest,
  host = {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.versions.node,
  },
) {
  try {
    if (
      manifest.version !== 1 ||
      host.platform !== 'darwin' ||
      manifest.platform !== `macos-${host.architecture}` ||
      host.nodeVersion !== '22.23.2' ||
      realpathSync(root) !== resolve(root)
    )
      throw Error();
    const packages = new Map(
      manifest.packages.map((item) => [item.name, item.version]),
    );
    if (
      packages.size !== manifest.packages.length ||
      packages.get('@deepseek-ai/cordis') !== '4.0.5' ||
      packages.get('@deepseek-ai/dsh-api-terminal-controller') !==
        '0.2.1-rc.2' ||
      packages.get('@deepseek-ai/dsh-subprocess-local') !== '0.2.1-rc.2' ||
      packages.get('node-pty') !== '1.2.0-beta.15' ||
      packages.get('koffi') !== '3.1.1' ||
      packages.get(`@koromix/koffi-darwin-${host.architecture}`) !== '3.1.1'
    )
      throw Error();
    const wanted = new Map(manifest.files.map((file) => [file.path, file]));
    if (wanted.size !== manifest.files.length || wanted.size > 10_000)
      throw Error();
    const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
    wanted.set('manifest.json', {
      sizeBytes: Buffer.byteLength(manifestBytes),
      sha256: digest(manifestBytes),
      executable: false,
    });
    const dirs = new Set(['']);
    for (const name of wanted.keys()) {
      if (
        name.startsWith('/') ||
        name.includes('\\') ||
        name.split('/').some((part) => !part || part === '.' || part === '..')
      )
        throw Error();
      for (let d = dirname(name); d !== '.'; d = dirname(d)) dirs.add(d);
    }
    const seen = new Set();
    const owner = process.getuid?.();
    function scan(path, relative = '') {
      const stat = lstatSync(path);
      if (
        stat.isSymbolicLink() ||
        stat.mode & 0o022 ||
        (stat.uid !== owner && stat.uid !== 0)
      )
        throw Error();
      if (stat.isDirectory()) {
        if (!dirs.has(relative)) throw Error();
        for (const name of readdirSync(path))
          scan(join(path, name), relative ? `${relative}/${name}` : name);
      } else {
        const expected = wanted.get(relative);
        if (
          !expected ||
          !stat.isFile() ||
          stat.size !== expected.sizeBytes ||
          digest(readFileSync(path)) !== expected.sha256 ||
          (expected.executable && !(stat.mode & 0o111))
        )
          throw Error();
        seen.add(relative);
      }
    }
    scan(root);
    if (seen.size !== wanted.size) throw Error();
    return createRequire(join(root, 'entry.cjs'));
  } catch {
    throw Error('HUMAN_TERMINAL_RUNTIME_INTEGRITY_FAILED');
  }
}

let verified;
export function loadTerminalRuntime(manifest, name) {
  if (!isSea() || !roots.has(name))
    throw Error('HUMAN_TERMINAL_FIXED_RUNTIME_REQUIRED');
  if (!verified) {
    const require = verifyTerminalRuntime(
      `${process.execPath}.terminal-runtime`,
      manifest,
    );
    // Fail before advertising humanTerminalVersion if either native ABI is
    // unavailable. The modules and helper are selected and signed at build time.
    require('node-pty');
    require('koffi');
    verified = require;
  }
  return verified(name);
}
