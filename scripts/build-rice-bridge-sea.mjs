import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import {
  preparePlaywrightRuntime,
  playwrightSeaPlugin,
} from './rice-bridge-playwright-runtime.mjs';

const staticEnvironment = [
  'ALLRICE_BRIDGE_DEVICE_TOKEN',
  'ALLRICE_BRIDGE_STATIC_DEVICE_ID',
  'ALLRICE_BRIDGE_STATIC_SERVER',
];
const staticValues = staticEnvironment.map((name) => process.env[name]);
const staticBuild = staticValues.every(Boolean);
if (
  process.env.ALLRICE_BRIDGE_PUBLIC_BUILD === '1' &&
  staticValues.some(Boolean)
)
  throw new Error(
    'Public Bridge packages must never embed pairing credentials',
  );
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

function run(command, args, options = {}) {
  try {
    execFileSync(command, args, { stdio: 'inherit', ...options });
  } catch {
    throw new Error(`Rice Bridge build step failed: ${command}`);
  }
}

const browserRuntime = await preparePlaywrightRuntime(output);
// Use the lockfile's esbuild (tsx dependency), not a transient global binary.
{
  const require = createRequire(import.meta.url);
  const esbuild = createRequire(require.resolve('tsx/package.json'))('esbuild');
  await esbuild.build({
    entryPoints: [resolve('apps/rice-bridge/src/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    plugins: [playwrightSeaPlugin(browserRuntime.manifest)],
    ...(staticBuild
      ? {
          define: {
            ...Object.fromEntries(
              staticEnvironment.map((name) => [
                `process.env.${name}`,
                JSON.stringify(process.env[name]),
              ]),
            ),
            'process.env.ALLRICE_BRIDGE_STATIC_DEVICE_NAME':
              '"Rice Bridge Static"',
            'process.env.ALLRICE_BRIDGE_AUTOSTART': '"1"',
          },
        }
      : {}),
  });
}
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
const injection = [
  output,
  'NODE_SEA_BLOB',
  blob,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  '--macho-segment-name',
  'NODE_SEA',
];
if (process.env.ALLRICE_POSTJECT_CLI) {
  const cli = resolve(process.env.ALLRICE_POSTJECT_CLI);
  const metadata = JSON.parse(
    await (
      await import('node:fs/promises')
    ).readFile(resolve(cli, '../../package.json'), 'utf8'),
  );
  if (metadata.name !== 'postject' || metadata.version !== '1.0.0-alpha.6')
    throw Error('BRIDGE_POSTJECT_VERSION_NOT_LOCKED');
  run(process.execPath, [cli, ...injection]);
} else run('pnpm', ['dlx', 'postject@1.0.0-alpha.6', ...injection]);
run('/usr/bin/codesign', ['--sign', '-', output]);
await chmod(output, 0o755);
console.info(`Rice Bridge SEA created at ${output}`);
console.info(
  JSON.stringify({
    browserRuntime: browserRuntime.runtime,
    browserRuntimeManifestSha256: browserRuntime.manifestSha256,
  }),
);
