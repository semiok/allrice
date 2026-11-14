import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  installTestChromiumProxy,
  testChromiumOptions,
  withTestNoProxy,
} from './test-proxy.mjs';

it('keeps explicit proxy routes and caller launch options unchanged', () => {
  for (const options of [
    { proxy: { server: 'http://127.0.0.1:9000', bypass: '<-loopback>' } },
    { args: ['--proxy-server=http://127.0.0.1:9000'] },
    { args: ['--proxy-pac-url=http://127.0.0.1/proxy.pac'] },
    { args: ['--proxy-auto-detect'] },
    { args: ['--proxy-bypass-list=<-loopback>'] },
  ])
    expect(testChromiumOptions(options)).toBe(options);
  const options = {
    args: ['--host-resolver-rules=MAP *.allrice.test 127.0.0.1'],
    timeout: 1234,
    executablePath: '/test/chromium',
    env: { NO_PROXY: '.existing.test', CUSTOM: 'kept' },
  };
  const before = globalThis.structuredClone(options);
  const configured = testChromiumOptions(options);
  expect(options).toEqual(before);
  expect(configured.timeout).toBe(1234);
  expect(configured.executablePath).toBe(options.executablePath);
  expect(configured.args).toContain(options.args[0]);
  expect(configured.env.CUSTOM).toBe('kept');
  expect(configured.env.NO_PROXY).toContain('.existing.test');
});

it('wraps both public launch methods with their receiver and restores them', () => {
  const calls = [];
  const chromium = {
    launch(...args) {
      calls.push({ receiver: this, args });
      return 'browser';
    },
    launchPersistentContext(...args) {
      calls.push({ receiver: this, args });
      return 'context';
    },
  };
  const original = { ...chromium };
  const restore = installTestChromiumProxy(chromium);
  expect(chromium.launch()).toBe('browser');
  expect(chromium.launchPersistentContext('/isolated-profile')).toBe('context');
  expect(calls.every((call) => call.receiver === chromium)).toBe(true);
  expect(calls[1].args[0]).toBe('/isolated-profile');
  for (const options of [calls[0].args[0], calls[1].args[1]]) {
    expect(options.args).toContain('--proxy-server=direct://');
    expect(options.args).toContain(
      '--proxy-bypass-list=*.allrice.test;allrice.test;localhost;*.localhost;127.0.0.1;[::1]',
    );
  }
  restore();
  expect(chromium).toEqual(original);
});

it('child HTTP clients bypass fixture hosts while other hosts still use their proxy', async () => {
  const hits = [];
  const fixture = createServer((req, res) => {
    hits.push(req.headers.host);
    res.end('direct fixture');
  });
  const proxy = createServer((_req, res) => res.end('explicit proxy'));
  fixture.listen(0, '127.0.0.1');
  proxy.listen(0, '127.0.0.1');
  await Promise.all([once(fixture, 'listening'), once(proxy, 'listening')]);
  const originalEnv = {
    NO_PROXY: '.upper.example',
    no_proxy: '.lower.example',
    http_proxy: 'http://127.0.0.1:' + proxy.address().port,
    HTTP_PROXY: 'http://127.0.0.1:' + proxy.address().port,
  };
  const before = { ...originalEnv };
  const env = withTestNoProxy(originalEnv);
  expect(originalEnv).toEqual(before);
  expect(env.NO_PROXY).toBe(env.no_proxy);
  expect(withTestNoProxy(env)).toEqual(env);
  expect(env.NO_PROXY).toContain('.upper.example');
  expect(env.NO_PROXY).toContain('.lower.example');
  try {
    for (const host of [
      'employee.allrice.test',
      'nested.preview.allrice.test',
      '127.0.0.1',
    ]) {
      const port = fixture.address().port;
      const result = await promisify(execFile)(
        'curl',
        [
          '--silent',
          '--show-error',
          '--fail',
          '--max-time',
          '5',
          '--resolve',
          host + ':' + port + ':127.0.0.1',
          'http://' + host + ':' + port,
        ],
        { env: { PATH: process.env.PATH, ...env } },
      );
      expect(result.stdout).toBe('direct fixture');
    }
    const result = await promisify(execFile)(
      'curl',
      [
        '--silent',
        '--show-error',
        '--fail',
        '--max-time',
        '5',
        'http://outside.invalid/',
      ],
      { env: { PATH: process.env.PATH, ...env } },
    );
    expect(result.stdout).toBe('explicit proxy');
    expect(hits).toHaveLength(3);
  } finally {
    fixture.closeAllConnections();
    proxy.closeAllConnections();
    await Promise.all(
      [fixture, proxy].map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
  }
});
