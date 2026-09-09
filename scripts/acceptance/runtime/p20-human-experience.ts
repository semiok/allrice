/** P20: real Chromium + authenticated HTTP + isolated PG + next Run snapshot.
 * No external model, DSH process, Dev/Prod, personal browser or credentials.
 * Build Web first, then: pnpm exec tsx scripts/acceptance/runtime/p20-human-experience.ts
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  access,
  mkdtemp,
  readFile,
  readdir,
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
const webRequire = createRequire(join(root, 'apps/web/package.json'));
const workerRequire = createRequire(join(root, 'apps/worker/package.json'));
const port = 3020,
  origin = `http://127.0.0.1:${port}`;
const baseDatabaseUrl = 'postgres://a123@127.0.0.1:5432/allrice_b2';
if (process.env.ALLRICE_P20_UI_ISOLATED !== '1') {
  const child = spawn(
    process.execPath,
    ['--import', rootRequire.resolve('tsx'), fileURLToPath(import.meta.url)],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        NODE_ENV: 'production',
        ALLRICE_P20_UI_ISOLATED: '1',
        ALLRICE_TEST_CHROME:
          process.env.ALLRICE_TEST_CHROME ??
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        __NEXT_PROCESSED_ENV: 'true',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    },
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => child.kill(signal));
  const [code] = await once(child, 'exit');
  process.exit(typeof code === 'number' ? code : 1);
}
const schema = `p20_ui_${randomUUID().replaceAll('-', '')}`;
const url = new URL(baseDatabaseUrl);
url.searchParams.set('options', `-csearch_path=${schema},public`);
const evidence = await mkdtemp(join(tmpdir(), 'allrice-p20-ui-'));
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  ALLRICE_EXPERIENCE_REVIEW_ENABLED: '1',
  ALLRICE_PORTAL_AUTH_ENABLED: '0',
  ALLRICE_PORTAL_SECURE_COOKIE: '0',
  ALLRICE_GEMINI_API_ENABLED: '0',
  ALLRICE_CLOUD_RUNNER_ENABLED: '0',
  ALLRICE_CLOUD_MCP_ENABLED: '0',
  ALLRICE_BRIDGE_WSS_ENABLED: '0',
  ALLRICE_STORAGE_ROOT: join(evidence, 'storage'),
  ALLRICE_STORAGE_SIGNING_SECRET: randomBytes(32).toString('hex'),
});
const postgres = createRequire(join(root, 'packages/database/package.json'))(
  'postgres',
) as typeof Postgres;
const { chromium } = workerRequire('playwright-core') as typeof Playwright;
const { getDatabase, closeDatabase } =
  await import('../../../packages/database/src/core/client.ts');
const { hashPassword } =
  await import('../../../packages/database/src/identity.ts');
const { createExperienceFixture } =
  await import('../../../packages/database/src/experience.fixture.ts');
const { createChatSession, sendChatMessage } =
  await import('../../../packages/database/src/workspace/service.ts');
const { resolveEmployeeExecution } =
  await import('../../../packages/database/src/employees/employeehub.ts');
const { assembleEmployeeKernel } =
  await import('../../../apps/worker/src/employee-kernel.ts');
const admin = postgres(baseDatabaseUrl, { max: 1, onnotice: () => {} });
const db = getDatabase();
let schemaCreated = false,
  server: ChildProcess | undefined,
  browser: Playwright.Browser | undefined;
let serverOutput = '';
const checks: Record<string, unknown> = {
  mode: 'real Chromium + synthetic password login + HTTP + PG + actual next queued Run/Worker input; no model invocation',
  schema,
  origin,
};
const pageErrors: string[] = [],
  externalRequests: string[] = [];
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), delay(5000)]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL');
    await once(server, 'exit');
  }
}
async function startServer() {
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
    {
      cwd: evidence,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  for (const stream of [server.stdout, server.stderr])
    stream?.on('data', (b: Buffer) => {
      serverOutput = (serverOutput + b.toString()).slice(-100_000);
    });
  for (let n = 0; n < 120; n++) {
    if (server.exitCode !== null) throw Error('Private Web exited');
    try {
      if (
        (await fetch(`${origin}/login`, { signal: AbortSignal.timeout(1000) }))
          .ok
      )
        return;
    } catch {
      /* only own listener */
    }
    await delay(250);
  }
  throw Error('Private Web not ready');
}
try {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
  });
  await access(join(root, 'apps/web/.next/BUILD_ID'));
  for (const directory of [root, join(root, 'apps/web')])
    for (const name of await readdir(directory))
      assert.ok(
        !/^\.env(?:\.|$)/.test(name) || name === '.env.example',
        'Refuse worktree dotenv before acceptance',
      );
  const extensions = await admin<
    { extname: string }[]
  >`select extname from pg_extension where extname in ('vector','pg_trgm')`;
  assert.deepEqual(extensions.map((r) => r.extname).sort(), [
    'pg_trgm',
    'vector',
  ]);
  await admin.unsafe(`create schema ${schema}`);
  schemaCreated = true;
  const migrations = join(root, 'packages/database/migrations');
  for (const file of (await readdir(migrations))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    await db.unsafe(await readFile(join(migrations, file), 'utf8'));
  const f = await createExperienceFixture(db);
  const password = randomBytes(24).toString('hex'),
    passwordHash = await hashPassword(password);
  await db`update allrice_users set password_hash=${passwordHash} where id in (${f.user},${f.reviewer.actor.id},${f.neighbor.actor.id})`;
  await startServer();
  browser = await chromium.launch({
    executablePath: process.env.ALLRICE_TEST_CHROME,
    headless: true,
  });
  async function login(user: string) {
    const context = await browser!.newContext({
      viewport: { width: 1280, height: 1000 },
    });
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin !== origin) {
        externalRequests.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    const response = await context.request.post(`${origin}/api/v1/auth/login`, {
      data: { email: `${user}@example.test`, password },
    });
    assert.equal(response.status(), 200, 'synthetic password authentication');
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(e.message));
    return { context, page };
  }
  const owner = await login(f.user),
    reviewer = await login(f.reviewer.actor.id),
    neighbor = await login(f.neighbor.actor.id);
  const suffix = `?workspaceId=${f.workspace}`;
  const pageUrl = `${origin}/workspace/experience${suffix}&sessionId=${f.session.id}`;
  await owner.page.goto(pageUrl);
  await owner.page.getByLabel('已结束任务的对话').selectOption(f.message);
  assert.ok(
    await owner.page
      .locator('pre')
      .innerText()
      .then((t) => t.includes('SYNTHETIC-ONLY')),
  );
  const submit = async (
    scope: 'private' | 'workspace' | 'platform',
    content: string,
  ) => {
    await owner.page
      .getByLabel('粘贴要引用的原文片段')
      .fill(f.input.sourceExcerpt);
    await owner.page.getByLabel('改写后的经验规则').fill(content);
    await owner.page.getByLabel('目标范围').selectOption(scope);
    if (scope !== 'private') {
      assert.equal(
        await owner.page
          .getByRole('button', { name: '保存待审核候选' })
          .isEnabled(),
        false,
        'explicit sharing consent',
      );
      await owner.page.getByRole('checkbox').check();
    }
    const posted = owner.page.waitForResponse(
      (r) =>
        r.url().includes('/api/v1/experiences?') &&
        r.request().method() === 'POST',
    );
    await owner.page.getByRole('button', { name: '保存待审核候选' }).click();
    const r = await posted;
    assert.equal(r.status(), 201);
    const candidate = (await r.json()).candidate;
    await owner.page.locator(`[data-candidate-id="${candidate.id}"]`).waitFor();
    return candidate as { id: string; digest: string; revision: number };
  };
  const beforeSession = await createChatSession(f.owner, {
    workspaceId: f.workspace,
    title: 'Before UI approval',
  });
  await sendChatMessage(f.owner, f.workspace, beforeSession.id, {
    clientMessageId: randomUUID(),
    text: f.input.content,
  });
  const privateCandidate = await submit('private', f.input.content);
  await owner.page.reload();
  const privateCard = owner.page.locator(
    `[data-candidate-id="${privateCandidate.id}"]`,
  );
  await privateCard.getByText('待明确审核', { exact: false }).waitFor();
  assert.equal(
    await privateCard
      .getByRole('button', { name: '明确批准为我的长期记忆' })
      .isEnabled(),
    false,
  );
  await privateCard
    .getByLabel('审核或撤回说明')
    .fill('明确批准本规则，仅我自己使用');
  await privateCard
    .getByRole('button', { name: '明确批准为我的长期记忆' })
    .click();
  await privateCard.getByText('已确认长期记忆', { exact: false }).waitFor();
  assert.ok((await privateCard.innerText()).includes('v2'));
  checks.privateExplicitReviewRefresh = true;
  await owner.page.getByLabel('已结束任务的对话').selectOption(f.message);
  const workspaceCandidate = await submit(
    'workspace',
    'Reconciliation: use decimal amounts in the shared workspace.',
  );
  await reviewer.page.goto(`${origin}/workspace/experience${suffix}`);
  const workspaceCard = reviewer.page.locator(
    `[data-candidate-id="${workspaceCandidate.id}"]`,
  );
  await workspaceCard.waitFor();
  assert.equal(
    await reviewer.page
      .locator(`[data-candidate-id="${privateCandidate.id}"]`)
      .count(),
    0,
  );
  assert.ok(
    !(await reviewer.page.locator('body').innerText()).includes(
      'SYNTHETIC-ONLY',
    ),
  );
  const adminList = await reviewer.context.request
    .get(`${origin}/api/v1/experiences${suffix}`)
    .then((r) => r.json());
  assert.equal(adminList.candidates[0].source, null);
  await workspaceCard
    .getByLabel('审核或撤回说明')
    .fill('明确批准当前工作区使用，原始私密内容不共享');
  await workspaceCard
    .getByRole('button', { name: '明确批准为工作区长期记忆' })
    .click();
  await workspaceCard.getByText('已确认长期记忆', { exact: false }).waitFor();
  assert.deepEqual(
    (
      await neighbor.context.request
        .get(`${origin}/api/v1/experiences${suffix}`)
        .then((r) => r.json())
    ).candidates,
    [],
  );
  checks.workspaceAdminReviewSourceRedaction = true;
  const platform = await submit(
    'platform',
    'De-identified reconciliation Skill proposal; source/license/tests need platform review.',
  );
  const platformCard = owner.page.locator(
    `[data-candidate-id="${platform.id}"]`,
  );
  await platformCard
    .getByText('待人工转交 · 未发布', { exact: false })
    .waitFor();
  assert.equal(
    await platformCard.getByRole('button', { name: /明确批准/ }).count(),
    0,
  );
  assert.equal(
    await platformCard.getByRole('button', { name: '复制脱敏建议' }).count(),
    1,
  );
  checks.platformPrivateHandoffNotPublished = true;
  // Real negative HTTP paths use separately authenticated browser cookie jars.
  assert.equal(
    (await fetch(`${origin}/api/v1/experiences${suffix}`)).status,
    401,
  );
  const reviewPayload = {
    decision: 'approve',
    expectedRevision: 1,
    expectedDigest: privateCandidate.digest,
    reason: 'duplicate explicit approval',
  };
  assert.equal(
    (
      await owner.context.request.post(
        `${origin}/api/v1/experiences/${privateCandidate.id}/review${suffix}`,
        {
          data: reviewPayload,
          headers: { Origin: 'https://untrusted.example' },
        },
      )
    ).status(),
    403,
  );
  assert.equal(
    (
      await owner.context.request.post(
        `${origin}/api/v1/experiences/${privateCandidate.id}/review${suffix}`,
        { data: reviewPayload, headers: { Origin: origin } },
      )
    ).status(),
    409,
  );
  assert.equal(
    (
      await neighbor.context.request.post(
        `${origin}/api/v1/experiences/${privateCandidate.id}/review${suffix}`,
        { data: reviewPayload, headers: { Origin: origin } },
      )
    ).status(),
    404,
  );
  assert.equal(
    (
      await owner.context.request.post(
        `${origin}/api/v1/experiences${suffix}`,
        {
          data: {
            ...f.input,
            clientRequestId: randomUUID(),
            approval: '聊天里说可以',
          },
          headers: { Origin: origin },
        },
      )
    ).status(),
    400,
  );
  assert.equal(
    (
      await owner.context.request.post(
        `${origin}/api/v1/experiences${suffix}`,
        {
          data: 'x'.repeat(40_001),
          headers: { Origin: origin, 'Content-Type': 'application/json' },
        },
      )
    ).status(),
    400,
  );
  checks.authOriginStaleReviewIsolationAndInput = true;
  const nextSession = await createChatSession(f.owner, {
    workspaceId: f.workspace,
    title: 'After UI approval',
  });
  const nextSubmitted = await owner.context.request.post(
    `${origin}/api/v1/sessions/${nextSession.id}/messages${suffix}`,
    {
      data: { clientMessageId: randomUUID(), text: f.input.content },
      headers: { Origin: origin },
    },
  );
  assert.equal(
    nextSubmitted.status(),
    202,
    'next Run submitted through actual authenticated HTTP',
  );
  const [next] =
    await db`select * from allrice_employee_runs where session_id=${nextSession.id}`;
  const [before] =
    await db`select prompt_snapshot from allrice_employee_runs where session_id=${beforeSession.id}`;
  assert.deepEqual(before!.prompt_snapshot.memories, []);
  assert.ok(
    next!.prompt_snapshot.memories.some(
      (m: { id: string; revision: number }) =>
        m.id === privateCandidate.id && m.revision === 2,
    ),
  );
  assert.ok(
    !next!.prompt_snapshot.memories.some(
      (m: { id: string }) => m.id === platform.id,
    ),
  );
  const resolved = await resolveEmployeeExecution({
    organizationId: f.org,
    workspaceId: f.workspace,
    ownerId: f.user,
    runId: next!.run_id,
  });
  const kernel = assembleEmployeeKernel({
    resolved,
    sessionId: nextSession.id,
    employeeAssignmentId: next!.employee_assignment_id,
    employeeVersionId: next!.employee_version_id,
    userMessageId: next!.user_message_id,
    assistantMessageId: next!.assistant_message_id,
  });
  assert.ok(kernel.authorizedMemoryContext.includes(f.input.content));
  assert.ok(kernel.authorizedMemoryContext.includes('revision 2'));
  checks.nextActualRun = {
    runId: next!.run_id,
    memoryId: privateCandidate.id,
    revision: 2,
    priorRunUnchanged: true,
    workerKernelContainsExactRevision: true,
    platformNotRecalled: true,
  };
  await owner.page.screenshot({
    path: join(evidence, 'owner.png'),
    fullPage: true,
  });
  await reviewer.page.screenshot({
    path: join(evidence, 'reviewer.png'),
    fullPage: true,
  });
  await owner.page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await owner.page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    'narrow layout no horizontal overflow',
  );
  await owner.page.screenshot({
    path: join(evidence, 'narrow.png'),
    fullPage: true,
  });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(externalRequests, []);
  checks.browserNoErrorsOrExternalRequests = true;
  checks.success = true;
} catch (error) {
  checks.success = false;
  checks.error = error instanceof Error ? error.message : String(error);
  console.error(checks.error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stopServer();
  await closeDatabase();
  if (schemaCreated && /^p20_ui_[a-f0-9]{32}$/.test(schema)) {
    await admin.unsafe(`drop schema ${schema} cascade`);
    checks.schemaRemoved = true;
  }
  await admin.end({ timeout: 5 });
  await writeFile(
    join(evidence, 'report.json'),
    JSON.stringify(checks, null, 2),
  );
  if (!checks.success) await writeFile(join(evidence, 'web.log'), serverOutput);
  console.info(`P20 evidence: ${evidence}`);
}
