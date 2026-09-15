import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireCheck, strictDescendant } from './p27-assistant-preflight.ts';

const names = [
  'dsh-app-boot',
  'dsh-sdk-protocol',
  'dsh-sdk-jsonrpc-server',
  'dsh-tools',
  'dsh-subagent',
  'dsh-subagent-spawn-in-process',
  'dsh-session-persistence-jsonl',
  'dsh-llm-pi-ai',
].map((name) => `@deepseek-ai/${name}`);
const specifiers = [
  ...names,
  '@earendil-works/pi-ai',
  '@earendil-works/pi-ai/providers/openai-codex',
  '@earendil-works/pi-ai/providers/google',
];
const hash = (value: Uint8Array | string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

/** Read-only metadata/entry hashing. Resolves with the actual native host's ESM
 * parent URL, without importing/executing any package or reading credentials.
 * Entry hashes are observed bytes, not a claim of whole-package SRI verification.
 */
export async function collectP27InstalledRuntime(root: string) {
  const metadata = JSON.parse(
    await readFile(join(root, 'apps/worker/package.json'), 'utf8'),
  );
  const lock = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8');
  const importer = lock.match(
    /\n {2}apps\/worker:\n([\s\S]*?)(?=\n {2}[^ ]|$)/,
  )?.[1];
  requireCheck(importer, 'worker_lock_importer_missing');
  const parent = pathToFileURL(
    join(root, 'apps/worker/dsh/allrice-jsonrpc-runtime.mjs'),
  ).href;
  const resolved: string[] = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--experimental-import-meta-resolve',
        '--input-type=module',
        '-e',
        'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).map((name) => import.meta.resolve(name, process.argv[2]))))',
        JSON.stringify(specifiers),
        parent,
      ],
      {
        cwd: root,
        env: {},
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ),
  );
  requireCheck(resolved.length === specifiers.length, 'installed_resolution');
  const entries = [];
  for (const [index, specifier] of specifiers.entries()) {
    const name = specifier.startsWith('@earendil-works/pi-ai')
      ? '@earendil-works/pi-ai'
      : specifier;
    const packageRoot = await realpath(
      join(root, 'apps/worker/node_modules', name),
    );
    const bytes = await readFile(join(packageRoot, 'package.json'));
    const installed = JSON.parse(bytes.toString('utf8'));
    const expected = metadata.dependencies[name];
    requireCheck(
      installed.name === name &&
        installed.version === expected &&
        typeof expected === 'string' &&
        /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.]+)?$/.test(expected),
      'installed_version_mismatch',
    );
    requireCheck(
      importer.includes(
        `      '${name}':\n        specifier: ${expected}\n        version: ${expected}(`,
      ) ||
        importer.includes(
          `      '${name}':\n        specifier: ${expected}\n        version: ${expected}\n`,
        ),
      'installed_lock_mismatch',
    );
    const entry = await realpath(fileURLToPath(resolved[index]!));
    requireCheck(
      strictDescendant(packageRoot, entry),
      'installed_entry_outside_package',
    );
    entries.push({
      specifier,
      version: installed.version as string,
      packageMetadataDigest: hash(bytes),
      entryDigest: hash(await readFile(entry)),
    });
  }
  return {
    node: {
      version: process.version,
      arch: process.arch,
      platform: process.platform,
    },
    entries,
    scope:
      'actual_esm_entry_hashes_and_exact_worker_lock_pins_not_full_dependency_integrity',
  };
}
