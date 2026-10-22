/** Exact shipped SEA + native PTY acceptance with an isolated localhost cloud.
 * The fixture replaces account authorization only; real Dev authorization and
 * browser acceptance remain separate gates. It never pairs or changes a daily
 * Bridge, Keychain, VM, browser profile or user-granted folder. Bundle this
 * script with the locked ws package for a dependency-free ARM/Intel transfer. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';

const maximumFrame = 750_000;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  assert.equal(process.platform, 'darwin');
  const [binaryArgument, expectedSha, expectedVersion] = process.argv.slice(2);
  assert.ok(
    binaryArgument &&
      /^[a-f0-9]{64}$/.test(expectedSha ?? '') &&
      expectedVersion,
    'Provide core path, expected SHA-256 and version',
  );
  const binary = await realpath(resolve(binaryArgument));
  assert.equal(digest(await readFile(binary)), expectedSha);
  assert.deepEqual(
    execFileSync('/usr/bin/lipo', ['-archs', binary], { encoding: 'utf8' })
      .trim()
      .split(/\s+/),
    [process.arch === 'x64' ? 'x86_64' : process.arch],
  );
  assert.equal(
    execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(),
    expectedVersion,
  );
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-terminal-sea-')),
  );
  const checks = [];
  const frames = [];
  const sockets = new Set();
  let currentSocket;
  let child;
  let childExit;
  let diagnostics = '';
  let advertised = false;
  let authorizations = 0;
  let forcedExit = false;
  const token = 'synthetic-localhost-terminal-token';
  const target = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    loginSessionId: randomUUID(),
    sessionId: randomUUID(),
    deviceId: randomUUID(),
    grantId: randomUUID(),
    grantVersion: 1,
    label: 'Isolated terminal acceptance',
    rootFingerprint: digest(root),
  };
  const report = {
    passed: false,
    architecture: process.arch,
    version: expectedVersion,
    coreSha256: expectedSha,
    syntheticIdentityOnly: true,
    streamMode: 'push',
    perFrameReadCreditsSent: 0,
    realDevAuthorization: 'separate gate',
    checks,
    forcedExit: false,
  };
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      assert.equal(request.headers.cookie, undefined);
      assert.equal(request.headers.origin, undefined);
      let text = '';
      for await (const chunk of request) {
        text += chunk;
        assert.ok(text.length <= 1_000_000);
      }
      const body = text ? JSON.parse(text) : {};
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/v1/bridge/device/terminals/authorize') {
        assert.deepEqual(body.target, target);
        authorizations++;
        response.end(JSON.stringify({ target, deviceName: 'Isolated Mac' }));
      } else if (request.url === '/api/v1/bridge/device/heartbeat') {
        advertised ||= body.environment?.humanTerminalVersion === 2;
        response.end('{}');
      } else if (request.url?.endsWith('/runtime-profile'))
        response.end(JSON.stringify({ profile: body }));
      else
        response.end(
          JSON.stringify({
            dispatch: null,
            command: null,
            request: null,
            rules: [],
          }),
        );
    })().catch((error) => {
      diagnostics = `${diagnostics}\nfixture: ${error.message}`.slice(-32_768);
      response.writeHead(500).end('{}');
    });
  });
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: maximumFrame,
    handleProtocols: (protocols) =>
      protocols.has('allrice.bridge.v1') ? 'allrice.bridge.v1' : false,
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    if (
      request.url !== '/api/v1/bridge/socket' ||
      request.headers.authorization !== `Bearer ${token}`
    )
      return socket.destroy();
    wss.handleUpgrade(request, socket, head, (ws) => {
      currentSocket = ws;
      ws.send(
        JSON.stringify({
          version: 1,
          type: 'welcome',
          deviceId: target.deviceId,
          connectionId: randomUUID(),
          epoch: String(frames.length + 1),
          heartbeatMs: 1000,
          maximumFrameBytes: maximumFrame,
        }),
      );
      ws.on('message', (bytes, binaryFrame) => {
        assert.equal(binaryFrame, false);
        assert.ok(bytes.length <= maximumFrame);
        const frame = JSON.parse(bytes.toString());
        if (frame.type === 'request')
          ws.send(
            JSON.stringify({
              version: 1,
              type: 'response',
              id: frame.id,
              status: 200,
              body: { dispatch: null },
            }),
          );
        else {
          assert.ok(frame.type?.startsWith('terminal.'));
          frames.push(frame);
        }
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = {
    server: `http://127.0.0.1:${server.address().port}`,
    deviceId: target.deviceId,
    deviceName: 'Isolated terminal acceptance',
    grants: [
      {
        id: target.grantId,
        label: target.label,
        rootPath: root,
        rootFingerprint: target.rootFingerprint,
      },
    ],
  };
  const configPath = join(root, 'config.json');
  const configBytes = JSON.stringify(config);
  await writeFile(configPath, configBytes, { mode: 0o600 });
  await writeFile(
    `${configPath}.sandbox.json`,
    JSON.stringify({
      version: 1,
      enabled: false,
      deviceId: config.deviceId,
      server: config.server,
    }),
    { mode: 0o600 },
  );
  await mkdir(`${configPath}.browser-settings`, { mode: 0o700 });
  await writeFile(
    join(`${configPath}.browser-settings`, 'opt-in.json'),
    JSON.stringify({
      version: 1,
      enabled: false,
      deviceId: config.deviceId,
      server: config.server,
    }),
    { mode: 0o600 },
  );
  await mkdir(`${configPath}.capability-settings`, { mode: 0o700 });
  await writeFile(
    join(`${configPath}.capability-settings`, 'settings.json'),
    JSON.stringify({
      deviceId: config.deviceId,
      server: config.server,
      command: {
        revision: 1,
        settings: {
          localBrowser: false,
          localCommand: false,
          development: false,
        },
      },
    }),
    { mode: 0o600 },
  );
  async function wait(read, accept, name, milliseconds = 10_000) {
    const deadline = performance.now() + milliseconds;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      assert.ok(
        child?.exitCode === null && child?.signalCode === null,
        `Core exited during ${name}: ${diagnostics}`,
      );
      assert.ok(
        performance.now() < deadline,
        `Timed out ${name}: ${diagnostics}`,
      );
      await delay(10);
    }
  }
  const send = (frame) => {
    assert.notEqual(
      frame.type,
      'terminal.next',
      'Native push acceptance must not send per-frame read credits',
    );
    currentSocket.send(JSON.stringify(frame));
  };
  async function open() {
    const id = randomUUID();
    send({ version: 1, type: 'terminal.open', id, target, streamMode: 'push' });
    await wait(
      () =>
        frames.find(
          (frame) =>
            frame.id === id &&
            ['terminal.ready', 'terminal.ended'].includes(frame.type),
        ),
      (value) => Boolean(value),
      'terminal open',
    );
    assert.equal(
      frames.find((frame) => frame.id === id).type,
      'terminal.ready',
    );
    return id;
  }
  async function rpc(id, action, args = {}) {
    const requestId = randomUUID();
    send({ version: 1, type: 'terminal.request', id, requestId, action, args });
    const frame = await wait(
      () =>
        frames.find(
          (frame) =>
            frame.type === 'terminal.result' && frame.requestId === requestId,
        ),
      Boolean,
      action,
    );
    return frame.result;
  }
  async function create(id, terminalId) {
    const shells = await rpc(id, 'shells');
    assert.ok(shells.ok, JSON.stringify(shells));
    const shell = shells.value.find((item) => item.name === 'zsh');
    assert.ok(shell, 'System zsh not discovered');
    const created = await rpc(id, 'create', {
      request: { id: terminalId, cols: 100, rows: 30, shellPath: shell.path },
    });
    assert.ok(created.ok, JSON.stringify(created));
    return created.value;
  }
  function attach(id, terminalId) {
    const requestId = randomUUID();
    let cursor = frames.length;
    let sequence = 0;
    let output = '';
    send({
      version: 1,
      type: 'terminal.request',
      id,
      requestId,
      action: 'attach',
      args: { id: terminalId },
    });
    return {
      input(data) {
        send({
          version: 1,
          type: 'terminal.input',
          id,
          requestId,
          input: { type: 'write', sequence: ++sequence, data },
        });
        return sequence;
      },
      async next() {
        let frame = await wait(
          () =>
            frames.slice(cursor).find((value) => value.requestId === requestId),
          Boolean,
          'native pushed stream frame',
        );
        if (frame.type === 'terminal.fragment') {
          const parts = await wait(
            () =>
              frames
                .slice(cursor)
                .filter(
                  (value) =>
                    value.type === 'terminal.fragment' &&
                    value.requestId === requestId,
                ),
            (values) => values.length === frame.total,
            'snapshot parts',
          );
          cursor = frames.lastIndexOf(parts.at(-1)) + 1;
          frame = {
            type: 'terminal.frame',
            frame: JSON.parse(parts.map((part) => part.data).join('')),
          };
        } else cursor = frames.indexOf(frame) + 1;
        assert.equal(frame.type, 'terminal.frame', JSON.stringify(frame));
        if (frame.frame.type === 'output') output += frame.frame.data;
        return frame.frame;
      },
      async acknowledgement(number) {
        for (;;) {
          const frame = await this.next();
          if (frame.type === 'ack' && frame.sequence === number) {
            assert.equal(frame.refusal, undefined);
            return;
          }
        }
      },
      async contains(text) {
        while (!output.includes(text)) await this.next();
      },
    };
  }
  async function exitWithin(milliseconds) {
    let timer;
    try {
      return await Promise.race([
        childExit,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    child = spawn(binary, ['start'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'en_US.UTF-8',
        ZDOTDIR: root,
        ALLRICE_BRIDGE_CONFIG_PATH: configPath,
        ALLRICE_BRIDGE_DEVICE_TOKEN: token,
        ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED: '1',
        ALLRICE_BRIDGE_WSS_ENABLED: '1',
      },
    });
    childExit = once(child, 'exit');
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (bytes) => {
        diagnostics = (diagnostics + bytes).slice(-32_768);
      });
    await wait(
      () => advertised && currentSocket?.readyState === 1,
      Boolean,
      'native capability and authenticated WSS',
      45_000,
    );
    checks.push(
      'exact SEA loaded fixed native runtime and advertised humanTerminalVersion=2',
    );
    let channel = await open();
    const terminalId = randomUUID();
    assert.equal((await create(channel, terminalId)).cwd, root);
    await writeFile(join(root, 'completion-proof'), '');
    let terminal = attach(channel, terminalId);
    assert.equal((await terminal.next()).type, 'snapshot');
    await terminal.acknowledgement(
      terminal.input(
        "test -t 0 && printf 'TTY_PROOF\\n'; printf 'TOKEN:%s\\n' ${ALLRICE_BRIDGE_DEVICE_TOKEN-unset}\r",
      ),
    );
    await terminal.contains('TTY_PROOF\r\n');
    await terminal.contains('TOKEN:unset\r\n');
    checks.push('real PTY TTY, raw output, ordered ACK and credential scrub');
    await terminal.acknowledgement(terminal.input('cat completion-\t\r'));
    await terminal.acknowledgement(terminal.input("printf 'TAB_PROOF\\n'\r"));
    await terminal.contains('completion-proof');
    await terminal.contains('TAB_PROOF\r\n');
    checks.push('native Tab completion');
    await terminal.acknowledgement(terminal.input('sleep 60\r'));
    await delay(150);
    await terminal.acknowledgement(terminal.input('\u0003'));
    await terminal.acknowledgement(
      terminal.input("printf 'INTERRUPT_PROOF\\n'\r"),
    );
    await terminal.contains('INTERRUPT_PROOF\r\n');
    checks.push('raw Ctrl+C interrupts the foreground job and shell continues');
    await terminal.acknowledgement(terminal.input('printf x >> counter\r'));
    await wait(
      () => readFile(join(root, 'counter'), 'utf8').catch(() => ''),
      (value) => value === 'x',
      'one side effect before disconnect',
    );
    const oldSocket = currentSocket;
    oldSocket.terminate();
    await wait(
      () => currentSocket !== oldSocket && currentSocket?.readyState === 1,
      Boolean,
      'idle physical Bridge WSS recovery',
    );
    channel = await open();
    assert.ok(
      (await rpc(channel, 'list')).value.some(
        (item) => item.id === terminalId && item.state === 'running',
      ),
    );
    terminal = attach(channel, terminalId);
    assert.equal((await terminal.next()).type, 'snapshot');
    assert.equal(await readFile(join(root, 'counter'), 'utf8'), 'x');
    checks.push(
      'idle physical WSS reconnect retains native PTY without replaying input',
    );
    send({ version: 1, type: 'terminal.end', id: channel });
    await wait(
      () =>
        frames.find(
          (frame) => frame.type === 'terminal.ended' && frame.id === channel,
        ),
      Boolean,
      'detach',
    );
    channel = await open();
    assert.ok(
      (await rpc(channel, 'list')).value.some(
        (item) => item.id === terminalId && item.state === 'running',
      ),
    );
    terminal = attach(channel, terminalId);
    assert.equal((await terminal.next()).type, 'snapshot');
    assert.ok((await rpc(channel, 'close', { id: terminalId })).ok);
    send({ version: 1, type: 'terminal.end', id: channel });
    await wait(
      () =>
        frames.find(
          (frame) => frame.type === 'terminal.ended' && frame.id === channel,
        ),
      Boolean,
      'closed owner detach',
    );
    channel = await open();
    const delayed = await rpc(channel, 'create', {
      request: { id: terminalId, cols: 100, rows: 30 },
    });
    assert.equal(delayed.ok, false);
    assert.equal(delayed.error.code, 'terminal/unavailable');
    checks.push(
      'detach/reconnect restores screen; closed identity stays closed after reconnect',
    );
    const finalId = randomUUID();
    await create(channel, finalId);
    terminal = attach(channel, finalId);
    await terminal.next();
    await terminal.acknowledgement(
      terminal.input("sleep 60 & printf '%s' $! > background.pid\r"),
    );
    const pid = Number(
      await wait(
        () => readFile(join(root, 'background.pid'), 'utf8').catch(() => ''),
        (value) => /^\d+$/.test(value),
        'owned background PID',
      ),
    );
    process.kill(pid, 0);
    child.kill('SIGTERM');
    const ended = await exitWithin(15_000);
    assert.ok(ended, 'Bridge did not confirm shutdown');
    assert.equal(ended[0], 0, diagnostics);
    const deadline = performance.now() + 5_000;
    while (true) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      assert.ok(
        performance.now() < deadline,
        'Owned background process survived Bridge stop',
      );
      await delay(10);
    }
    assert.equal(await readFile(configPath, 'utf8'), configBytes);
    checks.push(
      'Bridge stop awaits all native terminal process-range cleanup; synthetic pairing/grant unchanged',
    );
    assert.ok(authorizations > 0);
    report.authorizations = authorizations;
    report.passed = true;
  } catch (error) {
    report.error = error.message;
    report.diagnostics = diagnostics;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exitWithin(5_000);
      if (child.exitCode === null && child.signalCode === null) {
        forcedExit = true;
        child.kill('SIGKILL');
        await childExit;
      }
    }
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    report.forcedExit = forcedExit;
    if (report.passed && !forcedExit)
      await rm(root, { recursive: true, force: true });
    else {
      report.passed = false;
      report.preservedEvidence = root;
      await writeFile(
        join(root, 'terminal-acceptance-failed.json'),
        JSON.stringify(report, null, 2) + '\n',
      );
    }
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}

void main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
