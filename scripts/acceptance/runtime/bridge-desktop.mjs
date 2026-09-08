/** Native P13 UI acceptance, using only a private synthetic pairing and HTTP fixture.
 * This is not production PostgreSQL/VM acceptance and never touches daily Bridge state. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'darwin');
assert.ok(process.argv[2], 'Provide the built .app path');
const app = resolve(process.argv[2]);
const fresh = process.argv.includes('--fresh');
if (fresh)
  assert.equal(
    process.env.ALLRICE_BRIDGE_TEST_KEYCHAIN,
    '1',
    'Fresh UI acceptance creates and removes one random synthetic Keychain entry; explicit test opt-in required',
  );
const freshDeviceId = randomUUID();
let pairedByFixture = false;
const root = await mkdtemp(join(tmpdir(), 'allrice-p13-ui-'));
let polls = 0;
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
          id: freshDeviceId,
          organizationId: freshDeviceId,
          workspaceId: freshDeviceId,
          ownerId: freshDeviceId,
          name: 'P13 fresh synthetic pairing',
          platform: process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64',
          protocolVersion: 2,
          capabilities: ['local.fs.read'],
          status: 'online',
          createdAt: new Date().toISOString(),
          lastSeenAt: null,
          revokedAt: null,
        },
        deviceToken: 'synthetic-p13-keychain-token-unique-to-test',
      }),
    );
  } else if (request.url.endsWith('/commands/next')) {
    polls++;
    response.end('{"command":null}');
  } else if (request.url.endsWith('/workspace-selections/next'))
    response.end('{"request":null}');
  else response.end('{}');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const config = {
  deviceId: '00000000-0000-4000-8000-000000000011',
  deviceName: 'P13 isolated UI acceptance',
  server: `http://127.0.0.1:${server.address().port}/`,
  grants: [
    {
      id: '00000000-0000-4000-8000-000000000012',
      label: 'Synthetic workspace',
      rootPath: root,
      rootFingerprint: 'a'.repeat(64),
    },
  ],
};
const path = join(root, 'config.json');
if (!fresh) await writeFile(path, JSON.stringify(config), { mode: 0o600 });
const env = {
  HOME: process.env.HOME,
  PATH: '/usr/bin:/bin',
  TMPDIR: process.env.TMPDIR,
  ALLRICE_BRIDGE_CONFIG_PATH: path,
  ...(!fresh ? { ALLRICE_BRIDGE_DEVICE_TOKEN: 'synthetic-ui-token' } : {}),
  ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED: '0',
};
const render = join(root, 'status-view-render.png');
const child = spawn(
  join(app, 'Contents/MacOS/RiceBridgeApp'),
  ['--acceptance', `--acceptance-render=${render}`],
  { env, stdio: ['ignore', 'pipe', 'pipe'] },
);
let hostOutput = '';
child.stdout.on('data', (bytes) => {
  hostOutput = (hostOutput + bytes).slice(-4096);
});
child.stderr.resume();
const ui = (statements) =>
  execFileSync(
    '/usr/bin/osascript',
    [
      '-e',
      `tell application "System Events" to tell (first application process whose unix id is ${child.pid})`,
      ...statements.flatMap((line) => ['-e', line]),
      '-e',
      'end tell',
    ],
    { encoding: 'utf8', timeout: 15000 },
  ).trim();
const menu = (item) =>
  ui([
    'click menu bar item "Rice" of menu bar 1',
    `click menu item ${JSON.stringify(item)} of menu 1 of menu bar item "Rice" of menu bar 1`,
  ]);
const status = () =>
  ui([
    'get value of text area 1 of scroll area 1 of window "Rice Bridge · 本地电脑"',
  ]);
async function wait(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await delay(100);
  }
  throw Error('native UI acceptance timed out');
}
const results = {
  architecture: process.arch,
  nativeUI: true,
  syntheticIdentityOnly: true,
  root,
  passed: false,
};
try {
  if (fresh) {
    await wait(() => status().includes('尚未配对'));
    menu('配对设备…');
    await wait(() => ui(['get count of text fields of window 1']) === '2');
    ui([
      `set value of text field 1 of window 1 to ${JSON.stringify(config.server)}`,
      'set value of text field 2 of window 1 to "ABCDEF12"',
      'click button "配对并连接" of window 1',
    ]);
    await wait(() => polls > 0);
    const paired = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(paired.deviceId, freshDeviceId);
    assert.equal(paired.journalNamespace, freshDeviceId);
    results.freshPairing = true;
    try {
      const stored = execFileSync(
        '/usr/bin/security',
        [
          'find-generic-password',
          '-s',
          'ai.traditionow.allrice.rice-bridge',
          '-a',
          freshDeviceId,
          '-w',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
      ).trim();
      assert.equal(stored, 'synthetic-p13-keychain-token-unique-to-test');
      results.credentialStore = 'keychain';
    } catch {
      assert.equal(
        (await readFile(`${path}.token`, 'utf8')).trim(),
        'synthetic-p13-keychain-token-unique-to-test',
      );
      results.credentialStore = 'private-file-fallback';
    }
    await wait(() =>
      status().includes(
        results.credentialStore === 'keychain'
          ? '凭证保存：macOS Keychain'
          : 'Keychain 不可用，使用本机 0600 私有凭证文件',
      ),
    );
    results.credentialStorageVisible = true;
  }
  await wait(() => polls > 0);
  await wait(() => status().includes('Bridge 在线'));
  results.onlineWindow = status().includes(
    fresh ? 'P13 fresh synthetic pairing' : 'Synthetic workspace',
  );
  menu('暂停并停止本地任务');
  await wait(() => status().includes('已暂停'));
  const stoppedPolls = polls;
  await delay(1200);
  assert.equal(polls, stoppedPolls);
  results.pauseStopsPolling = true;
  menu('恢复连接');
  await wait(() => polls > stoppedPolls);
  results.resume = true;
  menu('选择工作区…');
  await wait(() =>
    /取消|Cancel/.test(ui(['get name of every button of window 1'])),
  );
  const cancel = ui(['get name of every button of window 1']).includes('取消')
    ? '取消'
    : 'Cancel';
  ui([`click button ${JSON.stringify(cancel)} of window 1`]);
  results.nativePickerCanceled = true;
  menu('诊断与日志…');
  await wait(() =>
    ui(['get name of every button of window 1']).includes('关闭'),
  );
  ui(['click button "关闭" of window 1']);
  results.nativeDiagnostics = true;
  menu('查看状态…');
  await delay(500);
  await readFile(render);
  results.viewRender = render;
  const windowId = [...hostOutput.matchAll(/P13_WINDOW_ID=(\d+)/g)].at(-1)?.[1];
  if (windowId) {
    const screenshot = join(root, 'status-window.png');
    try {
      execFileSync(
        '/usr/sbin/screencapture',
        ['-x', '-l', windowId, screenshot],
        { timeout: 10000, stdio: 'pipe' },
      );
      results.screenshot = screenshot;
    } catch {
      results.windowServerCaptureUnavailable = true;
    }
  }
  if (fresh) {
    menu('撤销设备配对…');
    await wait(() =>
      ui(['get name of every button of window 1']).includes('撤销配对'),
    );
    ui(['click button "撤销配对" of window 1']);
    await wait(() => status().includes('尚未配对'));
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    results.onlineRevoke = true;
  }
  const exit = once(child, 'exit');
  menu('退出 Rice Bridge');
  const [code] = await exit;
  assert.equal(code, 0);
  results.cleanQuit = true;
  if (!fresh) {
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), config);
    results.pairingUnchanged = true;
  }
  results.passed = true;
  await writeFile(
    join(root, 'result.json'),
    JSON.stringify(results, null, 2) + '\n',
  );
  console.log(JSON.stringify(results));
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    await exit;
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (fresh && pairedByFixture) {
    // Only the random account created by this fixture; never enumerate/unlock.
    try {
      execFileSync(
        '/usr/bin/security',
        [
          'delete-generic-password',
          '-s',
          'ai.traditionow.allrice.rice-bridge',
          '-a',
          freshDeviceId,
        ],
        { stdio: 'ignore', timeout: 5000 },
      );
    } catch {
      /* Product revoke normally already removed it. */
    }
  }
}
