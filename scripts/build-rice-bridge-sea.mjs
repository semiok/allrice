import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const staticEnvironment = [
  'ALLRICE_BRIDGE_DEVICE_TOKEN',
  'ALLRICE_BRIDGE_STATIC_DEVICE_ID',
  'ALLRICE_BRIDGE_STATIC_SERVER',
];
const staticValues = staticEnvironment.map((name) => process.env[name]);
const staticBuild = staticValues.every(Boolean);
if (!staticBuild && staticValues.some(Boolean)) {
  throw new Error(
    `${staticEnvironment.join(', ')} must either all be set or all be omitted`,
  );
}

const output = resolve(process.argv[2] ?? 'RiceBridge');
const nodeBinary = process.env.ALLRICE_BRIDGE_NODE_BINARY ?? process.execPath;
const blobNodeBinary =
  process.env.ALLRICE_BRIDGE_BLOB_NODE_BINARY ?? process.execPath;
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

const esbuildArguments = [
  'exec',
  'esbuild',
  'apps/rice-bridge/src/index.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  `--outfile=${bundle}`,
];
if (staticBuild) {
  esbuildArguments.push(
    ...staticEnvironment.map(define),
    '--define:process.env.ALLRICE_BRIDGE_STATIC_DEVICE_NAME="Rice Bridge Static"',
    '--define:process.env.ALLRICE_BRIDGE_AUTOSTART="1"',
  );
}
run('pnpm', esbuildArguments, { cwd: resolve('.') });
await writeFile(
  seaConfig,
  JSON.stringify({
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
  }),
);
run(blobNodeBinary, ['--experimental-sea-config', seaConfig]);
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
