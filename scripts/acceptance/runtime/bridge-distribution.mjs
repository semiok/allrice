/** Exercise the exact shipped binary with synthetic pairing; never touch Keychain or tenant state. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setTimeout, clearTimeout } from 'node:timers';
const binary = resolve(process.argv[2]);
assert.equal(process.platform, 'darwin');
const root = await mkdtemp(join(tmpdir(), 'allrice-dist-smoke-'));
const config = {
  deviceId: '00000000-0000-4000-8000-000000000011',
  deviceName: 'Synthetic package probe',
  grants: [],
};
let enabled = false,
  polled = false,
  profileCount = 0,
  legacyCount = 0;
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  response.setHeader('content-type', 'application/json');
  if (request.url.endsWith('/runtime-profile')) {
    const profile = JSON.parse(body);
    assert.equal(
      profile.architecture,
      process.arch === 'arm64' ? 'arm64' : 'amd64',
    );
    profileCount++;
    response.statusCode = enabled ? 200 : 403;
    response.end(enabled ? '{}' : '{"error":{"message":"FEATURE_DISABLED"}}');
  } else if (request.url.endsWith('/operations/next')) {
    if (enabled) {
      assert.equal(JSON.parse(body).supportsLocalCommand, true);
      polled = true;
    }
    response.statusCode = enabled ? 200 : 404;
    response.end(
      enabled
        ? '{"dispatch":null}'
        : '{"error":{"message":"FEATURE_DISABLED"}}',
    );
  } else if (request.url.endsWith('/commands/next')) {
    legacyCount++;
    if (!enabled) polled = true;
    response.end('{"command":null}');
  } else if (request.url.endsWith('/workspace-selections/next'))
    response.end('{"request":null}');
  else response.end('{}');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
config.server = `http://127.0.0.1:${server.address().port}/`;
const path = join(root, 'config.json');
await writeFile(path, JSON.stringify(config), { mode: 0o600 });
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  ALLRICE_BRIDGE_CONFIG_PATH: path,
  ALLRICE_BRIDGE_DEVICE_TOKEN: 'synthetic-localhost-only-token',
};
async function cli(args) {
  const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', (chunk) => (text += chunk));
  child.stderr.on('data', (chunk) => (text += chunk));
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
  const [code] = await once(child, 'exit');
  clearTimeout(timeout);
  return { code, text };
}
try {
  assert.equal((await cli(['--version'])).text.trim(), '0.4.0-dev.2');
  assert.equal((await cli(['sandbox', 'status'])).code, 0);
  assert.equal((await cli(['sandbox', 'enable'])).code, 1);
  await assert.rejects(readFile(`${path}.sandbox.json`), { code: 'ENOENT' });
  enabled = true;
  assert.equal((await cli(['sandbox', 'enable'])).code, 0);
  assert.equal(
    JSON.parse(await readFile(`${path}.sandbox.json`)).enabled,
    true,
  );
  for (const active of [true, false]) {
    enabled = active;
    polled = false;
    const child = spawn(binary, ['start'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.resume();
    child.stderr.resume();
    const exited = once(child, 'exit');
    try {
      for (let i = 0; i < 100 && !polled && child.exitCode === null; i++)
        await delay(100);
      assert.ok(
        polled,
        `Shipped binary did not poll ${active ? 'approved native' : 'legacy rollback'} queue`,
      );
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      const [code] = await exited;
      clearTimeout(timeout);
      assert.equal(code, 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  }
  assert.equal((await cli(['sandbox', 'disable'])).code, 0);
  assert.equal(
    JSON.parse(await readFile(`${path}.sandbox.json`)).enabled,
    false,
  );
  assert.deepEqual(JSON.parse(await readFile(path)), config);
  console.log(
    JSON.stringify({
      passed: true,
      architecture: process.arch,
      version: '0.4.0-dev.2',
      nativePreflight: true,
      enableRejectDoesNotPersist: true,
      localOptInPersists: true,
      serverRollbackKeepsLegacyFiles: true,
      cleanStop: true,
      syntheticPairingUnchanged: true,
      profileCount,
      legacyCount,
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
