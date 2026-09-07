// Run only against the disposable, migrated allrice_credential_ui_test database.
// Starts a loopback production Web with synthetic auth and a temporary credential file.
/* global document, window */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(
  /\/$/,
  '',
);
const databaseUrl = new URL(process.env.ALLRICE_TEST_DATABASE_URL);
assert.equal(databaseUrl.pathname, '/allrice_credential_ui_test');
assert.ok(['localhost', '127.0.0.1'].includes(databaseUrl.hostname));
const require = createRequire(`${root}/apps/worker/package.json`);
const { chromium } = require('playwright-core');
const postgres = createRequire(`${root}/packages/database/package.json`)(
  'postgres',
);
const sql = postgres(databaseUrl.toString(), { max: 1 });
const temporary = await mkdtemp(join(tmpdir(), 'allrice-credential-ui-'));
const credentialFile = join(temporary, 'credentials.json');
const password = randomBytes(24).toString('hex');
const adminEmail = `credential-test-${randomBytes(6).toString('hex')}@example.test`;
const key = 'SYNTHETIC_GEMINI_KEY_NEVER_SENT_TO_GOOGLE';
const port = 3013;
const host = 'allrice-dsh.bplabs.xyz';
const endpoint = '/api/v1/admin/providers/gemini/credential';
let server, browser;
let serverOutput = '';
const env = {
  PATH: process.env.PATH,
  NODE_ENV: 'production',
  DATABASE_URL: databaseUrl.toString(),
  ALLRICE_ENV: 'dev',
  ALLRICE_PORTAL_AUTH_ENABLED: '1',
  ALLRICE_LOCAL_PORTAL: 'runtime-console',
  ALLRICE_PLATFORM_ADMIN_PASSWORD: password,
  ALLRICE_SNOW_PASSWORD: password,
  ALLRICE_PORTAL_SESSION_SECRET: randomBytes(32).toString('hex'),
  ALLRICE_PLATFORM_ADMIN_EMAILS: adminEmail,
  ALLRICE_PLATFORM_BOOTSTRAP_EMAIL: adminEmail,
  ALLRICE_DSH_CREDENTIALS_FILE: credentialFile,
  ALLRICE_DSH_CREDENTIALS_JSON: '',
  ALLRICE_GEMINI_API_ENABLED: '0',
  ALLRICE_RUNTIME_POLICY_ENABLED: '0',
  ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED: '0',
  ALLRICE_STORAGE_ROOT: join(temporary, 'storage'),
};

async function request(path, method = 'GET', body, cookie, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `http://127.0.0.1:${port}${path}`,
      {
        method,
        headers: {
          host,
          origin: `https://${host}`,
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
          ...extra,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.setTimeout(15000, () => req.destroy(Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}
async function start() {
  server = spawn(
    process.execPath,
    [
      `${root}/apps/web/node_modules/next/dist/bin/next`,
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: `${root}/apps/web`,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  for (const stream of [server.stdout, server.stderr])
    stream.on('data', (chunk) => {
      serverOutput += chunk.toString();
    });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw Error('Preview failed to start');
    try {
      if ((await request('/api/health/ready')).status === 200) return;
    } catch {
      /* starting */
    }
    await delay(250);
  }
  throw Error('Preview readiness timeout');
}
async function stop() {
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await exited;
  }
}

try {
  await start();
  assert.equal((await request(endpoint)).status, 401);
  const login = await request(
    '/api/v1/auth/login',
    'POST',
    JSON.stringify({ username: 'admin', password }),
  );
  assert.equal(login.status, 200);
  const actorId = JSON.parse(login.body).user.id;
  const cookie = login.headers['set-cookie']
    .map((value) => value.split(';')[0])
    .join('; ');
  const before = JSON.parse(
    (
      await request(
        '/api/v1/admin/platform-employees',
        'GET',
        undefined,
        cookie,
      )
    ).body,
  );
  const employee = before.employees[0];
  assert.ok(employee?.currentDraft);
  const contextOptions = { viewport: { width: 1440, height: 1150 } };
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.ALLRICE_TEST_CHROME ??
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const context = await browser.newContext(contextOptions);
  await context.addCookies(
    login.headers['set-cookie'].map((value) => {
      const pair = value.split(';')[0],
        index = pair.indexOf('=');
      return {
        name: pair.slice(0, index),
        value: pair.slice(index + 1),
        domain: host,
        path: '/',
        httpOnly: true,
        secure: true,
      };
    }),
  );
  await context.route('**/*', async (route) => {
    const original = route.request(),
      url = new URL(original.url());
    assert.equal(
      url.hostname,
      host,
      'No third-party requests in this acceptance',
    );
    assert.ok(
      ['GET', 'HEAD'].includes(original.method()) ||
        (url.pathname === endpoint && original.method() === 'PUT'),
      'Only synthetic credential saves may mutate',
    );
    const res = await request(
      url.pathname + url.search,
      original.method(),
      original.postData() ?? undefined,
      cookie,
    );
    const headers = Object.fromEntries(
      Object.entries(res.headers)
        .filter(
          ([name]) =>
            ![
              'transfer-encoding',
              'content-length',
              'content-encoding',
              'set-cookie',
            ].includes(name),
        )
        .map(([name, value]) => [
          name,
          Array.isArray(value) ? value.join(', ') : String(value),
        ]),
    );
    await route.fulfill({ status: res.status, headers, body: res.body });
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  async function openGemini() {
    await page.goto(`https://${host}/runtime-console?view=employees`, {
      waitUntil: 'networkidle',
    });
    await page.getByRole('button', { name: '模型', exact: true }).click();
    await page.getByLabel('Provider', { exact: true }).selectOption('gemini');
    await page.getByLabel('Gemini API Key', { exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        !document.querySelector('input[aria-label="Gemini API Key"]').disabled,
    );
  }
  await openGemini();
  const input = page.getByLabel('Gemini API Key', { exact: true });
  assert.equal(await input.getAttribute('type'), 'password');
  assert.equal(
    await page
      .getByRole('button', { name: '保存 API Key', exact: true })
      .isDisabled(),
    true,
  );
  await input.fill('short');
  await page.getByRole('button', { name: '保存 API Key', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '密钥格式不正确' }).waitFor();
  await input.fill(key);
  await page.getByRole('button', { name: '保存 API Key', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '密钥已保存' }).waitFor();
  assert.equal(await input.inputValue(), '');
  assert.equal(
    JSON.parse(await readFile(credentialFile, 'utf8'))[
      'deployment:gemini-default'
    ].apiKey,
    key,
  );
  assert.ok(!(await page.content()).includes(key));
  const status = await request(endpoint, 'GET', undefined, cookie);
  assert.equal(status.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(status.body).credential.configured, true);
  assert.ok(!status.body.includes(key));
  await stop();
  await start(); // Persistence after an actual Web restart, not just React state.
  await openGemini();
  assert.equal(await input.inputValue(), '');
  await input.fill(`${key}_REPLACED`);
  await page
    .getByRole('button', { name: '保存并替换 API Key', exact: true })
    .click();
  await page.getByRole('status').filter({ hasText: '密钥已保存' }).waitFor();
  assert.equal(
    JSON.parse(await readFile(credentialFile, 'utf8'))[
      'deployment:gemini-default'
    ].apiKey,
    `${key}_REPLACED`,
  );
  await page.screenshot({
    path: `${root}/.local/gemini-credential-settings.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page
    .getByLabel('Provider', { exact: true })
    .selectOption('openai-codex');
  assert.equal(
    await page.getByLabel('Gemini API Key', { exact: true }).count(),
    0,
  );
  assert.equal(
    (
      await request(endpoint, 'PUT', JSON.stringify({ apiKey: key }), cookie, {
        origin: 'https://attacker.example',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        endpoint,
        'PUT',
        JSON.stringify({ apiKey: key, reference: 'tenant:other' }),
        cookie,
      )
    ).status,
    400,
  );
  const tenant = await request(
    '/api/v1/auth/login',
    'POST',
    JSON.stringify({ username: 'snow', password }),
    undefined,
    { host: 'allrice-snow.bplabs.xyz' },
  );
  assert.equal(tenant.status, 200);
  const tenantCookie = tenant.headers['set-cookie']
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.equal(
    (
      await request(endpoint, 'GET', undefined, tenantCookie, {
        host: 'allrice-snow.bplabs.xyz',
      })
    ).status,
    403,
  );
  const after = JSON.parse(
    (
      await request(
        '/api/v1/admin/platform-employees',
        'GET',
        undefined,
        cookie,
      )
    ).body,
  );
  assert.equal(
    after.employees.find((item) => item.id === employee.id).currentDraft.id,
    employee.currentDraft.id,
  );
  const audit =
    await sql`select action, reason, metadata from allrice_audit_events where action like 'provider.gemini_credential.%' and actor_id=${actorId} order by occurred_at`;
  assert.equal(
    audit.filter((item) => item.action.endsWith('.saved')).length,
    2,
  );
  assert.equal(
    audit.filter((item) => item.action.endsWith('.requested')).length,
    2,
  );
  assert.ok(!JSON.stringify(audit).includes(key));
  assert.equal(
    (
      await sql`select enabled from allrice_model_providers where provider_key='gemini'`
    )[0].enabled,
    false,
  );
  assert.equal(errors.length, 0);
  assert.ok(!serverOutput.includes(key));
  console.log(
    JSON.stringify({
      passed: true,
      isolatedDatabase: true,
      keySavedAndReplaced: true,
      persistedAfterWebRestart: true,
      keyNeverReturnedOrLogged: true,
      tenantAndCsrfDenied: true,
      auditEvents: audit.length,
      employeeDraftUnchanged: true,
      geminiStillDisabled: true,
      mobileLayout: true,
      pageErrors: errors.length,
    }),
  );
} finally {
  await browser?.close();
  await stop();
  await sql.end();
  await rm(temporary, { recursive: true, force: true });
}
