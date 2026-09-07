/** Host-architecture SEA smoke; never pairs a real device or uses a tenant. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { arch, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';

if (platform() !== 'darwin')
  throw new Error('This smoke validates the macOS SEA packaging path');
const require = createRequire(import.meta.url);
// esbuild is already supplied by the pinned tsx development toolchain.
const esbuild = createRequire(require.resolve('tsx/package.json'))('esbuild');
const temporary = await mkdtemp(join(tmpdir(), 'allrice-p03b-sea-'));
const binary = join(temporary, 'RiceBridge');
const bundle = join(temporary, 'bridge.cjs');
const blob = join(temporary, 'bridge.blob');
const config = join(temporary, 'sea.json');
const nodeBinary = process.env.ALLRICE_BRIDGE_NODE_BINARY ?? process.execPath;
const blobNodeBinary =
  process.env.ALLRICE_BRIDGE_BLOB_NODE_BINARY ?? nodeBinary;

async function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  const [code] = await once(child, 'exit');
  if (code !== 0)
    throw new Error(`SEA verification command failed: ${command}`);
}

let child;
let server;
try {
  await esbuild.build({
    entryPoints: [resolve('apps/rice-bridge/src/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
  });
  await writeFile(
    config,
    JSON.stringify({
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
    }),
  );
  await run(blobNodeBinary, ['--experimental-sea-config', config]);
  await copyFile(nodeBinary, binary);
  await chmod(binary, 0o700);
  await run('/usr/bin/codesign', ['--remove-signature', binary]).catch(
    () => undefined,
  );
  const inject = [
    binary,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    '--macho-segment-name',
    'NODE_SEA',
  ];
  if (process.env.ALLRICE_POSTJECT_CLI)
    await run(process.execPath, [process.env.ALLRICE_POSTJECT_CLI, ...inject]);
  else await run('pnpm', ['dlx', 'postject@1.0.0-alpha.6', ...inject]);
  await run('/usr/bin/codesign', ['--sign', '-', binary]);
  await run(binary, ['help']);
  let resolvePoll;
  const polled = new Promise((resolve) => {
    resolvePoll = resolve;
  });
  server = createServer((request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');
    if (request.url.endsWith('/operations/next')) {
      response.end('{"dispatch":null}');
      resolvePoll();
    } else if (request.url.endsWith('/workspace-selections/next'))
      response.end('{"request":null}');
    else response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  child = spawn(binary, ['start'], {
    env: {
      ...process.env,
      ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED: '1',
      ALLRICE_BRIDGE_CONFIG_PATH: join(temporary, 'config.json'),
      ALLRICE_BRIDGE_STATIC_DEVICE_ID: '00000000-0000-4000-8000-000000000011',
      ALLRICE_BRIDGE_STATIC_DEVICE_NAME: 'Synthetic SEA acceptance',
      ALLRICE_BRIDGE_STATIC_SERVER: `http://127.0.0.1:${server.address().port}`,
      ALLRICE_BRIDGE_DEVICE_TOKEN: 'synthetic-localhost-only-token',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const exited = once(child, 'exit');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    await Promise.race([
      polled,
      exited.then(() => {
        throw new Error('SEA exited before ledger polling');
      }),
    ]);
    const metadata = await lstat(
      join(temporary, 'config.json.operation-journal', 'journal.sqlite'),
    );
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600)
      throw new Error('SEA private journal was not created');
    child.kill('SIGTERM');
    const [code] = await exited;
    if (code !== 0) throw new Error('SEA did not stop cleanly');
  } finally {
    clearTimeout(deadline);
  }
  console.info(
    `PASS: real macOS ${arch()} SEA loaded built-in SQLite, durably initialized journal, polled synthetic HTTP, and stopped; no real device/tenant.`,
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(temporary, { recursive: true, force: true });
}
