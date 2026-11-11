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
  EmployeeSkillCatalogSchema,
  EmployeeSceneSkillCatalogSchema,
  EmployeeMemoryListSchema,
  type EmployeeMemoryRecord,
} from '@allrice/contracts';
import type { z } from 'zod';
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
  active: number,
  pending: number,
  saved?: { summary: string; details: string | null },
): z.infer<typeof EmployeeMemoryListSchema> {
  const row = (n: number, state: 'active' | 'pending') => ({
    id: id(1000 + n + (state === 'pending' ? 100 : 0)),
    summary: `测试记忆 ${n}`, hasDetails: false, state, revision: 1,
    pairDigest: `sha256:${'a'.repeat(64)}`, capturedAt: now, updatedAt: now,
  });
  const rows = Array.from({ length: active }, (_, n) => row(n, 'active'));
  if (saved) rows.unshift({ ...row(90, 'active'), id: id(90), summary: saved.summary, hasDetails: saved.details !== null, pairDigest: `sha256:${'b'.repeat(64)}` });
  return {
    schemaVersion: 2,
    workspaceId: id(4),
    instanceId,
    counts: { active: rows.length, pending, maxActive: 100 },
    active: rows,
    pending: Array.from({ length: pending }, (_, n) => row(n, 'pending')),
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
      savedPairs: {} as Record<string, { summary: string; details: string | null }>,
      loseNextSaveAck: false,
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
        expect([...url.searchParams.keys()].sort()).toEqual(['instanceId', 'workspaceId']);
        if (state.countGate && instanceId === id(7))
          await state.countGate;
        if (state.denyMemory || state.failCounts)
          return route.fulfill(json({ error: 'unavailable' }, 403));
        return route.fulfill(json(memoryPage(instanceId!, options.zero ? 0 : instanceId === id(7) ? 6 : 65,
          options.zero ? 0 : 1, state.savedPairs[instanceId!])));
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
        state.savedPairs[body.instanceId] = { summary: body.summary, details: body.details };
        if (state.loseNextSaveAck) {
          state.loseNextSaveAck = false;
          return route.fulfill(json({}, 503));
        }
        const memory: EmployeeMemoryRecord = {
          id: id(90), summary: body.summary, details: body.details,
          hasDetails: body.details !== null, state: 'active', revision: 1,
          pairDigest: `sha256:${'b'.repeat(64)}`, capturedAt: now, updatedAt: now,
        };
        return route.fulfill(
          json(
            {
              schemaVersion: 2, memory,
              counts: { active: body.instanceId === id(7) ? 7 : 66, pending: 1, maxActive: 100 },
            },
            201,
          ),
        );
      }
      if (request.method() === 'GET' && path === '/api/v1/employee-instances') {
        expect([...url.searchParams.keys()].sort()).toEqual([
          'view',
          'workspaceId',
        ]);
        expect(url.searchParams.get('view')).toBe('history');
        expect(url.searchParams.get('workspaceId')).toBe(id(4));
        expect(request.headers()['x-allrice-workspace-id']).toBe(id(4));
        return route.fulfill(
          json({
            instances: EmployeeInstanceSchema.array().parse(
              [7, 17].map((n) => {
                const target = id(n);
                const profile = detailsFor(target).profile;
                return {
                  id: target,
                  assignmentId: target,
                  organizationId: id(3),
                  workspaceId: id(4),
                  ownerId: id(5),
                  kind: 'general',
                  revision: profile.revision,
                  profile: { name: profile.name },
                  creationSource: profile.source,
                  source: profile.source,
                  createdAt: now,
                  updatedAt: now,
                  archivedAt: null,
                };
              }),
            ),
            nextBeforeId: null,
          }),
        );
      }
      const skillCatalog = path.match(
        /^\/api\/v1\/employee-instances\/([^/]+)\/skills$/,
      );
      if (
        skillCatalog &&
        request.method() === 'GET' &&
        !options.host &&
        !options.shared
      ) {
        const target = skillCatalog[1]!;
        expect([id(7), id(17)]).toContain(target);
        expect([...url.searchParams.keys()]).toEqual(['workspaceId']);
        expect(url.searchParams.get('workspaceId')).toBe(id(4));
        expect(request.headers()['x-allrice-workspace-id']).toBe(id(4));
        return route.fulfill(
          json(
            EmployeeSkillCatalogSchema.parse({
              instanceId: target,
              canInstall: true,
              platformSkills: [],
              personalSkills: [],
            }),
          ),
        );
      }
      const instanceRead = path.match(
        /^\/api\/v1\/employee-instances\/([^/]+)(?:\/(scene-skills))?$/,
      );
      if (instanceRead && request.method() === 'GET') {
        const target = instanceRead[1]!;
        expect([id(7), id(17)]).toContain(target);
        expect(url.searchParams.get('workspaceId')).toBe(id(4));
        const profile = detailsFor(target).profile;
        if (instanceRead[2])
          return route.fulfill(
            json(
              EmployeeSceneSkillCatalogSchema.parse({
                instanceId: target,
                employeeId: target === id(7) ? id(9) : id(19),
                skills: [],
              }),
            ),
          );
        return route.fulfill(
          json({
            instance: EmployeeInstanceSchema.parse({
              id: target,
              assignmentId: target,
              organizationId: id(3),
              workspaceId: id(4),
              ownerId: id(5),
              kind: 'general',
              revision: profile.revision,
              profile: { name: profile.name },
              creationSource: profile.source,
              source: profile.source,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
            }),
          }),
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

  it.each([320, 390])(
    'keeps the real memory manager header in one row at %s px',
    async (width) => {
      const f = await fixture({ width });
      try {
        const details = await f.openDetails();
        await details
          .getByRole('region', { name: '记忆', exact: true })
          .getByRole('button', { name: '查看', exact: true })
          .click();
        const manager = f.page.getByRole('region', {
          name: '个人记忆',
          exact: true,
        });
        await manager
          .getByRole('heading', { name: '流程哥 · 记忆', exact: true })
          .waitFor();
        const geometry = await manager
          .locator('header')
          .first()
          .evaluate((header) => {
            const children = Array.from(header.children).map((child) =>
              child.getBoundingClientRect(),
            );
            const rect = header.getBoundingClientRect();
            return {
              direction: getComputedStyle(header).flexDirection,
              centres: children.map((child) => child.top + child.height / 2),
              left: rect.left,
              right: rect.right,
              childLeft: Math.min(...children.map((child) => child.left)),
              childRight: Math.max(...children.map((child) => child.right)),
              scrollWidth: header.scrollWidth,
              clientWidth: header.clientWidth,
              viewport: innerWidth,
            };
          });
        expect(geometry.direction).toBe('row');
        expect(
          Math.max(...geometry.centres) - Math.min(...geometry.centres),
        ).toBeLessThan(1);
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
        expect(geometry.childLeft).toBeGreaterThanOrEqual(geometry.left);
        expect(geometry.childRight).toBeLessThanOrEqual(geometry.right + 1);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
      } finally {
        await f.close();
      }
    },
  );

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
        await contains(manager, '生效中');
        await manager
          .getByRole('heading', { name: '流程哥 · 记忆', exact: true })
          .waitFor();
        expect(
          await manager.getByText('（确认后生效）', { exact: true }).count(),
        ).toBe(1);
        expect(
          await manager
            .getByText('管理员可以查看你的记忆。', { exact: false })
            .count(),
        ).toBe(0);
        const memoryVisual = await manager.evaluate((node) => {
          // Native TabHost publishes these attributes on the same section;
          // dockkit.module.css paints .tabHost:not(.float) with bg-base.
          // The AllRice outer aside is deliberately transparent.
          const host = node.closest(
            '[data-dockkit-content][data-dockkit-pane]',
          )!;
          const surface = getComputedStyle(host).backgroundColor;
          const text = getComputedStyle(node).color;
          const rgba = surface.match(/[\d.]+/g)!.map(Number);
          return {
            background: surface,
            backgroundAlpha: rgba.length === 4 ? rgba[3] : 1,
            paintNode: 'native-dock-tab-host',
            text,
            backgroundChannels: rgba.slice(0, 3),
            textChannels: text
              .match(/[\d.]+/g)!
              .slice(0, 3)
              .map(Number),
            theme: document.documentElement.dataset.theme,
            darkAttribute: document.body.hasAttribute('data-ds-dark-theme'),
          };
        });
        expect(memoryVisual.backgroundAlpha).toBe(1);
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
        '生效中',
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

  // External host activation is invoked through the real native controls while
  // the modal owns pointer input. This exercises retained panes, not a second UI.
  const activate = (control: Locator) => control.evaluate((node) => (node as HTMLButtonElement).click());

  it('retains the unknown request key after closing and reopening a real native Dock tab', async () => {
    const f = await fixture();
    try {
      const details = await f.openDetails('流程哥');
      await details.getByRole('region', { name: '记忆', exact: true }).getByRole('button', { name: '查看', exact: true }).click();
      let manager = f.page.getByRole('region', { name: '个人记忆', exact: true });
      await contains(manager, '生效中');
      await manager.getByRole('button', { name: '＋ 新增', exact: true }).click();
      let form = f.page.getByRole('form', { name: '流程哥 · 新增记忆', exact: true });
      await form.getByLabel(/一句话/).fill('明确重填原请求以恢复回执');
      f.state.loseNextSaveAck = true;
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await form.getByRole('alert').filter({ hasText: '暂时无法确认保存结果。' }).waitFor();
      await f.page.keyboard.press('Escape');
      const tab = f.page.getByRole('tab').filter({ hasText: '记忆' });
      await tab.getByRole('button', { name: '关闭标签', exact: true }).click();
      await tab.waitFor({ state: 'detached' });
      let reopened = f.page.getByRole('dialog', { name: '流程哥员工详情', exact: true });
      if (!(await reopened.isVisible())) reopened = await f.openDetails('流程哥');
      await reopened.getByRole('region', { name: '记忆', exact: true }).getByRole('button', { name: '查看', exact: true }).click();
      manager = f.page.getByRole('region', { name: '个人记忆', exact: true });
      await contains(manager, '生效中');
      expect(f.state.writes).toHaveLength(1);
      await manager.getByRole('button', { name: '＋ 新增', exact: true }).click();
      form = f.page.getByRole('form', { name: '流程哥 · 新增记忆', exact: true });
      expect(await form.getByLabel(/一句话/).inputValue()).toBe('');
      await form.getByLabel(/一句话/).fill('明确重填原请求以恢复回执');
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await f.page.getByRole('dialog', { name: '新增记忆', exact: true }).waitFor({ state: 'detached' });
      expect(f.state.writes).toHaveLength(2);
      expect(f.state.writes[0]!.body).toEqual(f.state.writes[1]!.body);
      expect(f.state.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it('hides the pane-owned modal on native dock activation and restores its draft', async () => {
    const f = await fixture();
    try {
      const details = await f.openDetails();
      await details.getByRole('region', { name: '记忆', exact: true })
        .getByRole('button', { name: '查看', exact: true }).click();
      const manager = f.page.getByRole('region', { name: '个人记忆', exact: true });
      await contains(manager, '生效中');
      await manager.getByRole('button', { name: '＋ 新增', exact: true }).click();
      let form = f.page.getByRole('form', { name: '流程哥 · 新增记忆', exact: true });
      await form.getByLabel(/一句话/).fill('切换标签保留的记忆草稿');
      await activate(f.page.getByRole('button', { name: '工作区文件', exact: true }));
      await expect.poll(() => manager.isVisible()).toBe(false);
      expect(await f.page.getByRole('dialog', { name: '新增记忆', exact: true }).count()).toBe(0);
      await f.page.getByRole('tab').filter({ hasText: '记忆' }).click();
      form = f.page.getByRole('form', { name: '流程哥 · 新增记忆', exact: true });
      expect(await form.getByLabel(/一句话/).inputValue()).toBe('切换标签保留的记忆草稿');
      await f.page.keyboard.press('Escape');
      await f.page.getByRole('button', { name: '返回员工详情', exact: true }).click();
      await contains(f.page.getByRole('dialog', { name: '流程哥员工详情', exact: true }), '65 条');
      expect(f.state.writes).toEqual([]);
      expect(f.state.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it.each([1440, 390])('keeps employee drafts isolated across native memory tabs at %ipx', async (width) => {
    const f = await fixture({ width });
    try {
      const rice = await f.openDetails('Rice');
      await rice.getByRole('region', { name: '记忆', exact: true }).getByRole('button', { name: '查看', exact: true }).click();
      let manager = f.page.getByRole('region', { name: '个人记忆', exact: true });
      await contains(manager, '生效中');
      await manager.getByRole('button', { name: '＋ 新增', exact: true }).click();
      await f.page.getByRole('form', { name: 'Rice · 新增记忆', exact: true }).getByLabel(/一句话/).fill('Rice 独立记忆草稿');
      await activate(f.page.getByRole('button', { name: '返回员工详情', exact: true }));
      await f.page.getByRole('dialog', { name: 'Rice员工详情', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
      const flow = await f.openDetails('流程哥');
      await flow.getByRole('region', { name: '记忆', exact: true }).getByRole('button', { name: '查看', exact: true }).click();
      manager = f.page.getByRole('region', { name: '个人记忆', exact: true });
      await contains(manager, '生效中');
      await manager.getByRole('button', { name: '＋ 新增', exact: true }).click();
      await f.page.getByRole('form', { name: '流程哥 · 新增记忆', exact: true }).getByLabel(/一句话/).fill('流程哥独立记忆草稿');
      const tabs = f.page.getByRole('tab').filter({ hasText: '记忆' });
      expect(await tabs.count()).toBe(2);
      await activate(tabs.first());
      const riceForm = f.page.getByRole('form', { name: 'Rice · 新增记忆', exact: true });
      await riceForm.waitFor();
      expect(await riceForm.getByLabel(/一句话/).inputValue()).toBe('Rice 独立记忆草稿');
      expect(await f.page.getByRole('form', { name: '流程哥 · 新增记忆', exact: true }).count()).toBe(0);
      await activate(tabs.last());
      const flowForm = f.page.getByRole('form', { name: '流程哥 · 新增记忆', exact: true });
      await flowForm.waitFor();
      expect(await flowForm.getByLabel(/一句话/).inputValue()).toBe('流程哥独立记忆草稿');
      await f.page.keyboard.press('Escape');
      await f.page.getByRole('button', { name: '返回员工详情', exact: true }).click();
      await contains(f.page.getByRole('dialog', { name: '流程哥员工详情', exact: true }), '65 条');
      expect(f.state.writes).toEqual([]);
      expect(f.state.errors).toEqual([]);
    } finally { await f.close(); }
  }, 30_000);

  it('all host memory entries retire the experience collector while the explicit detail target stays independent', async () => {
    const f = await fixture({ legacy: true });
    try {
      await f.page.getByRole('button', { name: '记忆', exact: true }).click();
      const old = f.page.getByRole('region', { name: '记忆', exact: true });
      await old
        .getByRole('region', { name: '个人记忆', exact: true })
        .waitFor();
      for (const name of ['已生效经验', '积累与采用记录'])
        expect(
          await old.getByRole('button', { name, exact: true }).count(),
        ).toBe(0);
      expect(
        f.state.reads.filter((read) => read.path === '/api/v1/experiences'),
      ).toEqual([]);
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
        '生效中',
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

  it('keeps an existing legacy memory pane when another pane opens personal memory', async () => {
    const f = await fixture({ legacy: true });
    try {
      await f.page.getByRole('button', { name: '记忆', exact: true }).click();
      const oldPaneId = await f.page.getByRole('region', { name: '记忆', exact: true })
        .evaluate((node) => node.closest('[data-dockkit-pane]')?.getAttribute('data-dockkit-pane'));
      expect(oldPaneId).toBeTruthy();
      const old = f.page.locator('[data-dockkit-pane=' + JSON.stringify(oldPaneId) + ']');
      const oldManager = old.getByRole('region', { name: '个人记忆', exact: true });
      await contains(oldManager, '生效中');
      await f.page.getByRole('button', { name: '并排查看', exact: true }).click();
      await expect.poll(() => f.page.locator('[data-dockkit-pane]').count()).toBe(2);
      const details = await f.openDetails('流程哥');
      await details.getByRole('region', { name: '记忆', exact: true }).getByRole('button', { name: '查看', exact: true }).click();
      const personal = f.page.locator('[data-dockkit-pane]:not([data-dockkit-pane=' + JSON.stringify(oldPaneId) + '])')
        .getByRole('region', { name: '个人记忆', exact: true });
      await contains(personal, '生效中');
      expect(await oldManager.isVisible()).toBe(true);
      await oldManager.getByRole('heading', { name: 'Rice · 记忆', exact: true }).waitFor();
      await personal.getByRole('heading', { name: '流程哥 · 记忆', exact: true }).waitFor();
      expect(f.state.writes).toEqual([]);
      expect(f.state.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it('keeps a hidden pane draft and exactly one in-flight request when the same target reopens', async () => {
    const f = await fixture({ host: 'lifecycle' });
    const writeGate = gate();
    try {
      const manager = f.page.getByRole('region', { name: '个人记忆', exact: true });
      await contains(manager, '生效中');
      await manager.getByRole('button', { name: '＋ 新增', exact: true }).click();
      let form = f.page.getByRole('form', { name: '流程哥 · 新增记忆', exact: true });
      await form.getByLabel(/一句话/).fill('切标签保留的记忆草稿');
      await activate(f.page.locator('#switch-tab'));
      expect(await f.page.getByRole('dialog').count()).toBe(0);
      await f.page.locator('#reopen-target').click();
      await f.page.locator('#switch-tab').click();
      form = f.page.getByRole('form', { name: '流程哥 · 新增记忆', exact: true });
      await form.waitFor();
      expect(await form.getByLabel(/一句话/).inputValue()).toBe('切标签保留的记忆草稿');
      f.state.writeGate = writeGate.promise;
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await expect.poll(() => f.state.writes.length).toBe(1);
      await activate(f.page.locator('#switch-tab'));
      expect(await f.page.getByRole('dialog').count()).toBe(0);
      await f.page.locator('#reopen-target').click();
      await f.page.locator('#switch-tab').click();
      form = f.page.getByRole('form', { name: '流程哥 · 新增记忆', exact: true });
      await form.waitFor();
      expect(await form.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(true);
      expect(await form.getByLabel(/一句话/).inputValue()).toBe('切标签保留的记忆草稿');
      writeGate.release();
      await f.page.getByRole('dialog', { name: '新增记忆', exact: true }).waitFor({ state: 'detached' });
      await contains(manager, '切标签保留的记忆草稿');
      expect(f.state.writes).toHaveLength(1);
      expect(f.state.writes[0]?.body).toMatchObject({ instanceId: id(17), summary: '切标签保留的记忆草稿', details: null });
      expect(f.state.writes[0]?.body).not.toHaveProperty('contentDigest');
      expect(f.state.errors).toEqual([]);
    } finally { writeGate.release(); await f.close(); }
  });
});
