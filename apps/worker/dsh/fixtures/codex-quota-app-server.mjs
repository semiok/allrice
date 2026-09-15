/* global Buffer, setTimeout */
// Synthetic subprocess fixture. Tests prepend a shebang and a configuration;
// this file never runs a real Codex binary or opens a network connection.
import { appendFileSync, readdirSync, statSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';

/* global fixture */
function record(value) {
  appendFileSync(fixture.receipt, `${JSON.stringify(value)}\n`);
}
record({
  startup: true,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  homeMode: statSync(process.env.CODEX_HOME).mode & 0o777,
  homeFiles: readdirSync(process.env.CODEX_HOME),
});
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reader = createInterface({ input: process.stdin });
reader.on('line', (line) => {
  const message = JSON.parse(line);
  record({ request: message });
  if (message.method === 'initialize') {
    if (fixture.scenario.startsWith('remote_')) {
      const status = fixture.scenario.slice('remote_'.length);
      write({
        method: 'remoteControl/status/changed',
        ...(status === 'request' ? { id: 88 } : {}),
        params: {
          ...(status !== 'missing'
            ? { status: status === 'request' ? 'disabled' : status }
            : {}),
          installationId: 'synthetic-sensitive-installation',
          serverName: 'synthetic-sensitive-server',
        },
      });
    }
    if (fixture.scenario === 'startup_warnings') {
      write({
        method: 'configWarning',
        params: { summary: 'synthetic-sensitive-config-details' },
      });
      write({
        method: 'warning',
        params: { threadId: null, message: 'synthetic-sensitive-warning' },
      });
    }
    if (fixture.scenario === 'stall') return;
    if (fixture.scenario === 'early_exit') return process.exit(0);
    if (fixture.scenario === 'malformed') {
      process.stdout.write('not-json\n');
      return;
    }
    if (fixture.scenario === 'stdout_limit') {
      process.stdout.write('x'.repeat(300_000));
      return;
    }
    if (fixture.scenario === 'stderr_limit') {
      process.stderr.write('x'.repeat(1_100_000));
      return;
    }
    if (fixture.scenario === 'wrong_id') return write({ id: 999, result: {} });
    write({ id: message.id, result: { userAgent: 'synthetic' } });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'account/login/start') {
    if (fixture.scenario === 'auth_error') {
      process.stderr.write(message.params.accessToken);
      return write({
        id: message.id,
        error: { message: message.params.accessToken },
      });
    }
    if (fixture.scenario === 'wrong_auth')
      return write({ id: message.id, result: { type: 'apiKey' } });
    write({ id: message.id, result: { type: 'chatgptAuthTokens' } });
    write({
      method: 'account/login/completed',
      params: { loginId: null, success: fixture.scenario !== 'login_failed' },
    });
    write({
      method: 'account/updated',
      params: {
        authMode:
          fixture.scenario === 'changed_auth' ? 'chatgpt' : 'chatgptAuthTokens',
      },
    });
    return;
  }
  if (message.method === 'account/rateLimits/read') {
    if (fixture.scenario === 'unknown_method')
      return write({
        method: 'synthetic-sensitive-arbitrary-method',
        params: {},
      });
    if (fixture.scenario === 'deprecation_notice')
      return write({ method: 'deprecationNotice', params: {} });
    if (fixture.scenario === 'null_id')
      return write({ id: null, method: 'account/updated', params: {} });
    if (fixture.scenario === 'thread_warning')
      return write({
        method: 'warning',
        params: { threadId: 'unrequested-thread', message: 'must-not-ignore' },
      });
    if (fixture.scenario === 'warning_request')
      return write({ id: 57, method: 'configWarning', params: {} });
    if (fixture.scenario === 'refresh')
      return write({ id: 55, method: 'account/chatgptAuthTokens/refresh' });
    if (fixture.scenario === 'server_request')
      return write({ id: 56, method: 'command/exec', params: {} });
    if (fixture.scenario === 'unknown_notification')
      return write({ method: 'thread/started', params: {} });
    if (fixture.scenario === 'rpc_error')
      return write({
        id: message.id,
        error: { code: -1, message: 'secret-provider-diagnostic' },
      });
    const result = { id: message.id, result: fixture.result };
    if (fixture.scenario === 'fragmented') {
      const bytes = Buffer.from(`${JSON.stringify(result)}\n`);
      const unicode = bytes.indexOf(Buffer.from('额度'));
      process.stdout.write(bytes.subarray(0, unicode + 1));
      setTimeout(() => process.stdout.write(bytes.subarray(unicode + 1)), 5);
    } else write(result);
    return;
  }
  // Any implementation regression that tries a turn/model/credits/logout RPC
  // is captured as a forbidden request and cannot launch anything in tests.
  record({ forbidden: message.method });
  process.exit(2);
});
