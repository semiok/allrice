import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import {
  PsqlTestDeadlineError,
  psqlTestUrl,
  runPsqlProcess,
} from './psql-test.fixture.ts';

describe('psql test process boundaries', () => {
  it('replaces URL options with one schema/statement deadline and explicit connect timeout', () => {
    const raw = psqlTestUrl(
      'postgres://user+one:pass+two@localhost/test?options=-cstatement_timeout%3D0&connect_timeout=60',
      'isolated',
      'test-psql',
    );
    // Match libpq's percent-only URI decoder, not WHATWG form decoding.
    const options = raw
      .slice(raw.indexOf('?') + 1)
      .split('&')
      .filter((entry) => entry.startsWith('options='));
    expect(options).toHaveLength(1);
    expect(options[0]).toContain('%20');
    expect(options[0]).not.toContain('+');
    expect(decodeURIComponent(options[0]!.slice('options='.length))).toBe(
      '-csearch_path=isolated,public -cstatement_timeout=2000',
    );
    expect(raw).toContain('user+one:pass+two@');
    const url = new URL(raw);
    expect(url.searchParams.get('connect_timeout')).toBe('1');
    expect(url.searchParams.get('application_name')).toBe('test-psql');
  });

  it.each([
    ['deadline', 'fail'],
    ['abort', 'fail'],
    ['deadline', 'hang'],
  ] as const)(
    'waits for child close on %s when diagnostics %s',
    async (kind, diagnostic) => {
      const abort = new AbortController();
      let pid: number | undefined;
      let diagnosticCalls = 0;
      const work = runPsqlProcess({
        command: process.execPath,
        args: [
          '-e',
          'require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); setInterval(() => {}, 1000)',
        ],
        signal: abort.signal,
        timeoutMs: 200,
        event: (event, child) => {
          if (event === 'spawn') {
            pid = child;
            if (kind === 'abort') abort.abort();
          }
        },
        beforeStop: async () => {
          diagnosticCalls++;
          if (diagnostic === 'hang') await new Promise<void>(() => {});
          throw new Error('diagnostic unavailable');
        },
      });
      await expect(work).rejects.toMatchObject({
        reason: kind === 'deadline' ? 'process_deadline' : 'aborted',
      });
      expect(diagnosticCalls).toBe(1);
      expect(pid).toBeTypeOf('number');
      expect(() => process.kill(pid!, 0)).toThrow();
    },
  );

  it('kills descendants holding stdio after the configured parent has exited', async () => {
    let exitedSuccessfully = false;
    const abort = new AbortController();
    const work = runPsqlProcess({
      command: process.execPath,
      args: [
        '-e',
        'const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); child.unref()',
      ],
      signal: abort.signal,
      timeoutMs: 4_000,
      event: (event, _pid, status) => {
        if (event === 'exit' && status === 0) {
          exitedSuccessfully = true;
          abort.abort();
        }
      },
    });
    await expect(work).rejects.toMatchObject({ reason: 'aborted' });
    expect(exitedSuccessfully).toBe(true);
  });

  it('finishes group termination when a ready descendant ignores SIGINT and has independent stdio', async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('tcp_address_required');
    const handshake = AbortSignal.timeout(4_000);
    const accepted = once(server, 'connection', { signal: handshake });
    const childSource = `process.on('SIGINT', () => {});
      const socket = require('node:net').connect(${address.port}, '127.0.0.1');
      socket.once('connect', () => socket.write(String(process.pid) + String.fromCharCode(10)));
      setInterval(() => {}, 1000);`;
    const abort = new AbortController();
    const work = runPsqlProcess({
      command: process.execPath,
      args: [
        '-e',
        `require('node:child_process').spawn(process.execPath,
        ['-e', ${JSON.stringify(childSource)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`,
      ],
      signal: abort.signal,
      timeoutMs: 4_000,
    });
    void work.catch(() => {});
    let socket: Socket | undefined;
    let reader: ReturnType<typeof createInterface> | undefined;
    let descendant: number | undefined;
    try {
      [socket] = (await accepted) as [Socket];
      reader = createInterface({ input: socket });
      const [line] = await once(reader, 'line', { signal: handshake });
      descendant = Number(line);
      expect(Number.isSafeInteger(descendant) && descendant! > 0).toBe(true);
      // This handshake is sent only after the descendant installs its SIGINT
      // handler. Its private socket closes on death, independently of stdio.
      const closed = once(socket, 'close', {
        signal: AbortSignal.timeout(1_000),
      });
      abort.abort();
      await expect(work).rejects.toMatchObject({ reason: 'aborted' });
      await closed;
    } finally {
      abort.abort();
      await work.catch(() => {});
      if (descendant) {
        try {
          process.kill(descendant, 'SIGKILL');
        } catch {
          /* Already gone. */
        }
      }
      reader?.close();
      socket?.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it('classifies the libpq connection timeout without exposing its address', async () => {
    const work = runPsqlProcess({
      command: process.execPath,
      args: [
        '-e',
        'process.stderr.write(`psql: error: connection to server at "db.test", port 5432 failed: timeout expired`); process.exitCode=2',
      ],
      signal: new AbortController().signal,
      timeoutMs: 4_000,
    });
    await expect(work).rejects.toMatchObject({ reason: 'connect_timeout' });
    await expect(work).rejects.not.toThrow(/db\.test|5432/);
  });

  it('keeps a statement timeout separate from a SQL rejection containing the script name', async () => {
    const work = runPsqlProcess({
      command: process.execPath,
      args: [
        '-e',
        'process.stderr.write("psql:/private/schedule-recover.sql:1: ERROR: canceling statement due to statement timeout\\n"); process.exitCode=3',
      ],
      signal: new AbortController().signal,
      timeoutMs: 4_000,
    });
    await expect(work).rejects.toBeInstanceOf(PsqlTestDeadlineError);
    await expect(work).rejects.toMatchObject({ reason: 'statement_timeout' });
    await expect(work).rejects.not.toThrow(/schedule-recover|private/);
  });
});
