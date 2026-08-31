import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const required = [
  'ALLRICE_BRIDGE_DEVICE_TOKEN',
  'ALLRICE_BRIDGE_STATIC_DEVICE_ID',
  'ALLRICE_BRIDGE_STATIC_SERVER',
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

const output = resolve(process.argv[2] ?? 'RiceBridge');
const nodeBinary = process.env.ALLRICE_BRIDGE_NODE_BINARY ?? process.execPath;
const temporary = await mkdtemp(join(tmpdir(), 'allrice-bridge-sea-'));
const bundle = join(temporary, 'rice-bridge.cjs');
const blob = join(temporary, 'rice-bridge.blob');
const seaConfig = join(temporary, 'sea-config.json');
const define = (name) =>
  `--define:process.env.${name}=${JSON.stringify(process.env[name])}`;

function run(command, args, options = {}) {
  try {
    execFileSync(command, args, { stdio: 'inherit', ...options });
  } catch {
    throw new Error(`Rice Bridge build step failed: ${command}`);
  }
}

run(
  'pnpm',
  [
    'exec',
    'esbuild',
    'apps/rice-bridge/src/index.ts',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--outfile=${bundle}`,
    define('ALLRICE_BRIDGE_DEVICE_TOKEN'),
    define('ALLRICE_BRIDGE_STATIC_DEVICE_ID'),
    define('ALLRICE_BRIDGE_STATIC_SERVER'),
    '--define:process.env.ALLRICE_BRIDGE_STATIC_DEVICE_NAME="Snow Mac M5 · Static v0.2"',
    '--define:process.env.ALLRICE_BRIDGE_AUTOSTART="1"',
  ],
  { cwd: resolve('.') },
);
await writeFile(
  seaConfig,
  JSON.stringify({
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
  }),
);
run(process.execPath, ['--experimental-sea-config', seaConfig]);
await unlink(output).catch(() => undefined);
await copyFile(nodeBinary, output);
await chmod(output, 0o755);
try {
  execFileSync('/usr/bin/codesign', ['--remove-signature', output], {
    stdio: 'ignore',
  });
} catch {
  // A copied Node binary may already be unsigned.
}
run('pnpm', [
  'dlx',
  'postject',
  output,
  'NODE_SEA_BLOB',
  blob,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  '--macho-segment-name',
  'NODE_SEA',
]);
run('/usr/bin/codesign', ['--sign', '-', output]);
await chmod(output, 0o755);
console.info(`Rice Bridge SEA created at ${output}`);
