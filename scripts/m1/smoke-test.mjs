#!/usr/bin/env node
// Five real end-to-end checks as an ordinary employee, through the actual web UI
// (headless Chrome): chat, office (.docx), csv (Python chart), browser (cloud
// browser), reminder (fires within ~2 minutes). Real model calls — not a unit test.
//
//   node smoke-test.mjs --url http://127.0.0.1:3011 --creds <file> [--only chat,reminder] [--out <dir>]
//
// Writes <out>/result.json and one screenshot per check; exit code 1 if any check fails.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (acc, v, i, a) =>
        v.startsWith('--') ? [...acc, [v.slice(2), a[i + 1]]] : acc,
      [],
    ),
);
const ALL = ['chat', 'office', 'csv', 'browser', 'reminder'];
const only = args.only
  ? args.only
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : ALL;
for (const c of only)
  if (!ALL.includes(c)) {
    console.error(`unknown check: ${c}`);
    process.exit(2);
  }
if (!args.url || !args.creds) {
  console.error(
    'usage: smoke-test.mjs --url <base> --creds <file> [--only a,b] [--out dir]',
  );
  process.exit(2);
}
const base = args.url.replace(/\/$/, '');
const creds = JSON.parse(fs.readFileSync(args.creds, 'utf8'));
const out =
  args.out ??
  path.join(
    os.homedir(),
    'allrice-qa',
    '_smoke',
    new Date().toISOString().replace(/[:.]/g, '-'),
  );
fs.mkdirSync(out, { recursive: true, mode: 0o700 });

// playwright-core from the shared Dev release (any AllRice release has it).
const releases = path.join(os.homedir(), 'allrice-dev-releases');
const pwDir = fs
  .readdirSync(releases)
  .map((r) => path.join(releases, r, 'node_modules/.pnpm'))
  .filter((p) => fs.existsSync(p))
  .flatMap((p) =>
    fs
      .readdirSync(p)
      .filter((d) => d.startsWith('playwright-core@'))
      .map((d) => path.join(p, d, 'node_modules/playwright-core')),
  )[0];
if (!pwDir) {
  console.error('playwright-core not found under ~/allrice-dev-releases');
  process.exit(2);
}
const { chromium } = createRequire(import.meta.url)(pwDir);

const tag = Date.now().toString(36);
const t0 = Date.now();
const log = (...a) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const browser = await chromium.launch({
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
});
const page = await ctx.newPage();
const results = [];
// The version actually serving the run, read at start and end: a deploy or rollback in
// between makes the results unreliable, and the summary says so.
const runningSha = async () => {
  try {
    const j = await (await fetch(`${base}/api/health/ready`)).json();
    return j.status === 'ready' ? (j.identity?.sourceSha ?? '') : '';
  } catch {
    return '';
  }
};
const sourceShaStart = await runningSha();

async function login() {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name="username"]', creds.username);
  await page.fill('input[name="password"]', creds.password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), {
      timeout: 30_000,
    }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForLoadState('networkidle').catch(() => {});
}
async function newWork() {
  await page
    .goto(`${base}/chatflow`, { waitUntil: 'networkidle' })
    .catch(() => {});
  await page
    .getByRole('button', { name: '新的工作', exact: true })
    .first()
    .click();
  await page
    .getByRole('dialog')
    .getByText('Rice', { exact: true })
    .first()
    .click();
  await page.waitForTimeout(1500);
}
// Send, then wait until the run's stop button has appeared and stayed gone for 3s.
async function ask(text, timeoutMs) {
  await page.locator('textarea').first().fill(text);
  const sent = Date.now();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const stop = page.locator(
    'button[aria-label*="停止"], button:has-text("停止")',
  );
  let seen = false,
    gone = 0;
  while (Date.now() - sent < timeoutMs) {
    const running = await stop
      .first()
      .isVisible()
      .catch(() => false);
    if (running) {
      seen = true;
      gone = 0;
    } else if (seen) {
      gone ||= Date.now();
      if (Date.now() - gone > 3000) break;
    }
    await page.waitForTimeout(500);
  }
  return {
    seconds: Math.round((Date.now() - sent) / 1000),
    finished: seen && gone > 0,
  };
}
const replyAfter = async (prompt) => {
  const t = await page.innerText('main');
  const i = t.lastIndexOf(prompt);
  return i < 0 ? '' : t.slice(i + prompt.length);
};
async function check(name, fn) {
  if (!only.includes(name)) return;
  const started = Date.now();
  log(`${name} …`);
  let r;
  try {
    r = await fn();
  } catch (e) {
    r = { pass: false, detail: e.message.split('\n')[0] };
  }
  r.seconds = Math.round((Date.now() - started) / 1000);
  await page
    .screenshot({ path: path.join(out, `${name}.png`), fullPage: true })
    .catch(() => {});
  results.push({ check: name, ...r });
  log(`${name} ${r.pass ? 'PASS' : 'FAIL'} (${r.seconds}s) ${r.detail ?? ''}`);
}

try {
  await login();
  log('logged in');
  await check('chat', async () => {
    await newWork();
    const q = `冒烟测试 ${tag}：请用一句话介绍你自己。`;
    const run = await ask(q, 180_000);
    const reply = await replyAfter(q);
    const pass =
      run.finished &&
      /用时/.test(reply) &&
      reply.replace(/\s+/g, '').length > 20;
    return {
      pass,
      detail: pass
        ? ''
        : `finished=${run.finished} reply=${reply.slice(0, 120).replace(/\s+/g, ' ')}`,
    };
  });
  await check('office', async () => {
    await newWork();
    const q = `冒烟测试 ${tag}：生成一份 Word 文档，标题《冒烟测试》，正文两句话，直接给我下载。`;
    const run = await ask(q, 420_000);
    const reply = await replyAfter(q);
    const pass = run.finished && /\.docx/.test(reply);
    return {
      pass,
      detail: pass
        ? ''
        : `finished=${run.finished} reply=${reply.slice(0, 160).replace(/\s+/g, ' ')}`,
    };
  });
  await check('csv', async () => {
    await newWork();
    const file = path.join(out, `渠道数据-${tag}.csv`);
    fs.writeFileSync(
      file,
      '日期,渠道,曝光,点击,下单\n2026-10-01,微信,1200,80,9\n2026-10-01,抖音,1500,95,7\n2026-10-02,微信,1100,70,8\n2026-10-02,抖音,1600,99,6\n2026-10-03,小红书,900,60,5\n',
    );
    await page.locator('input[type="file"]').first().setInputFiles(file);
    await page.waitForTimeout(2500);
    const q = `冒烟测试 ${tag}：按渠道汇总这个 CSV，画一张柱状图。`;
    const run = await ask(q, 420_000);
    const reply = await replyAfter(q);
    const pass = run.finished && /\.png/.test(reply);
    return {
      pass,
      detail: pass
        ? ''
        : `finished=${run.finished} reply=${reply.slice(0, 160).replace(/\s+/g, ' ')}`,
    };
  });
  await check('browser', async () => {
    await newWork();
    const q = `冒烟测试 ${tag}：请用云端浏览器打开 https://example.com ，告诉我页面标题。`;
    const run = await ask(q, 300_000);
    const reply = await replyAfter(q);
    const pass = run.finished && /Example Domain/.test(reply);
    return {
      pass,
      detail: pass
        ? ''
        : `finished=${run.finished} reply=${reply.slice(0, 160).replace(/\s+/g, ' ')}`,
    };
  });
  await check('reminder', async () => {
    await newWork();
    const marker = `冒烟提醒-${tag}`;
    const q = `1 分钟后提醒我：${marker}。`;
    const run = await ask(q, 180_000);
    const created = await replyAfter(q);
    if (!run.finished || !/(待执行|一次性)/.test(created))
      return {
        pass: false,
        detail: `not scheduled: ${created.slice(0, 160).replace(/\s+/g, ' ')}`,
      };
    const session = page.url();
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(10_000);
      await page.goto(session, { waitUntil: 'networkidle' }).catch(() => {});
      // The model words the delivered reminder freely, so do not match its text:
      // a fired task adds an "自动化任务 … 查看任务" run entry to the conversation,
      // followed by a reply that carries this run's unique marker.
      const t = await page.innerText('main');
      const fired = t.indexOf('查看任务', t.lastIndexOf(q) + q.length);
      if (fired >= 0 && t.indexOf(marker, fired) >= 0) return { pass: true };
    }
    return { pass: false, detail: 'reminder did not fire within 3 minutes' };
  });
} catch (e) {
  results.push({
    check: 'setup',
    pass: false,
    detail: e.message.split('\n')[0],
  });
  await page
    .screenshot({ path: path.join(out, 'setup-error.png'), fullPage: true })
    .catch(() => {});
} finally {
  await browser.close();
}
const sourceShaEnd = await runningSha();
if (sourceShaStart !== sourceShaEnd)
  results.push({
    check: 'version',
    pass: false,
    detail: `version changed during the run: ${sourceShaStart || '?'} -> ${sourceShaEnd || '?'}`,
  });
const failed = results.filter((r) => !r.pass);
const summary = {
  url: base,
  account: creds.username,
  at: new Date().toISOString(),
  sourceShaStart,
  sourceShaEnd,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
  out,
};
fs.writeFileSync(
  path.join(out, 'result.json'),
  JSON.stringify(summary, null, 1),
);
log(`${summary.passed}/${results.length} passed — ${out}`);
process.exit(failed.length ? 1 : 0);
