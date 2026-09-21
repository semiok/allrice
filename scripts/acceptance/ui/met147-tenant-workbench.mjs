/* global document, location, innerWidth */
/** Live tenant HTTP/UI acceptance, not a mocked server or seeded result.
 * Default is read-only (apart from login/logout). --submit-research sends one
 * new task; --resume observes its existing receipt and NEVER resubmits it.
 * Supply a private empty evidence directory. No credentials/cookies are saved.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  RunSnapshotSchema,
  WorkbenchArtifactSchema,
  WorkspaceReadinessSchema,
  isTerminalRunStatus,
} from '../../../packages/contracts/dist/index.js';

const mode = process.argv[2] ?? '--inspect';
assert.ok(['--inspect', '--submit-research', '--resume'].includes(mode));
assert.ok(process.argv.length <= 3, 'Unexpected arguments');
const required = (key) => {
  assert.ok(process.env[key], `${key} required`);
  return process.env[key];
};
const base = new URL(required('ALLRICE_ACCEPTANCE_BASE_URL'));
assert.ok(
  base.protocol === 'https:' ||
    (base.protocol === 'http:' &&
      ['127.0.0.1', 'localhost'].includes(base.hostname)),
);
assert.equal(base.pathname, '/');
assert.equal(base.username + base.password + base.search + base.hash, '');
const sha = required('ALLRICE_ACCEPTANCE_SHA');
assert.match(sha, /^[a-f0-9]{40}$/);
const workspaceId = required('ALLRICE_ACCEPTANCE_WORKSPACE_ID');
const evidence = resolve(required('ALLRICE_ACCEPTANCE_EVIDENCE'));
await mkdir(evidence, { recursive: true, mode: 0o700 });
const save = (name, value, exclusive = false) =>
  writeFile(resolve(evidence, name), `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: exclusive ? 'wx' : 'w',
  });
const submissionPath = resolve(evidence, 'submission.json');
// Claim the intent BEFORE login or clicking Send. A lost response is uncertain,
// not permission for a retry. Inspect the Session before clearing this lock.
if (mode === '--submit-research')
  await save(
    'submission-intent.json',
    { sha, workspaceId, origin: base.origin, at: new Date().toISOString() },
    true,
  );
const { chromium } = createRequire(
  new URL('../../../apps/worker/package.json', import.meta.url),
)('playwright-core');
const browser = await chromium.launch({
  executablePath:
    process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : chromium.executablePath()),
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
});
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const report = {
  sha,
  origin: base.origin,
  workspaceId,
  mode,
  startedAt: new Date().toISOString(),
  passed: false,
  assertions: [],
  pageErrors: [],
};
page.on('pageerror', (error) => report.pageErrors.push(error.name));
const json = async (path) => {
  const response = await context.request.get(new URL(path, base).href);
  assert.ok(response.ok(), `GET ${path.split('?')[0]}: ${response.status()}`);
  return response.json();
};
const check = (name) => {
  report.assertions.push(name);
  console.log(JSON.stringify({ assertion: name }));
};
let loggedIn = false;
try {
  const health = await context.request.get(
    new URL('/api/health/ready', base).href,
  );
  assert.equal(health.status(), 200);
  assert.equal(
    health.headers()['x-allrice-release-sha'],
    sha,
    'Deployed SHA differs; stop before writing',
  );
  const login = await context.request.post(
    new URL('/api/v1/auth/login', base).href,
    {
      data: {
        username: required('ALLRICE_ACCEPTANCE_USER'),
        password: required('ALLRICE_ACCEPTANCE_PASSWORD'),
      },
    },
  );
  assert.equal(login.status(), 200, 'Tenant login failed');
  loggedIn = true;
  const { context: identity } = await json('/api/v1/auth/session');
  assert.equal(identity.workspaceId, workspaceId);
  report.actorId = identity.actor.id;
  assert.equal(
    identity.memberships.find(
      (m) => m.organizationId === identity.organizationId,
    )?.role,
    'member',
    'Acceptance must use the tenant member, not an administrator',
  );
  check('live release SHA and authenticated tenant member');
  const readiness = WorkspaceReadinessSchema.parse(
    await json(`/api/v1/workspace/readiness?workspaceId=${workspaceId}`),
  );
  assert.equal(readiness.viewerId, identity.actor.id);
  assert.equal(readiness.workspaceId, workspaceId);
  report.readiness = readiness;
  await page.goto(new URL('/chatflow', base).href, {
    waitUntil: 'domcontentloaded',
  });
  const composer = page.getByRole('textbox', { name: '给 Rice 的消息' });
  await composer.waitFor();
  const { workspace } = await json('/api/v1/workspace');

  if (mode === '--inspect') {
    const selected = workspace.sessions.filter((s) => !s.archivedAt)[1];
    assert.ok(
      selected,
      'Two existing Sessions required; do not seed fake history',
    );
    await page
      .locator('aside nav button')
      .filter({ hasText: selected.title })
      .first()
      .click();
    await page.waitForFunction(
      (id) => new URL(location.href).searchParams.get('session') === id,
      selected.id,
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await composer.waitFor();
    assert.equal(new URL(page.url()).searchParams.get('session'), selected.id);
    await page.waitForFunction(
      (title) => document.querySelector('h1')?.textContent === title,
      selected.title,
    );
    check('real historical Session selection survives reload');
    await page.getByRole('button', { name: '能力与环境', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '能力与环境' });
    await dialog.locator('[data-capability="report"]').waitFor();
    assert.equal(await dialog.locator('[data-capability]').count(), 12);
    assert.equal(await dialog.getByRole('link', { name: /配置/ }).count(), 0);
    await page.screenshot({ path: resolve(evidence, 'readiness.png') });
    await page.keyboard.press('Escape');
    check('all twelve capabilities visible without administrator links');
  } else {
    let submission;
    if (mode === '--resume') {
      submission = JSON.parse(await readFile(submissionPath, 'utf8'));
      assert.equal(submission.workspaceId, workspaceId);
      assert.equal(submission.actorId, identity.actor.id);
      assert.equal(submission.origin, base.origin);
      // A resumed Run retains its original execution snapshot. Report both SHAs.
      report.originalSubmissionSha = submission.sha;
      await page.goto(
        new URL(`/chatflow?session=${submission.sessionId}`, base).href,
        { waitUntil: 'domcontentloaded' },
      );
    } else {
      assert.equal(
        readiness.capabilities.find((c) => c.id === 'report')?.state,
        'ready',
      );
      await page.getByRole('button', { name: '新的工作', exact: true }).click();
      await composer.fill(
        'MET-147 UX01-C 研究报告验收：请联网对比美股 COIN、MSTR、CRCL 的商业模式、主要驱动和关键风险，给出对比表；至少引用 3 个来源，优先公司官方材料。写明实际查询日期和数据期间，未知数据明确标记，不编造实时股价，不需要投资建议。控制为约 1000 字。完成后务必用 workspace.export.create 交付完整 Markdown 文件 met147-coin-mstr-crcl.md；聊天只给摘要和文件入口。不要修改本地文件或创建自动化。',
      );
      const submitted = page.waitForResponse(
        (r) =>
          /\/api\/v1\/sessions\/[^/]+\/messages\?/.test(r.url()) &&
          r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: '发送', exact: true }).click();
      const response = await submitted;
      assert.ok(response.ok(), `Submission failed: ${response.status()}`);
      const { run } = await response.json();
      submission = {
        sha,
        origin: base.origin,
        workspaceId,
        actorId: identity.actor.id,
        runId: run.id,
        sessionId: new URL(response.url()).pathname.split('/')[4],
        at: new Date().toISOString(),
      };
      await save('submission.json', submission, true);
      console.log(
        JSON.stringify({
          submitted: submission.runId,
          sessionId: submission.sessionId,
        }),
      );
    }
    report.submission = submission;
    const deadline = Date.now() + 15 * 60_000;
    let run;
    do {
      run = RunSnapshotSchema.parse(
        (
          await json(
            `/api/v1/runs/${submission.runId}?workspaceId=${workspaceId}`,
          )
        ).run,
      );
      assert.equal(run.ownerId, identity.actor.id);
      if (isTerminalRunStatus(run.status)) break;
      await delay(5000);
    } while (Date.now() < deadline);
    report.run = {
      id: run.id,
      status: run.status,
      errorCode: run.error?.code ?? null,
    };
    // On timeout leave the real Run alone. Resume this receipt; never auto-resend.
    assert.equal(
      run.status,
      'succeeded',
      `Run ${run.id}: ${run.status} (${run.error?.code ?? 'not terminal'})`,
    );
    const list = await json(
      `/api/v1/sessions/${submission.sessionId}/artifacts?workspaceId=${workspaceId}`,
    );
    const artifact = list.artifacts
      .map((a) => WorkbenchArtifactSchema.parse(a))
      .find((a) => a.provenance.runId === run.id && a.kind === 'document');
    assert.ok(artifact, 'Successful chat is not a published report Artifact');
    assert.equal(artifact.version.sessionId, submission.sessionId);
    assert.equal(artifact.version.ownerId, identity.actor.id);
    const content = await json(
      `/api/v1/sessions/${submission.sessionId}/artifacts/${artifact.id}/content?workspaceId=${workspaceId}`,
    );
    assert.equal(content.kind, 'text');
    for (const symbol of ['COIN', 'MSTR', 'CRCL'])
      assert.ok(content.text.includes(symbol));
    assert.ok(
      (content.text.match(/https?:\/\//g) ?? []).length >= 3,
      'Report must contain cited sources',
    );
    const panel = page.getByRole('complementary', { name: '工件与审查工作台' });
    await panel.getByRole('combobox', { name: '工件版本' }).waitFor();
    assert.equal(
      await panel.getByRole('combobox', { name: '工件版本' }).inputValue(),
      artifact.id,
      'Artifact did not open automatically',
    );
    await panel.getByRole('table').first().waitFor({ state: 'visible' });
    const download = page.waitForEvent('download');
    await panel.getByRole('link', { name: '下载此版本' }).click();
    const file = await download;
    assert.equal(await file.failure(), null);
    const bytes = await readFile(await file.path());
    assert.equal(
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      artifact.object.checksum,
    );
    report.artifact = {
      id: artifact.id,
      objectId: artifact.object.id,
      checksum: artifact.object.checksum,
      bytes: bytes.length,
    };
    // Check the conversational entry too, not only the workbench link. A model
    // inventing allrice.example must not make an otherwise real file unusable.
    const chatLinks = page.locator(
      `[data-chat-scroll] a[href*="/api/v1/files/${artifact.object.id}/download"]`,
    );
    assert.ok(
      (await chatLinks.count()) > 0,
      'Report summary needs its file entry',
    );
    for (const link of await chatLinks.all()) {
      const target = new URL(await link.getAttribute('href'), base);
      assert.equal(
        target.origin,
        base.origin,
        'Model-invented download origin',
      );
      assert.equal(target.searchParams.get('name'), artifact.version.fileName);
    }
    check('chat download entry resolves to the authenticated current-Run file');
    check(
      'real completed report automatically rendered and downloaded with exact SHA',
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await panel.getByRole('combobox', { name: '工件版本' }).waitFor();
    assert.equal(
      await panel.getByRole('combobox', { name: '工件版本' }).inputValue(),
      artifact.id,
    );
    await page
      .getByText('答案已保留。本次任务超过平台内部预期 Token 预算', {
        exact: false,
      })
      .waitFor({ state: 'hidden' });
    check(
      'report restored on refresh without normal-completion budget warning',
    );
  }
  await page.screenshot({ path: resolve(evidence, 'desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: resolve(evidence, 'mobile.png') });
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  // Do not persist arbitrary response/error bodies which might contain secrets.
  report.failure =
    error instanceof assert.AssertionError ? error.message : error.name;
  await page
    .screenshot({ path: resolve(evidence, 'failure.png') })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await save(`result-${mode.slice(2)}.json`, report);
  if (loggedIn)
    await context.request
      .post(new URL('/api/v1/auth/logout', base).href, {
        headers: { Origin: base.origin },
      })
      .catch(() => {});
  await browser.close();
  console.log(
    JSON.stringify({
      passed: report.passed,
      evidence,
      failure: report.failure ?? null,
    }),
  );
}
