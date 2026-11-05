/** Real tenant/detail/DSH memory UI; synthetic HTTP only, no DB or model. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defaultUserPreferences,
  defaultWorkAutomation,
  EmployeeInstanceSchema,
  type EmployeeMemoryPage,
} from '@allrice/contracts';
import type {
  Browser,
  Locator,
} from '../../../worker/node_modules/playwright-core/index.js';
import { employeeDetailsFixture } from '../../test/employee-details-fixture';

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-11-05T00:00:00.000Z';
const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
function detailsFor(instanceId: string) {
  const detail = employeeDetailsFixture();
  detail.profile.instanceId = instanceId;
  detail.content.instanceId = instanceId;
  detail.content.employeeId = instanceId === id(7) ? id(9) : id(19);
  detail.profile.name = instanceId === id(7) ? 'Rice' : '流程哥';
  return detail;
}
function memoryPage(
  instanceId: string,
  state: EmployeeMemoryPage['state'],
  total: number,
): EmployeeMemoryPage {
  return {
    organizationId: id(3),
    workspaceId: id(4),
    ownerId: id(5),
    instanceId,
    state,
    total,
    memories: [],
    nextCursor: null,
    budget: null,
  };
}

suite('U1 employee details personal-memory entry', () => {
  let browser: Browser, server: Server, origin: string;
  const evidence = resolve('.local/met249-u1-memory-entry');
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/employee-memory-entry-page.tsx'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/memory-entry-fixture',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
    });
    const assets = new Map<string, Uint8Array>(
      result.outputFiles.map((file: { path: string; contents: Uint8Array }) => [
        file.path.slice(file.path.lastIndexOf('/')),
        file.contents,
      ]),
    );
    server = createServer((req, res) => {
      const path = new URL(req.url!, 'http://localhost').pathname;
      const asset = assets.get(path);
      res.setHeader(
        'Content-Type',
        asset
          ? path.endsWith('.css')
            ? 'text/css'
            : 'text/javascript'
          : 'text/html',
      );
      res.end(
        asset ??
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-memory-entry-page.css"><div id="root"></div><script type="module" src="/employee-memory-entry-page.js"></script>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { chromium } = createRequire(
      new URL('../../../worker/package.json', import.meta.url),
    )('playwright-core');
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ALLRICE_TEST_CHROME_EXECUTABLE ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : chromium.executablePath()),
    });
    await mkdir(evidence, { recursive: true });
    console.info(`U1 memory-entry evidence: ${evidence}`);
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30_000);

  async function fixture(
    options: {
      width?: number;
      dark?: boolean;
      host?: 'details' | 'compact' | 'lifecycle';
      shared?: boolean;
      disabled?: boolean;
      legacy?: boolean;
      holdCounts?: boolean;
      failCounts?: boolean;
      zero?: boolean;
    } = {},
  ) {
    const width = options.width ?? 1440;
    const page = await browser.newPage({
      viewport: { width, height: width < 600 ? 844 : 1000 },
      isMobile: width < 600,
      hasTouch: width < 600,
      colorScheme: options.dark ? 'dark' : 'light',
      reducedMotion: 'reduce',
    });
    page.setDefaultTimeout(8000);
    const preferences = {
      ...defaultUserPreferences,
      appearance: options.dark ? ('dark' as const) : ('light' as const),
    };
    const countGate = gate();
    const state = {
      reads: [] as Array<{
        path: string;
        instanceId: string | null;
        filter: string | null;
      }>,
      writes: [] as Array<{
        path: string;
        method: string;
        body: Record<string, unknown>;
      }>,
      errors: [] as string[],
      failCounts: !!options.failCounts,
      denyMemory: false,
      countGate: options.holdCounts
        ? countGate.promise
        : (null as Promise<void> | null),
      writeGate: null as Promise<void> | null,
      savedContents: {} as Record<string, string>,
    };
    page.on('pageerror', (cause) => state.errors.push(cause.message));
    await page.addInitScript(() => {
      (window as unknown as { memoryReadEvents: unknown[] }).memoryReadEvents =
        [];
      window.addEventListener('allrice:workbench-module-read', (event) =>
        (
          window as unknown as { memoryReadEvents: unknown[] }
        ).memoryReadEvents.push((event as CustomEvent).detail),
      );
    });
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname;
      const instanceId = url.searchParams.get('instanceId');
      if (request.method() === 'GET')
        state.reads.push({
          path,
          instanceId,
          filter: url.searchParams.get('state'),
        });
      else
        state.writes.push({
          path,
          method: request.method(),
          body: request.postDataJSON() ?? {},
        });
      if (path === '/api/v1/memories/manage') {
        const filter = (url.searchParams.get('state') ??
          'all') as EmployeeMemoryPage['state'];
        if (state.countGate && filter !== 'all' && instanceId === id(7))
          await state.countGate;
        if (state.denyMemory || (state.failCounts && filter !== 'all'))
          return route.fulfill(json({ error: 'unavailable' }, 403));
        const count = options.zero
          ? 0
          : filter === 'confirmed'
            ? instanceId === id(7)
              ? 6
              : 65
            : filter === 'pending'
              ? 1
              : state.savedContents[instanceId!]
                ? 1
                : 0;
        return route.fulfill(json(memoryPage(instanceId!, filter, count)));
      }
      if (path === '/api/v1/experiences')
        return route.fulfill(
          json({
            candidates: [],
            draftBatches: [],
            overview: {
              visibility: 'owner',
              workspaceId: id(4),
              instanceId,
              summary: {
                enabled: true,
                policy: {
                  frequency: 'weekly',
                  timezone: 'Asia/Shanghai',
                  time: '03:00',
                  weekday: 1,
                  monthDay: 1,
                  source: 'platform',
                  revision: 2,
                  validationMode: 'supported_cases',
                  adoptionMode: 'supported_private',
                },
                schedule: {
                  state: 'not_scheduled',
                  lastCheckedAt: null,
                  nextRunAt: null,
                  lastOccurrence: null,
                },
                counts: {
                  pendingSources: 0,
                  awaitingValidation: 0,
                  adoptedTotal: 0,
                },
              },
            },
          }),
        );
      if (path === '/api/v1/memories' && request.method() === 'POST') {
        const body = request.postDataJSON();
        if (state.writeGate) await state.writeGate;
        state.savedContents[body.instanceId] = body.content;
        return route.fulfill(
          json(
            {
              memory: {
                id: id(90),
                organizationId: id(3),
                workspaceId: id(4),
                employeeId: null,
                instanceId: body.instanceId,
                ownerId: id(5),
                content: body.content,
                contentDigest: `sha256:${'b'.repeat(64)}`,
                visibility: 'private',
                sourceType: 'user',
                sourceId: null,
                sourceLabel: '本人新增',
                lifecycleState: 'durable',
                memoryClass: 'user_preference',
                revision: 1,
                trust: 'user_confirmed',
                confidence: 1,
                capturedAt: now,
                expiresAt: null,
                lastVerifiedAt: null,
                supersedesMemoryId: null,
                lastRecalledAt: null,
                recallCount: 0,
                createdAt: now,
                updatedAt: now,
                ownedByMe: true,
              },
            },
            201,
          ),
        );
      }
      if (path.endsWith('/content')) {
        const target = path.split('/').at(-2)!;
        const details = detailsFor(target);
        if (options.shared) {
          details.profile.canMaintainPersonal = false;
          details.profile.personalFields = [];
          return route.fulfill(
            json({
              organizationId: id(3),
              userId: id(5),
              visibility: 'shared_only',
              details,
            }),
          );
        }
        return route.fulfill(json(details));
      }
      if (path === '/api/v1/workspace')
        return route.fulfill(
          json({
            workspace: {
              organizationId: id(3),
              workspaceId: id(4),
              viewerId: id(5),
              preferences,
              canAdminister: false,
              sessions: [],
              sessionModels: [],
              employeeProfiles: [7, 17].map((n) => {
                const profile = detailsFor(id(n)).profile;
                return {
                  assignmentId: id(n),
                  employeeId: id(n + 2),
                  name: profile.name,
                  description: profile.description,
                  appearance: profile.appearance,
                  identity: profile.identity,
                  skills: [],
                  model: {
                    harness: 'dsh',
                    provider: 'codex',
                    model: 'gpt-6.1-sol',
                    reasoningEffort: 'max',
                  },
                };
              }),
              employees: [7, 17].map((n) => ({
                id: id(n),
                instanceId: id(n),
                employeeId: id(n + 2),
                isDefault: n === 7,
                versions: [],
                instances: [
                  EmployeeInstanceSchema.parse({
                    id: id(n),
                    assignmentId: id(n),
                    organizationId: id(3),
                    workspaceId: id(4),
                    ownerId: id(5),
                    kind: 'general',
                    revision: 2,
                    profile: { name: n === 7 ? 'Rice' : '流程哥' },
                    creationSource: {
                      kind: 'tenant_version',
                      employeeVersionId: id(n + 1),
                    },
                    source: {
                      kind: 'tenant_version',
                      employeeVersionId: id(n + 1),
                    },
                    createdAt: now,
                    updatedAt: now,
                    archivedAt: null,
                  }),
                ],
                currentVersion: {
                  id: id(n + 1),
                  manifest: {
                    name: n === 7 ? 'Rice' : '流程哥',
                    runtimePolicy: { harness: 'dsh', provider: 'codex' },
                  },
                },
              })),
            },
          }),
        );
      if (path === '/api/v1/saas/capabilities')
        return route.fulfill(
          json({
            capabilities: {
              schemaVersion: 1,
              roles: ['member'],
              surfaces: ['chatflow'],
              actions: [],
              features: { chatFlowV3: true, nativeHarnessEvents: true },
            },
          }),
        );
      if (path === '/api/v1/me/preferences')
        return route.fulfill(json({ viewerId: id(5), preferences }));
      if (path === '/api/v1/sessions' && request.method() === 'GET')
        return route.fulfill(
          json({
            sessions: [],
            nextCursor: null,
            ...(!url.searchParams.has('employeeAssignmentId') &&
            !url.searchParams.has('employeeInstanceId')
              ? { employeeGroups: [] }
              : {}),
          }),
        );
      if (path === '/api/v1/me/work-automation')
        return route.fulfill(
          json({
            workspaceId: id(4),
            revision: 0,
            settings: defaultWorkAutomation,
            editable: true,
          }),
        );
      if (path === '/api/v1/connections')
        return route.fulfill(json({ connections: [] }));
      if (path === '/api/v1/workbench/updates')
        return route.fulfill(json({ fileIds: [], experienceIds: [] }));
      if (path === '/api/v1/workbench/files')
        return route.fulfill(
          json({
            files: [],
            quotableFileIds: [],
            truncated: false,
            options: { writable: false },
          }),
        );
      if (path.endsWith('/brand-content'))
        return route.fulfill(json({ error: 'not_available' }, 404));
      return route.fulfill(json({ error: 'fixture_unhandled', path }, 404));
    });
    const params = new URLSearchParams();
    if (options.host) params.set('host', options.host);
    if (options.dark) params.set('theme', 'dark');
    if (options.shared) params.set('shared', '1');
    if (options.disabled) params.set('disabled', '1');
    if (options.legacy) params.set('legacy', '1');
    await page.goto(`${origin}/?${params}`);
    if (!options.host)
      await page
        .getByRole('textbox', { name: '给 Rice 的消息', exact: true })
        .waitFor();
    const openDetails = async (name = '流程哥') => {
      const entry = page.getByRole('button', {
        name: `查看${name}详情`,
        exact: true,
      });
      if (!(await entry.isVisible()))
        await page
          .getByRole('button', { name: '展开侧边栏', exact: true })
          .click();
      await entry.click();
      const dialog = page.getByRole('dialog', {
        name: `${name}员工详情`,
        exact: true,
      });
      await expect.poll(() => dialog.isVisible()).toBe(true);
      return dialog;
    };
    return {
      page,
      state,
      openDetails,
      releaseCounts: countGate.release,
      close: () => page.close(),
    };
  }
  async function contains(locator: Locator, text: string) {
    await expect.poll(() => locator.textContent()).toContain(text);
  }

  it.each([
    { width: 1440, dark: false },
    { width: 390, dark: false },
    { width: 1440, dark: true },
    { width: 390, dark: true },
  ])(
    'opens the employee being inspected, returns there and keeps the chat draft at $width px dark=$dark',
    async ({ width, dark }) => {
      const f = await fixture({ width, dark });
      try {
        const composer = f.page.getByRole('textbox', {
          name: '给 Rice 的消息',
          exact: true,
        });
        await composer.fill('还没发送的工作草稿。');
        const dialog = await f.openDetails();
        const row = dialog.getByRole('region', { name: '记忆', exact: true });
        await contains(row, '65 条 · 待确认 1 条');
        expect(await row.textContent()).not.toContain('已确认');
        const visual = await row.evaluate((node) => {
          const css = getComputedStyle(node),
            svg = node.querySelector('svg')!;
          return {
            font: css.fontSize,
            fontFamily: css.fontFamily,
            padding: css.padding,
            radius: css.borderRadius,
            background: css.backgroundColor,
            icon: getComputedStyle(svg).color,
            rowColor: css.color,
            theme: document.documentElement.dataset.theme,
            appearance:
              document.documentElement.getAttribute('data-appearance'),
            darkAttribute: document.body.hasAttribute('data-ds-dark-theme'),
            colorScheme: getComputedStyle(document.documentElement).colorScheme,
            paths: svg.querySelectorAll('path').length,
            iconVisible:
              getComputedStyle(svg.parentElement!).display !== 'none',
          };
        });
        expect(visual.font).toBe('14px');
        expect(visual.fontFamily).toMatch(/sans-serif/);
        expect(visual.padding).toBe(width < 600 ? '12px' : '12px 16px');
        expect(visual.radius).toBe('12px');
        expect(visual.icon).toBe(visual.rowColor);
        expect(visual.paths).toBe(2);
        expect(visual.iconVisible).toBe(width >= 600);
        expect(visual.theme).toBe(dark ? 'dark' : 'light');
        expect(visual.appearance).toBe(dark ? 'dark' : 'light');
        expect(visual.darkAttribute).toBe(dark);
        expect(visual.colorScheme).toBe(dark ? 'dark' : 'light');
        // Current DSH neutral-bluish 950 / 50; attributes alone cannot prove
        // that the actual row surface and text have switched palettes.
        expect(visual.background).toBe(
          dark ? 'rgb(21, 21, 23)' : 'rgb(255, 255, 255)',
        );
        if (dark) expect(visual.rowColor).toBe('rgb(249, 250, 251)');
        await f.page.screenshot({
          path: resolve(
            evidence,
            `details-${width}-${dark ? 'dark' : 'light'}.png`,
          ),
          fullPage: true,
        });
        const before = f.state.reads.length;
        await row.getByRole('button', { name: '查看', exact: true }).click();
        const manager = f.page.getByRole('region', {
          name: '个人记忆',
          exact: true,
        });
        await contains(manager, '全部 · 共 0 条');
        const memoryVisual = await manager.evaluate((node) => {
          const host = node.closest('#artifact-workbench')!;
          const surface = getComputedStyle(host).backgroundColor;
          const text = getComputedStyle(node).color;
          return {
            background: surface,
            text,
            backgroundChannels: surface
              .match(/[\d.]+/g)!
              .slice(0, 3)
              .map(Number),
            textChannels: text
              .match(/[\d.]+/g)!
              .slice(0, 3)
              .map(Number),
            theme: document.documentElement.dataset.theme,
            darkAttribute: document.body.hasAttribute('data-ds-dark-theme'),
          };
        });
        if (dark) {
          expect(memoryVisual.theme).toBe('dark');
          expect(memoryVisual.darkAttribute).toBe(true);
          expect(
            memoryVisual.backgroundChannels.every((value) => value < 128),
          ).toBe(true);
          expect(memoryVisual.textChannels.every((value) => value > 200)).toBe(
            true,
          );
        }
        const close = f.page.getByRole('button', {
          name: '返回员工详情',
          exact: true,
        });
        expect(await close.innerText()).toBe('×');
        expect(
          await f.page.getByRole('tab').filter({ hasText: '记忆' }).count(),
        ).toBe(1);
        expect(
          f.state.reads
            .slice(before)
            .filter((r) => r.path === '/api/v1/memories/manage')
            .every((r) => r.instanceId === id(17)),
        ).toBe(true);
        expect(
          f.state.reads
            .slice(before)
            .some((r) => /experience|accumulation/.test(r.path)),
        ).toBe(false);
        expect(
          await f.page.evaluate(() =>
            (
              window as unknown as { memoryReadEvents: Array<{ kind: string }> }
            ).memoryReadEvents.filter((event) => event.kind === 'experience'),
          ),
        ).toEqual([]);
        expect(
          await f.page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await f.page.screenshot({
          path: resolve(
            evidence,
            `memory-${width}-${dark ? 'dark' : 'light'}.png`,
          ),
          fullPage: true,
        });
        if (width < 600) await f.page.keyboard.press('Escape');
        else await close.click();
        await contains(
          f.page.getByRole('dialog', { name: '流程哥员工详情', exact: true }),
          '65 条',
        );
        await f.page
          .getByRole('dialog', { name: '流程哥员工详情', exact: true })
          .getByRole('button', { name: '关闭', exact: true })
          .click();
        expect(await composer.inputValue()).toBe('还没发送的工作草稿。');
        expect(f.state.writes).toEqual([]);
        expect(f.state.errors).toEqual([]);
        await writeFile(
          resolve(evidence, `entry-${width}-${dark ? 'dark' : 'light'}.json`),
          JSON.stringify(
            {
              visual,
              memoryVisual,
              reads: f.state.reads,
              writes: f.state.writes,
              errors: f.state.errors,
            },
            null,
            2,
          ),
        );
      } finally {
        await f.close();
      }
    },
    30_000,
  );

  it('opens personal memory in compact mode with the old workbench flag disabled, without enabling other compact modules', async () => {
    const f = await fixture({ width: 390, disabled: true });
    try {
      const dialog = await f.openDetails();
      await dialog
        .getByRole('region', { name: '记忆', exact: true })
        .getByRole('button', { name: '查看', exact: true })
        .click();
      await contains(
        f.page.getByRole('region', { name: '个人记忆', exact: true }),
        '全部 · 共 0 条',
      );
      expect(
        f.state.reads.filter((read) => read.path === '/api/v1/workbench/files'),
      ).toEqual([]);
    } finally {
      await f.close();
    }
    const compact = await fixture({ width: 390, host: 'compact' });
    try {
      await compact.page.getByRole('tab', { name: /交付成果/ }).waitFor();
      await compact.page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      expect(await compact.page.getByText('不应开放的旧经验模块').count()).toBe(
        0,
      );
      expect(
        compact.state.reads.filter(
          (read) => read.path === '/api/v1/memories/manage',
        ),
      ).toEqual([]);
    } finally {
      await compact.close();
    }
  });

  it('shows real zero totals and keeps loading/error distinct, then retries without inventing counts', async () => {
    const f = await fixture({
      host: 'details',
      holdCounts: true,
      failCounts: true,
      zero: true,
    });
    try {
      const row = f.page
        .getByRole('dialog')
        .getByRole('region', { name: '记忆', exact: true });
      await contains(row, '正在读取…');
      expect(await row.textContent()).not.toContain('0 条');
      f.releaseCounts();
      await contains(row, '记忆读取失败，请重试。');
      expect(await row.textContent()).not.toContain('0 条');
      f.state.failCounts = false;
      await row.getByRole('button', { name: '重试', exact: true }).click();
      await contains(row, '0 条 · 待确认 0 条');
      expect(f.state.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('does not apply a late old-employee count response to the newly inspected employee', async () => {
    const f = await fixture({ host: 'details', holdCounts: true });
    try {
      await contains(
        f.page
          .getByRole('dialog')
          .getByRole('region', { name: '记忆', exact: true }),
        '正在读取…',
      );
      await f.page.evaluate(() =>
        document.getElementById('switch-target')!.click(),
      );
      const row = f.page
        .getByRole('dialog', { name: '流程哥员工详情', exact: true })
        .getByRole('region', { name: '记忆', exact: true });
      await contains(row, '65 条 · 待确认 1 条');
      f.releaseCounts();
      await f.page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      await contains(row, '65 条 · 待确认 1 条');
      expect(await row.textContent()).not.toMatch(/(?<!\d)6 条/);
    } finally {
      await f.close();
    }
  });

  it('does not mount owner-private counters in a shared employee detail', async () => {
    const f = await fixture({ host: 'details', shared: true });
    try {
      await contains(
        f.page.getByRole('dialog', { name: 'Rice员工详情', exact: true }),
        'Rice',
      );
      expect(
        await f.page
          .getByRole('dialog')
          .getByRole('region', { name: '记忆', exact: true })
          .count(),
      ).toBe(0);
      expect(
        f.state.reads.filter((read) => read.path === '/api/v1/memories/manage'),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('fails a revoked memory target without reading the active employee or old experience as a fallback', async () => {
    const f = await fixture();
    try {
      const dialog = await f.openDetails();
      await contains(
        dialog.getByRole('region', { name: '记忆', exact: true }),
        '65 条',
      );
      f.state.denyMemory = true;
      const before = f.state.reads.length;
      await dialog
        .getByRole('region', { name: '记忆', exact: true })
        .getByRole('button', { name: '查看', exact: true })
        .click();
      await contains(
        f.page.getByRole('region', { name: '个人记忆', exact: true }),
        '记忆读取失败，请重试。',
      );
      const reads = f.state.reads.slice(before);
      expect(
        reads.some(
          (read) =>
            read.path === '/api/v1/memories/manage' &&
            read.instanceId === id(17),
        ),
      ).toBe(true);
      expect(
        reads.some(
          (read) =>
            read.path === '/api/v1/memories/manage' &&
            read.instanceId === id(7),
        ),
      ).toBe(false);
      expect(
        reads.some((read) => /experience|accumulation/.test(read.path)),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });

  it('keeps a draft through the real native dock tab switch', async () => {
    const f = await fixture();
    try {
      const dialog = await f.openDetails();
      await dialog
        .getByRole('region', { name: '记忆', exact: true })
        .getByRole('button', { name: '查看', exact: true })
        .click();
      const manager = f.page.getByRole('region', {
        name: '个人记忆',
        exact: true,
      });
      await contains(manager, '全部 · 共 0 条');
      await manager
        .getByRole('button', { name: '新增记忆', exact: true })
        .click();
      await manager
        .getByRole('textbox', { name: '新增记忆内容', exact: true })
        .fill('真实工作台切标签保留草稿');
      await f.page
        .getByRole('button', { name: '工作区文件', exact: true })
        .click();
      await expect.poll(() => manager.isVisible()).toBe(false);
      await f.page.getByRole('tab').filter({ hasText: '记忆' }).click();
      expect(
        await manager
          .getByRole('textbox', { name: '新增记忆内容', exact: true })
          .inputValue(),
      ).toBe('真实工作台切标签保留草稿');
      expect(f.state.writes).toEqual([]);
      expect(f.state.errors).toEqual([]);
      await f.page
        .getByRole('button', { name: '返回员工详情', exact: true })
        .click();
      await contains(
        f.page.getByRole('dialog', { name: '流程哥员工详情', exact: true }),
        '65 条',
      );
    } finally {
      await f.close();
    }
  });

  it.each([1440, 390])(
    'retains each employee memory tab and returns to that tab employee at %ipx',
    async (width) => {
      const f = await fixture({ width });
      try {
        const rice = await f.openDetails('Rice');
        await rice
          .getByRole('region', { name: '记忆', exact: true })
          .getByRole('button', { name: '查看', exact: true })
          .click();
        let manager = f.page.getByRole('region', {
          name: '个人记忆',
          exact: true,
        });
        await contains(manager, '全部 · 共 0 条');
        await manager
          .getByRole('button', { name: '新增记忆', exact: true })
          .click();
        await manager
          .getByRole('textbox', { name: '新增记忆内容', exact: true })
          .fill('Rice 独立记忆草稿');
        await f.page
          .getByRole('button', { name: '返回员工详情', exact: true })
          .click();
        await f.page
          .getByRole('dialog', { name: 'Rice员工详情', exact: true })
          .getByRole('button', { name: '关闭', exact: true })
          .click();
        const flow = await f.openDetails('流程哥');
        await flow
          .getByRole('region', { name: '记忆', exact: true })
          .getByRole('button', { name: '查看', exact: true })
          .click();
        manager = f.page.getByRole('region', { name: '个人记忆', exact: true });
        await contains(manager, '全部 · 共 0 条');
        await manager
          .getByRole('button', { name: '新增记忆', exact: true })
          .click();
        await manager
          .getByRole('textbox', { name: '新增记忆内容', exact: true })
          .fill('流程哥独立记忆草稿');
        const memoryTabs = f.page.getByRole('tab').filter({ hasText: '记忆' });
        expect(await memoryTabs.count()).toBe(2);
        await memoryTabs.first().click();
        manager = f.page.getByRole('region', { name: '个人记忆', exact: true });
        expect(
          await manager
            .getByRole('textbox', { name: '新增记忆内容', exact: true })
            .inputValue(),
        ).toBe('Rice 独立记忆草稿');
        await f.page
          .getByRole('button', { name: '返回员工详情', exact: true })
          .click();
        await contains(
          f.page.getByRole('dialog', { name: 'Rice员工详情', exact: true }),
          '6 条',
        );
        if (width === 1440) {
          await f.page
            .getByRole('dialog', { name: 'Rice员工详情', exact: true })
            .getByRole('region', { name: '记忆', exact: true })
            .getByRole('button', { name: '查看', exact: true })
            .click();
          await f.page.setViewportSize({ width: 390, height: 844 });
          await memoryTabs.last().click();
          expect(
            await f.page
              .getByRole('region', { name: '个人记忆', exact: true })
              .getByRole('textbox', { name: '新增记忆内容', exact: true })
              .inputValue(),
          ).toBe('流程哥独立记忆草稿');
          await memoryTabs.first().click();
          await f.page
            .getByRole('button', { name: '返回员工详情', exact: true })
            .click();
          await contains(
            f.page.getByRole('dialog', { name: 'Rice员工详情', exact: true }),
            '6 条',
          );
        }
        expect(f.state.writes).toEqual([]);
        expect(f.state.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
    30_000,
  );

  it('opens personal memory without reactivating a retained old experience/collector tab', async () => {
    const f = await fixture({ legacy: true });
    try {
      await f.page
        .getByRole('button', { name: '经验管理', exact: true })
        .click();
      const old = f.page.getByRole('region', { name: '经验管理', exact: true });
      await old
        .getByRole('button', { name: '积累与采用记录', exact: true })
        .click();
      await expect
        .poll(
          () =>
            f.state.reads.filter((read) => read.path === '/api/v1/experiences')
              .length,
        )
        .toBeGreaterThan(0);
      await f.page
        .getByRole('button', { name: '关闭工作台', exact: true })
        .click();
      const dialog = await f.openDetails();
      await contains(
        dialog.getByRole('region', { name: '记忆', exact: true }),
        '65 条',
      );
      const before = f.state.reads.length;
      await dialog
        .getByRole('region', { name: '记忆', exact: true })
        .getByRole('button', { name: '查看', exact: true })
        .click();
      await contains(
        f.page.getByRole('region', { name: '个人记忆', exact: true }),
        '全部 · 共 0 条',
      );
      expect(
        f.state.reads
          .slice(before)
          .filter(
            (read) =>
              /experience|accumulation/.test(read.path) ||
              read.path.endsWith('/content'),
          ),
      ).toEqual([]);
      expect(f.state.writes).toEqual([]);
      expect(f.state.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('keeps the explicitly open legacy memory pane while another pane opens personal memory', async () => {
    const f = await fixture({ legacy: true });
    const writeGate = gate();
    try {
      await f.page
        .getByRole('button', { name: '经验管理', exact: true })
        .click();
      const old = f.page.getByRole('region', { name: '经验管理', exact: true });
      await old
        .getByRole('combobox', { name: '经验所属 AllRice 助手', exact: true })
        .selectOption(id(7));
      await old.getByRole('button', { name: '个人记忆', exact: true }).click();
      const oldManager = old.getByRole('region', {
        name: '个人记忆',
        exact: true,
      });
      await contains(oldManager, '全部 · 共 0 条');
      await oldManager
        .getByRole('button', { name: '新增记忆', exact: true })
        .click();
      const oldEditor = oldManager.getByRole('textbox', {
        name: '新增记忆内容',
        exact: true,
      });
      await oldEditor.fill('左栏旧入口的独立草稿');
      await f.page
        .getByRole('button', { name: '并排查看', exact: true })
        .click();
      await expect
        .poll(() => f.page.locator('[data-dockkit-pane]').count())
        .toBe(2);
      const dialog = await f.openDetails('流程哥');
      await dialog
        .getByRole('region', { name: '记忆', exact: true })
        .getByRole('button', { name: '查看', exact: true })
        .click();
      const personal = f.page
        .getByRole('region', { name: '记忆', exact: true })
        .getByRole('region', { name: '个人记忆', exact: true });
      await contains(personal, '全部 · 共 0 条');
      expect(await oldEditor.isVisible()).toBe(true);
      expect(await oldEditor.inputValue()).toBe('左栏旧入口的独立草稿');
      // Reopening an existing resource reveals its original pane. The native
      // planner does not replace the currently focused left-hand legacy pane.
      await oldEditor.click();
      const again = await f.openDetails('流程哥');
      await again
        .getByRole('region', { name: '记忆', exact: true })
        .getByRole('button', { name: '查看', exact: true })
        .click();
      await contains(personal, '全部 · 共 0 条');
      expect(await oldEditor.isVisible()).toBe(true);
      expect(await oldEditor.inputValue()).toBe('左栏旧入口的独立草稿');
      f.state.writeGate = writeGate.promise;
      await oldManager
        .getByRole('button', { name: '保存记忆', exact: true })
        .click();
      await expect.poll(() => f.state.writes.length).toBe(1);
      await personal
        .getByRole('button', { name: '新增记忆', exact: true })
        .click();
      await personal
        .getByRole('textbox', { name: '新增记忆内容', exact: true })
        .fill('右栏自己的记忆草稿');
      expect(await oldEditor.isVisible()).toBe(true);
      expect(await oldEditor.inputValue()).toBe('左栏旧入口的独立草稿');
      expect(
        await oldManager
          .getByRole('button', { name: '正在保存…', exact: true })
          .isDisabled(),
      ).toBe(true);
      writeGate.release();
      await contains(oldManager, '记忆已保存。');
      expect(f.state.writes.length).toBe(1);
      expect(f.state.writes[0].body.instanceId).toBe(id(7));
      expect(
        await personal
          .getByRole('textbox', { name: '新增记忆内容', exact: true })
          .inputValue(),
      ).toBe('右栏自己的记忆草稿');
      expect(f.state.errors).toEqual([]);
    } finally {
      writeGate.release();
      await f.close();
    }
  });

  it('keeps M3 drafts and in-flight writes mounted while hidden and when reopening the same target', async () => {
    const f = await fixture({ host: 'lifecycle' });
    const writeGate = gate();
    try {
      let manager = f.page.getByRole('region', {
        name: '个人记忆',
        exact: true,
      });
      await contains(manager, '全部 · 共 0 条');
      await manager
        .getByRole('button', { name: '新增记忆', exact: true })
        .click();
      await manager
        .getByRole('textbox', { name: '新增记忆内容', exact: true })
        .fill('切标签保留的记忆草稿');
      await f.page.locator('#switch-tab').click();
      expect(await manager.isVisible()).toBe(false);
      await f.page.locator('#reopen-target').click();
      await f.page.locator('#switch-tab').click();
      manager = f.page.getByRole('region', { name: '个人记忆', exact: true });
      expect(
        await manager
          .getByRole('textbox', { name: '新增记忆内容', exact: true })
          .inputValue(),
      ).toBe('切标签保留的记忆草稿');
      f.state.writeGate = writeGate.promise;
      await manager
        .getByRole('button', { name: '保存记忆', exact: true })
        .click();
      await expect.poll(() => f.state.writes.length).toBe(1);
      await f.page.locator('#switch-tab').click();
      await f.page.locator('#reopen-target').click();
      await f.page.locator('#switch-tab').click();
      expect(
        await manager
          .getByRole('button', { name: '正在保存…', exact: true })
          .isDisabled(),
      ).toBe(true);
      expect(
        await manager
          .getByRole('textbox', { name: '新增记忆内容', exact: true })
          .inputValue(),
      ).toBe('切标签保留的记忆草稿');
      writeGate.release();
      await contains(manager, '记忆已保存。');
      expect(f.state.writes.length).toBe(1);
      expect(f.state.writes[0].body.instanceId).toBe(id(17));
      expect(f.state.errors).toEqual([]);
    } finally {
      writeGate.release();
      await f.close();
    }
  });
});
