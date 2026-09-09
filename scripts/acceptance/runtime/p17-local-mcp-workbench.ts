/** Private Chrome + real HTTP/PG/device journal + an actual dedicated VM MCP
 * process. Synthetic fixtures only; no model request, Dev, personal profile or
 * real credential. Build Web first, then run with pnpm exec tsx. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type * as Playwright from '../../../apps/worker/node_modules/playwright-core/index.js';
import type Postgres from '../../../packages/database/node_modules/postgres/types/index.d.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const rootRequire = createRequire(join(root, 'package.json'));
const workerRequire = createRequire(join(root, 'apps/worker/package.json'));
const webRequire = createRequire(join(root, 'apps/web/package.json'));
if (process.env.ALLRICE_P17_UI_ISOLATED !== '1') {
  const child = spawn(
    process.execPath,
    ['--import', rootRequire.resolve('tsx'), fileURLToPath(import.meta.url)],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        NODE_ENV: 'production',
        ALLRICE_P17_UI_ISOLATED: '1',
        __NEXT_PROCESSED_ENV: 'true',
        NEXT_TELEMETRY_DISABLED: '1',
        ALLRICE_TEST_CHROME:
          process.env.ALLRICE_TEST_CHROME ??
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ALLRICE_P17_TEST_SOCKET:
          process.env.ALLRICE_P17_TEST_SOCKET ??
          '/Users/a123/.colima/allrice-b2/docker.sock',
      },
    },
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => child.kill(signal));
  const [code] = await once(child, 'exit');
  process.exit(typeof code === 'number' ? code : 1);
}
const port = 3017,
  origin = `http://127.0.0.1:${port}`,
  base = 'postgres://a123@127.0.0.1:5432/allrice_b2';
const schema = `p17_ui_${randomUUID().replaceAll('-', '')}`,
  url = new URL(base);
url.searchParams.set('options', `-csearch_path=${schema},public`);
const temporary = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-p17-ui-')),
  ),
  workspaceRoot = join(temporary, 'workspace');
await mkdir(workspaceRoot);
await mkdir(join(temporary, 'evidence'));
await mkdir(join(temporary, 'private'), { mode: 0o700 });
Object.assign(process.env, {
  ALLRICE_BRIDGE_CONFIG_PATH: join(temporary, 'private', 'config.json'),
  DATABASE_URL: url.toString(),
  ALLRICE_LOCAL_MCP_ENABLED: '1',
  ALLRICE_LOCAL_COMMAND_ENABLED: '1',
  ALLRICE_RUNTIME_POLICY_ENABLED: '1',
  ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED: '1',
  ALLRICE_WORKBENCH_ENABLED: '1',
  ALLRICE_CLOUD_MCP_ENABLED: '0',
  ALLRICE_CLOUD_RUNNER_ENABLED: '0',
  ALLRICE_BRIDGE_WSS_ENABLED: '0',
  ALLRICE_PORTAL_AUTH_ENABLED: '1',
  ALLRICE_LOCAL_PORTAL: 'snow',
  ALLRICE_PORTAL_SESSION_SECRET: randomBytes(32).toString('hex'),
  ALLRICE_PORTAL_SECURE_COOKIE: '0',
  ALLRICE_GEMINI_API_ENABLED: '0',
  ALLRICE_STORAGE_ROOT: join(temporary, 'storage'),
  ALLRICE_STORAGE_SIGNING_SECRET: randomBytes(32).toString('hex'),
});
const postgres = createRequire(join(root, 'packages/database/package.json'))(
  'postgres',
) as typeof Postgres;
const { chromium } = workerRequire('playwright-core') as typeof Playwright;
const { getDatabase, closeDatabase } =
  await import('../../../packages/database/src/core/client.ts');
const { createSession } =
  await import('../../../packages/database/src/identity.ts');
const { createLocalMcpExecutionFixture, localMcpFixtureTool } =
  await import('../../../packages/database/src/local-mcp.fixture.ts');
const { createPortalSession } =
  await import('../../../apps/web/lib/portal/session.ts');
const { resolvePortal } =
  await import('../../../apps/web/lib/portal/config.ts');
const { BridgeJournal } =
  await import('../../../apps/rice-bridge/src/journal.ts');
const { RuntimeBridgeOperationClient } =
  await import('../../../apps/rice-bridge/src/operation-client.ts');
const { LocalCommandRunner } =
  await import('../../../apps/rice-bridge/src/local-command-runner.ts');
const { localCommandToolchainImageV1 } =
  await import('../../../packages/contracts/src/index.ts');
const { runtimePolicyDigest } =
  await import('../../../packages/database/src/runtime-policy.ts');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const source = `import readline from 'node:readline';
const reply=(q,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);
if(q.method==='initialize')reply(q,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'owned-p17',version:'1'}});
else if(q.method==='tools/list')reply(q,{tools:[${JSON.stringify(localMcpFixtureTool)}]});
else if(q.method==='tools/call')reply(q,{content:[{type:'text',text:'synthetic-rows:3'}]});});`;
await writeFile(join(workspaceRoot, 'server.mjs'), source, { mode: 0o600 });
const sourceFields = {
  name: 'owned-p17',
  version: '1.0.0',
  entrypoint: 'server.mjs',
  files: [{ path: 'server.mjs', sha256: `sha256:${hash(source)}` }],
};
const configuration = {
  path: '.',
  source: { ...sourceFields, digest: runtimePolicyDigest(sourceFields) },
  credential: null,
};
const token = `synthetic-p17-${randomUUID()}`,
  admin = postgres(base, { max: 1, onnotice: () => {} }),
  db = getDatabase();
let server: ChildProcess | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
  journal: InstanceType<typeof BridgeJournal> | undefined,
  schemaCreated = false;
let output = '';
const pageErrors: string[] = [];
const checks: Record<string, unknown> = {
  scope:
    'private Chrome + authenticated HTTP + PG + real Bridge SQLite and dedicated Intel VM; no model/provider call',
  schema,
  origin,
};
async function actor(userId: string, org: string, workspace: string) {
  const session = await createSession(userId),
    context = await browser!.newContext({
      viewport: { width: 1440, height: 1000 },
    });
  await context.addCookies([
    {
      name: 'allrice_session',
      value: session.token,
      url: origin,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
    {
      name: 'allrice_portal_session',
      value: createPortalSession({
        portal: resolvePortal('allrice-snow.bplabs.xyz')!,
        subject: userId,
        organizationId: org,
        workspaceId: workspace,
      }).value,
      url: origin,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.origin === origin || ['data:', 'blob:'].includes(u.protocol))
      await route.continue();
    else await route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => pageErrors.push(e.message));
  return { page, context };
}
async function waitFor(check: () => Promise<boolean>, description: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(150);
  }
  throw Error(`Timed out: ${description}`);
}
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), delay(5000)]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL');
    await once(server, 'exit');
  }
}
try {
  const probe = createServer();
  probe.listen(port, '127.0.0.1');
  await once(probe, 'listening');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  await admin.unsafe(`create schema "${schema}"`);
  schemaCreated = true;
  for (const file of (await readdir(join(root, 'packages/database/migrations')))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    await db.unsafe(
      await readFile(join(root, 'packages/database/migrations', file), 'utf8'),
    );
  const f = await createLocalMcpExecutionFixture(db, {
    bind: false,
    rootFingerprint: hash(workspaceRoot),
    configuration,
    deviceTokenHash: hash(token),
  });
  server = spawn(
    process.execPath,
    [
      webRequire.resolve('next/dist/bin/next'),
      'start',
      join(root, 'apps/web'),
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  server.stdout?.on('data', (b) => (output += b.toString()));
  server.stderr?.on('data', (b) => (output += b.toString()));
  await waitFor(async () => {
    if (server!.exitCode !== null) throw Error(output);
    try {
      return (await fetch(`${origin}/login`)).status < 500;
    } catch {
      return false;
    }
  }, 'private Web ready');
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ALLRICE_TEST_CHROME,
  });
  const { page, context } = await actor(f.user, f.org, f.workspace);
  await page.goto(`${origin}/workspace/mcp`);
  const panel = page.getByRole('region', { name: '本地 MCP 连接' });
  const initial = await context.request.get(
    `${origin}/api/v1/admin/local-mcp?workspaceId=${f.workspace}`,
  );
  checks.initial = { status: initial.status(), body: await initial.json() };
  assert.equal(initial.status(), 200, JSON.stringify(checks.initial));
  await panel.getByText('P17 local MCP · r1', { exact: true }).waitFor();
  assert.equal(
    (
      await context.request.get(
        `${origin}/api/v1/admin/local-mcp?workspaceId=${f.workspace}`,
      )
    ).status(),
    200,
  );
  await panel
    .getByLabel('绑定员工版本 P17 local MCP', { exact: true })
    .selectOption(f.version);
  const bound = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/v1/admin/local-mcp') &&
      r.request().method() === 'PATCH',
  );
  await panel
    .getByRole('button', {
      name: '绑定此版本（不授予工具调用权）',
      exact: true,
    })
    .click();
  assert.equal((await bound).status(), 200);
  await page.reload();
  await panel
    .getByRole('button', { name: '撤销员工绑定', exact: true })
    .waitFor();
  checks.employeeBindingPersisted = true;
  // A real UI registration is configuration only: it must not dispatch code.
  await panel
    .getByLabel('连接名称', { exact: true })
    .fill('P17 UI registration');
  await panel.getByLabel('执行设备', { exact: true }).selectOption(f.device.id);
  await panel.getByLabel('授权目录', { exact: true }).selectOption(f.grant);
  await panel
    .getByLabel('固定来源与完整文件校验和 JSON', { exact: true })
    .fill(JSON.stringify(sourceFields));
  const registered = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/v1/admin/local-mcp') &&
      r.request().method() === 'POST',
  );
  await panel
    .getByRole('button', { name: '登记本地连接', exact: true })
    .click();
  assert.equal((await registered).status(), 201);
  await panel.getByText('P17 UI registration · r1', { exact: true }).waitFor();
  assert.equal((await db`select id from allrice_runtime_operations`).length, 0);
  checks.registrationDoesNotStart = true;
  await page.screenshot({
    path: join(temporary, 'evidence', '01-settings.png'),
    fullPage: true,
  });
  const run = await f.newRun(),
    operation = await run.create(),
    id = operation.snapshot.binding.attempt.operationId;
  const strangerId = randomUUID();
  await db`insert into allrice_users(id,email,display_name,password_hash) values(${strangerId},${`${strangerId}@example.test`},'P17 other admin','not-login')`;
  await db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${f.org},${f.workspace},${strangerId},'admin')`;
  const stranger = await actor(strangerId, f.org, f.workspace),
    ops = `${origin}/api/v1/runtime/local-mcp?workspaceId=${f.workspace}&runId=${run.run}`;
  assert.deepEqual(
    (
      await (
        await stranger.context.request.get(
          `${origin}/api/v1/admin/local-mcp?workspaceId=${f.workspace}`,
        )
      ).json()
    ).connections,
    [],
  );
  assert.equal((await stranger.context.request.get(ops)).status(), 403);
  checks.ownerIsolation = true;
  await page.goto(`${origin}/chatflow?session=${f.session}`);
  const card = page.locator(`#operation-${id}`);
  await card
    .getByRole('button', { name: '批准这一次启动发现', exact: true })
    .waitFor();
  await page.reload();
  await card
    .getByRole('button', { name: '批准这一次启动发现', exact: true })
    .waitFor();
  assert.match(await card.innerText(), /无网络/);
  await page.screenshot({
    path: join(temporary, 'evidence', '02-discover-approval.png'),
    fullPage: true,
  });
  const runner = new LocalCommandRunner({
    socketPath: process.env.ALLRICE_P17_TEST_SOCKET!,
    imageDigest: localCommandToolchainImageV1,
  });
  const profile = await runner.preflight();
  assert(profile.features.includes('local_mcp'));
  journal = await BridgeJournal.open({
    directory: join(temporary, 'journal'),
    server: origin,
    deviceId: f.device.id,
  });
  const client = new RuntimeBridgeOperationClient({
    config: {
      server: origin,
      deviceId: f.device.id,
      deviceName: f.device.name,
      grants: [
        {
          id: f.grant,
          label: 'P17 source',
          rootPath: workspaceRoot,
          rootFingerprint: hash(workspaceRoot),
        },
      ],
    },
    token,
    journal,
    runner,
  });
  async function refreshDevice() {
    await db`update allrice_bridge_devices set last_seen_at=clock_timestamp() where id=${f.device.id}`;
    await db`update allrice_bridge_runtime_profiles set reported_at=clock_timestamp() where device_id=${f.device.id}`;
  }
  await refreshDevice();
  assert.equal(await client.pollOnce(), false); // approval was not granted
  assert.equal((await journal.unknownLocalMcpOperations()).length, 0);
  await card
    .getByRole('button', { name: '批准这一次启动发现', exact: true })
    .click();
  await waitFor(async () => {
    const [approved] =
      await db`select id from allrice_approval_requests where resource_id=${id} and status='approved'`;
    return Boolean(approved);
  }, 'discovery approved');
  assert.equal(await client.pollOnce(), true);
  await client.flush();
  checks.discoveryReceipts = await journal.pending();
  checks.discoverySnapshot = await operation.ledger.readOperation(
    operation.snapshot.binding.task.scope,
    id,
  );
  assert.equal(
    (
      await operation.ledger.readOperation(
        operation.snapshot.binding.task.scope,
        id,
      )
    ).status,
    'succeeded',
  );
  await f.store.acceptDiscovery(id);
  checks.realDiscovery = {
    operationId: id,
    tools: (await f.store.list(f.context, f.workspace)).find(
      (connection) => connection.id === f.connection.id,
    )?.tools.length,
  };
  await page.goto(`${origin}/workspace/mcp`);
  await panel.getByRole('button', { name: '授权此工具', exact: true }).click();
  await panel
    .getByRole('button', { name: '撤销工具授权', exact: true })
    .waitFor();
  assert.equal(run.snapshot.schemaVersion, 2);
  assert.equal(run.snapshot.localMcp!.tools.length, 0);
  const next = await f.newRun();
  assert.equal(next.snapshot.schemaVersion, 2);
  assert.equal(next.snapshot.localMcp!.tools.length, 1);
  checks.nextRunFrozenTool = true;
  const call = await next.create('local.mcp.call'),
    callId = call.snapshot.binding.attempt.operationId;
  await page.goto(`${origin}/chatflow?session=${f.session}`);
  const callCard = page.locator(`#operation-${callId}`);
  await callCard
    .getByRole('button', { name: '批准这一次调用', exact: true })
    .click();
  await waitFor(
    async () =>
      Boolean(
        (
          await db`select id from allrice_approval_requests where resource_id=${callId} and status='approved'`
        )[0],
      ),
    'call approved',
  );
  await refreshDevice();
  assert.equal(await client.pollOnce(), true);
  await client.flush();
  assert.equal(
    (await call.ledger.readOperation(call.snapshot.binding.task.scope, callId))
      .status,
    'succeeded',
  );
  await page.reload();
  await callCard.getByText('已返回并停止进程', { exact: true }).waitFor();
  await callCard.getByText('执行结果与停止证据', { exact: true }).click();
  assert.match(await callCard.innerText(), /synthetic-rows:3/);
  await page.screenshot({
    path: join(temporary, 'evidence', '03-real-call.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(temporary, 'evidence', '04-narrow.png'),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
    true,
  );
  checks.realToolCall = {
    operationId: callId,
    output: 'synthetic-rows:3',
    confirmedStopped: true,
  };
  // Revoke via UI and show that the current frozen grant cannot be reused.
  await page.goto(`${origin}/workspace/mcp`);
  await panel
    .getByRole('button', { name: '撤销工具授权', exact: true })
    .click();
  await panel
    .getByRole('button', { name: '授权此工具', exact: true })
    .waitFor();
  await assert.rejects(() => next.create('local.mcp.call', randomUUID()));
  checks.revocationInvalidatesOldRun = true;
  assert.equal(
    await readFile(join(workspaceRoot, 'server.mjs'), 'utf8'),
    source,
  );
  checks.sourceUnchanged = true;
  assert.deepEqual(pageErrors, []);
  checks.pageErrors = pageErrors;
  checks.passed = true;
} catch (error) {
  checks.passed = false;
  checks.pageErrors = pageErrors;
  checks.pages = await Promise.all(
    (browser?.contexts() ?? [])
      .flatMap((c) => c.pages())
      .map(async (p, i) => {
        await p
          .screenshot({
            path: join(temporary, 'evidence', `failure-${i}.png`),
            fullPage: true,
          })
          .catch(() => {});
        return {
          url: p.url(),
          text: (
            await p
              .locator('body')
              .innerText()
              .catch(() => '')
          ).slice(0, 6000),
        };
      }),
  );
  checks.error = error instanceof Error ? error.stack : String(error);
  await writeFile(join(temporary, 'web.log'), output);
  throw error;
} finally {
  await browser?.close();
  await stop();
  await journal?.close();
  await closeDatabase();
  if (schemaCreated) await admin.unsafe(`drop schema "${schema}" cascade`);
  await admin.end();
  await writeFile(
    join(temporary, 'report.json'),
    JSON.stringify(checks, null, 2),
  );
  console.log(
    JSON.stringify({
      report: join(temporary, 'report.json'),
      passed: checks.passed,
    }),
  );
}
