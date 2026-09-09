/** Exact shipped Core + native helper + installed Chrome, synthetic loopback
 * authority only. No production credentials, personal profile, VM or model. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'darwin');
assert.equal(process.argv.length, 3, 'Provide the exact extracted Core binary');
const core = await realpath(resolve(process.argv[2]));
assert.ok(['RiceBridgeCore', 'RiceBridge'].includes(basename(core)));
const helper =
  basename(core) === 'RiceBridgeCore'
    ? join(dirname(core), '../MacOS/RiceBrowserLauncher')
    : join(dirname(core), 'RiceBrowserLauncher');
const digest = async (p) =>
  createHash('sha256')
    .update(await readFile(p))
    .digest('hex');
const directory = await realpath(
  await mkdtemp(join(tmpdir(), 'allrice-b5-shipped-browser-')),
);
const report = {
  passed: false,
  architecture: process.arch,
  coreSha256: await digest(core),
  browserLauncherSha256: await digest(helper),
  scope:
    'exact shipped Core start loop + native helper + installed Chrome; synthetic HTTP authority/token only; no PG/VM/model/personal config/Keychain',
  cases: [],
  errors: [],
};
function groupGone(pgid) {
  assert.ok(Number.isSafeInteger(pgid) && pgid > 1);
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (e) {
    if (e.code === 'ESRCH') return true;
    throw e;
  }
}
async function waitFor(predicate, name, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await delay(50);
  }
  throw Error('WAIT_' + name);
}
async function scenario(mode) {
  const temp = await realpath(await mkdtemp(join(directory, mode + '-'))),
    token = randomUUID(),
    deviceId = randomUUID(),
    workspaceId = randomUUID(),
    leaseToken = randomUUID(),
    configPath = join(temp, 'config.json');
  let enabled = false,
    claimed = false,
    captured = 0,
    acknowledged = false,
    stopped = false,
    heartbeats = 0,
    frozenExpiry = null,
    revoke = false,
    controllerId,
    child,
    server;
  const failures = [],
    workspace = {
      id: workspaceId,
      scope: {
        organizationId: randomUUID(),
        workspaceId: randomUUID(),
        projectId: null,
      },
      ownerId: randomUUID(),
      deviceId,
      runId: randomUUID(),
      rootRunId: randomUUID(),
      sessionId: randomUUID(),
      profileId: randomUUID(),
      logicalProfileId: randomUUID(),
      grantId: randomUUID(),
      grantRevision: 1,
      persistLogin: false,
      profile: {
        version: 1,
        origins: ['https://example.com'],
        allowUploads: false,
        allowDownloads: false,
        allowHumanCredentials: false,
        lifetimeMs: 60000,
        maximumFileBytes: 1000000,
      },
      fence: 1,
      acknowledgedFence: 0,
      state: 'starting',
      desiredControl: 'human',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      revoked: false,
    };
  const lease = () => ({
    workspaceId,
    token: leaseToken,
    expiresAt: frozenExpiry ?? new Date(Date.now() + 4900).toISOString(),
  });
  server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      const parts = [];
      let size = 0;
      for await (const part of request) {
        size += part.length;
        assert.ok(size <= 2100000);
        parts.push(part);
      }
      const bytes = Buffer.concat(parts);
      let reply = {};
      if (request.url === '/api/v1/bridge/browser-workspaces/capture') {
        const metadata = JSON.parse(
          Buffer.from(
            request.headers['x-allrice-browser-capture'],
            'base64url',
          ),
        );
        assert.equal(metadata.kind, 'screenshot');
        assert.equal(metadata.workspaceId, workspaceId);
        assert.equal(metadata.controllerLeaseToken, leaseToken);
        assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        captured++;
        reply = { objectId: randomUUID() };
      } else {
        const body = bytes.length ? JSON.parse(bytes) : {};
        if (request.url === '/api/v1/bridge/browser-workspaces') {
          if (body.kind === 'claim') {
            assert.equal(body.acceptPreview ?? false, false);
            assert.equal(body.acceptWork, enabled);
            if (!claimed && enabled) {
              claimed = true;
              controllerId = body.controllerId;
              reply = { workspace, lease: lease(), revocations: [] };
            } else reply = { workspace: null, lease: null, revocations: [] };
          } else {
            assert.equal(body.workspaceId, workspaceId);
            assert.equal(body.controllerLeaseToken, leaseToken);
            if (body.kind === 'heartbeat') {
              heartbeats++;
              reply = {
                lease: lease(),
                workspace: { ...workspace, revoked: revoke },
              };
            } else if (body.kind === 'next') reply = { operation: null };
            else if (body.kind === 'observation') {
              assert.equal(body.observation.url, 'about:blank');
              assert.equal(body.observation.profileId, workspace.profileId);
              reply = { ok: true };
            } else if (body.kind === 'control_ack') {
              assert.ok(captured > 0);
              assert.equal(body.fence, 1);
              assert.equal(body.state, 'human');
              acknowledged = true;
              workspace.state = 'human';
              workspace.acknowledgedFence = 1;
              reply = { ok: true };
            } else if (body.kind === 'stopped') {
              assert.equal(body.confirmed, true);
              assert.equal(body.errorCode, null);
              stopped = true;
              reply = { ok: true };
            } else throw Error('UNEXPECTED_BROWSER_REQUEST');
          }
        } else if (request.url === '/api/v1/bridge/device/commands/next')
          reply = { command: null };
        else if (
          request.url === '/api/v1/bridge/device/workspace-selections/next'
        )
          reply = { request: null };
        else if (request.url !== '/api/v1/bridge/device/heartbeat')
          throw Error('UNEXPECTED_CORE_REQUEST');
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(reply));
    } catch (error) {
      failures.push(error.code ?? 'FIXTURE_ASSERTION_FAILED');
      response.statusCode = 500;
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = JSON.stringify({
    server: `http://127.0.0.1:${server.address().port}`,
    deviceId,
    deviceName: 'B5 exact binary synthetic fixture',
    grants: [],
  });
  await writeFile(configPath, config, { flag: 'wx', mode: 0o600 });
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: temp,
    ALLRICE_BRIDGE_CONFIG_PATH: configPath,
    ALLRICE_BRIDGE_DEVICE_TOKEN: token,
    ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED: '0',
    ALLRICE_BRIDGE_WSS_ENABLED: '0',
    ALLRICE_LOCAL_COMMAND_ENABLED: '0',
  };
  const cli = (args) =>
    execFileSync(core, args, {
      env,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 100000,
    });
  let record;
  try {
    assert.equal(cli(['--version']).trim(), '0.5.0-dev.1');
    assert.equal(JSON.parse(cli(['browser', 'status'])).enabled, false);
    assert.equal(JSON.parse(cli(['preview', 'status'])).enabled, false);
    assert.equal(JSON.parse(cli(['browser', 'enable'])).enabled, true);
    enabled = true;
    child = spawn(core, ['start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.resume();
    await waitFor(async () => {
      assert.equal(child.exitCode, null, 'CORE_EARLY_EXIT');
      assert.deepEqual(failures, []);
      return acknowledged && heartbeats >= 2;
    }, 'NATIVE_CAPTURE_ACK');
    const directories = (await readdir(temp, { withFileTypes: true })).filter(
      (d) => d.isDirectory() && d.name.startsWith('allrice-browser-'),
    );
    assert.equal(directories.length, 1);
    record = JSON.parse(
      await readFile(join(temp, directories[0].name, 'process.json'), 'utf8'),
    );
    assert.equal(record.parentPid, child.pid);
    assert.equal(record.stopped, false);
    assert.equal(groupGone(record.childPid), false);
    if (mode === 'normal-stop') child.kill('SIGTERM');
    else if (mode === 'lease-expiry')
      frozenExpiry = new Date(Date.now() + 3000).toISOString();
    else if (mode === 'revoke') revoke = true;
    else throw Error('UNKNOWN_TEST_MODE');
    await waitFor(
      () => stopped && groupGone(record.childPid),
      'PHYSICAL_STOP',
      12000,
    );
    if (mode !== 'normal-stop') child.kill('SIGTERM');
    await waitFor(
      () => child.exitCode !== null || child.signalCode !== null,
      'CORE_EXIT',
      7000,
    );
    assert.equal(child.exitCode, 0);
    assert.deepEqual(failures, []);
    assert.equal(await readFile(configPath, 'utf8'), config);
    assert.equal(JSON.parse(cli(['browser', 'disable'])).enabled, false);
    enabled = false;
    assert.equal(await readFile(configPath, 'utf8'), config);
    return {
      mode,
      passed: true,
      corePid: child.pid,
      controllerId,
      captureCount: captured,
      heartbeats,
      chromeProcessGroup: record.childPid,
      physicalStopConfirmed: true,
      syntheticPairingUnchanged: true,
      errors: failures,
    };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGTERM');
      await Promise.race([exit, delay(7000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exit;
      }
    }
    if (record)
      await waitFor(
        () => groupGone(record.childPid),
        'FINAL_NATIVE_CLEANUP',
        12000,
      );
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
try {
  for (const mode of ['normal-stop', 'lease-expiry', 'revoke'])
    report.cases.push(await scenario(mode));
  report.passed = true;
} catch (error) {
  report.errors.push(error instanceof Error ? error.message : 'FAILED');
  process.exitCode = 1;
} finally {
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      passed: report.passed,
      report: join(directory, 'report.json'),
    }),
  );
}
