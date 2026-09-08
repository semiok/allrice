/** Built SEA + native host smoke with an isolated identity and HTTP fixture.
 * Complements, never substitutes for, bridge-desktop.mjs native AX acceptance. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'darwin');
assert.ok(process.argv[2], 'Provide built .app path');
const app = resolve(process.argv[2]);
const fresh = process.argv.includes('--fresh');
const savedOptIn = process.argv.includes('--saved-opt-in');
if (fresh)
  assert.equal(
    process.env.ALLRICE_BRIDGE_TEST_KEYCHAIN,
    '1',
    'Explicit opt-in required for one random synthetic Keychain account',
  );
const deviceId = fresh ? randomUUID() : '00000000-0000-4000-8000-000000000011';
const fixtureToken = 'synthetic-core-token-never-a-real-credential';
let pairedByFixture = false;
const core = join(app, 'Contents/Resources/RiceBridgeCore');
const root = await realpath(await mkdtemp(join(tmpdir(), 'allrice-p13-core-')));
const workspace = join(root, 'workspace');
await mkdir(workspace);
const path = join(root, 'config.json');
const owned = [];
let polls = 0;
let operationPolls = 0;
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  response.setHeader('content-type', 'application/json');
  if (request.url.endsWith('/pair')) {
    assert.equal(JSON.parse(body).code, 'ABCD-EF12');
    pairedByFixture = true;
    response.end(
      JSON.stringify({
        device: {
          id: deviceId,
          organizationId: deviceId,
          workspaceId: deviceId,
          ownerId: deviceId,
          name: 'P13 isolated ARM/Intel acceptance',
          platform: process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64',
          protocolVersion: 2,
          capabilities: ['local.fs.read'],
          status: 'online',
          createdAt: new Date().toISOString(),
          lastSeenAt: null,
          revokedAt: null,
        },
        deviceToken: fixtureToken,
      }),
    );
  } else if (request.url.endsWith('/operations/next')) {
    operationPolls++;
    response.end('{"dispatch":null}');
  } else if (request.url.endsWith('/commands/next')) {
    polls++;
    response.end('{"command":null}');
  } else if (request.url.endsWith('/workspace-selections/next')) {
    response.end('{"request":null}');
  } else if (request.url.endsWith('/grants')) {
    response.end(
      JSON.stringify({
        grant: {
          id: '00000000-0000-4000-8000-000000000012',
          ...JSON.parse(body),
        },
      }),
    );
  } else response.end('{}');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const config = {
  deviceId,
  deviceName: 'P13 isolated ARM/Intel acceptance',
  server: `http://127.0.0.1:${server.address().port}/`,
  grants: [],
};
if (!fresh) await writeFile(path, JSON.stringify(config), { mode: 0o600 });
if (savedOptIn)
  await writeFile(
    `${path}.sandbox.json`,
    JSON.stringify({
      version: 1,
      enabled: true,
      deviceId,
      server: config.server,
    }),
    { mode: 0o600 },
  );
const env = {
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  PATH: '/usr/bin:/bin',
  ALLRICE_BRIDGE_CONFIG_PATH: path,
  ...(!fresh ? { ALLRICE_BRIDGE_DEVICE_TOKEN: fixtureToken } : {}),
  ...(!savedOptIn ? { ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED: '0' } : {}),
};
async function wait(predicate) {
  for (let i = 0; i < 150; i++) {
    if (await predicate()) return;
    await delay(100);
  }
  throw Error('isolated package acceptance timed out');
}
function launch(binary = core, args = ['desktop']) {
  const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  owned.push(child);
  child.stderr.resume();
  let output = '';
  const frames = [];
  let buffer = '';
  child.stdout.on('data', (bytes) => {
    output = (output + bytes).slice(-32768);
    buffer += bytes;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.startsWith('{')) frames.push(JSON.parse(line));
    }
  });
  const request = async (type, fields = {}) => {
    const id = `${type}-${frames.length}`;
    child.stdin.write(JSON.stringify({ v: 1, id, type, ...fields }) + '\n');
    await wait(() =>
      frames.some((frame) => frame.type === 'response' && frame.id === id),
    );
    return frames.find((frame) => frame.type === 'response' && frame.id === id);
  };
  return { child, frames, request, output: () => output };
}
const exited = (child) =>
  wait(() => child.exitCode !== null || child.signalCode !== null);
const result = {
  architecture: process.arch,
  root,
  syntheticIdentityOnly: true,
  passed: false,
};
try {
  result.version = execFileSync(core, ['--version'], {
    encoding: 'utf8',
  }).trim();
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const first = launch();
  if (fresh) {
    await wait(() =>
      first.frames.some((frame) => frame.state?.mode === 'unpaired'),
    );
    assert.equal(
      (await first.request('pair', { server: config.server, code: 'ABCDEF12' }))
        .ok,
      true,
    );
    result.freshPairing = true;
    try {
      const stored = execFileSync(
        '/usr/bin/security',
        [
          'find-generic-password',
          '-s',
          'ai.traditionow.allrice.rice-bridge',
          '-a',
          deviceId,
          '-w',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
      ).trim();
      assert.equal(stored, fixtureToken);
      result.credentialStore = 'keychain';
    } catch {
      assert.equal(
        (await readFile(`${path}.token`, 'utf8')).trim(),
        fixtureToken,
      );
      result.credentialStore = 'private-file-fallback';
    }
  }
  await wait(() => polls > 0);
  if (savedOptIn)
    assert.ok(
      operationPolls > 0,
      'saved opt-in must enable operation polling without env flag',
    );
  assert.equal((await first.request('pause')).ok, true);
  const pausedPolls = polls;
  await delay(1200);
  assert.equal(polls, pausedPolls);
  assert.equal((await first.request('status')).data.mode, 'paused');
  result.pauseStopsPolling = true;
  const duplicate = launch();
  await exited(duplicate.child);
  assert.equal(duplicate.child.exitCode, 1);
  assert.ok(
    duplicate.frames.some((frame) => frame.code === 'BRIDGE_ALREADY_RUNNING'),
  );
  result.exclusiveEvenWhilePaused = true;
  assert.equal(
    (await first.request('workspace', { path: workspace })).ok,
    true,
  );
  const updated = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(updated.grants[0].rootPath, workspace);
  assert.equal(updated.deviceId, config.deviceId);
  assert.equal(updated.journalNamespace, fresh ? deviceId : undefined);
  result.workspaceAndIdentityPreserved = true;
  assert.equal((await first.request('resume')).ok, true);
  await wait(() => polls > pausedPolls);
  const diagnostics = JSON.stringify((await first.request('diagnostics')).data);
  assert.ok(!diagnostics.includes(root));
  assert.ok(!diagnostics.includes(fixtureToken));
  assert.equal((await first.request('stop')).ok, true);
  await exited(first.child);
  assert.equal(first.child.exitCode, 0);
  result.resumeAndStop = true;
  const reopened = launch();
  await wait(() => reopened.frames.some((frame) => frame.type === 'state'));
  reopened.child.stdin.end();
  await exited(reopened.child);
  assert.equal(reopened.child.exitCode, 0);
  result.eofAndOwnerReacquisition = true;
  // Real AppKit host process, not an AX click test; explicitly labelled.
  const render = join(root, 'native-status-view.png');
  const beforeHostPolls = polls;
  const beforeHostOperations = operationPolls;
  const host = launch(join(app, 'Contents/MacOS/RiceBridgeApp'), [
    '--acceptance',
    `--acceptance-render=${render}`,
  ]);
  await wait(() => polls > beforeHostPolls);
  if (savedOptIn) {
    assert.ok(
      operationPolls > beforeHostOperations,
      'native host must preserve saved opt-in',
    );
    result.nativeSavedOptInWithoutEnvironmentFlag = true;
  }
  await wait(() => host.output().includes('P13_WINDOW_ID='));
  await wait(() =>
    readFile(render)
      .then(() => true)
      .catch(() => false),
  );
  result.nativeHostStarted = true;
  result.nativeViewRender = render;
  const duplicateHost = launch(join(app, 'Contents/MacOS/RiceBridgeApp'), [
    '--acceptance',
  ]);
  await exited(duplicateHost.child);
  assert.equal(duplicateHost.child.exitCode, 0);
  result.duplicateNativeHostExits = true;
  host.child.kill('SIGTERM'); // Only this synthetic app. Core must honor pipe EOF.
  await exited(host.child);
  await delay(800);
  const afterHost = launch();
  await wait(() => afterHost.frames.some((frame) => frame.type === 'state'));
  if (fresh) {
    assert.equal(
      (await afterHost.request('revoke', { confirmDeviceId: deviceId })).ok,
      true,
    );
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    result.onlineRevoke = true;
  }
  assert.equal((await afterHost.request('stop')).ok, true);
  await exited(afterHost.child);
  result.nativeHostExitReleasesOwnedCore = true;
  result.passed = true;
} finally {
  for (const child of owned) {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      child.kill('SIGTERM');
      await exited(child);
    }
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (fresh && pairedByFixture) {
    try {
      execFileSync(
        '/usr/bin/security',
        [
          'delete-generic-password',
          '-s',
          'ai.traditionow.allrice.rice-bridge',
          '-a',
          deviceId,
        ],
        { stdio: 'ignore', timeout: 5000 },
      );
    } catch {
      /* Product revoke normally already removed this test-owned account. */
    }
  }
  await writeFile(
    join(root, 'result.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result));
}
