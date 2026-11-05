/** Actual tenant, detail, native Modal and lifecycle UI; scoped synthetic HTTP. */
import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defaultUserPreferences,
  defaultWorkAutomation,
  EmployeeDetailsSchema,
  EmployeeInstanceLifecycleInputSchema,
  EmployeeInstanceSchema,
  employeeColorPalette,
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
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
const json = (value: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(value),
});
async function expectMobileRoot(dialog: Locator) {
  const geometry = await dialog.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const heading = node.querySelector('h2')!;
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
      radius: getComputedStyle(node).borderRadius,
      font: getComputedStyle(heading).fontSize,
      line: getComputedStyle(heading).lineHeight,
    };
  });
  expect(geometry).toEqual({
    x: 0,
    y: 0,
    width: geometry.viewportWidth,
    height: geometry.viewportHeight,
    viewportWidth: geometry.viewportWidth,
    viewportHeight: geometry.viewportHeight,
    radius: '0px',
    font: '20px',
    line: '28px',
  });
  console.info('U1 archive mobile root geometry', JSON.stringify(geometry));
}
async function expectMobileConfirmation(dialog: Locator) {
  const card = await dialog.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const layoutWidth = document.documentElement.clientWidth;
    return {
      left: rect.left,
      right: layoutWidth - rect.right,
      width: rect.width,
      height: rect.height,
      layoutWidth,
      layoutHeight: document.documentElement.clientHeight,
      windowWidth: innerWidth,
      radius: getComputedStyle(node).borderRadius,
      font: getComputedStyle(node.querySelector('h2')!).fontSize,
      line: getComputedStyle(node.querySelector('h2')!).lineHeight,
      buttons: [...node.querySelectorAll('footer button')].map(
        (button) => button.getBoundingClientRect().height,
      ),
    };
  });
  expect(card.left).toBe(20);
  expect(card.right).toBe(20);
  expect(card.width).toBe(card.layoutWidth - 40);
  expect(card.height).toBeLessThan(card.layoutHeight - 40);
  expect(card.radius).toBe('20px');
  expect(card.font).toBe('20px');
  expect(card.line).toBe('28px');
  expect(card.buttons).toHaveLength(2);
  for (const height of card.buttons) expect(height).toBeGreaterThanOrEqual(44);
  console.info('U1 archive mobile confirmation geometry', JSON.stringify(card));
}
function instance(n: number, archived = false) {
  return EmployeeInstanceSchema.parse({
    id: id(n),
    assignmentId: id(n),
    organizationId: id(3),
    workspaceId: id(4),
    ownerId: id(5),
    kind: n === 7 ? 'general' : 'custom',
    revision: 2,
    profile: {
      name: n === 7 ? 'Rice' : '流程哥',
      mission: '保留现使命',
      workStyle: '保留现工作方式',
      appearance: {
        avatarType: 'initials',
        avatarValue: n === 7 ? 'R' : '流',
        accentColor: 'teal',
      },
    },
    creationSource: { kind: 'tenant_version', employeeVersionId: id(n + 1) },
    source: { kind: 'tenant_version', employeeVersionId: id(n + 1) },
    createdAt: now,
    updatedAt: now,
    archivedAt: archived ? now : null,
  });
}
function details(n: number, canArchive = n !== 7) {
  const data = employeeDetailsFixture();
  data.profile.instanceId = id(n);
  data.profile.kind = n === 7 ? 'general' : 'custom';
  data.profile.name = n === 7 ? 'Rice' : '流程哥';
  data.profile.revision = 2;
  data.profile.source = instance(n).source;
  data.profile.appearance = instance(n).profile.appearance;
  data.profile.canArchive = canArchive;
  data.profile.isDefaultRice = n === 7;
  data.content.instanceId = id(n);
  data.content.employeeId = id(n + 2);
  return EmployeeDetailsSchema.parse(data);
}
const session = (n: number) => ({
  id: id(n === 17 ? 1 : 2),
  ownerId: id(5),
  title: n === 17 ? '保留的员工旧对话' : 'Rice 的工作',
  employeeAssignmentId: id(n),
  employeeInstanceId: id(n),
  employeeVersionId: id(n + 1),
  employeeName: n === 17 ? '流程哥' : 'Rice',
  visibility: 'private',
  updatedAt: now,
  archivedAt: null,
});

suite('U1 employee archive lifecycle', () => {
  let browser: Browser, server: Server, origin: string;
  const evidence = resolve('.local/met249-u1-archive');
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/employee-archive-page.tsx'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/employee-archive-fixture',
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
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-archive-page.css"><div id="root"></div><script type="module" src="/employee-archive-page.js"></script>',
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No fixture port');
    origin = `http://127.0.0.1:${address.port}`;
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
    console.info(`U1 archive evidence: ${evidence}`);
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
      archived?: boolean;
      shared?: boolean;
      cannotArchive?: boolean;
      paginate?: boolean;
      holdWrite?: boolean;
      holdSelected?: boolean;
      generalEmpty?: boolean;
      sessionArchived?: boolean;
      failArchivedSessions?: boolean;
      selectedRice?: boolean;
    } = {},
  ) {
    const page = await browser.newPage({
      viewport: { width: options.width ?? 1440, height: 950 },
      colorScheme: options.dark ? 'dark' : 'light',
      reducedMotion: 'reduce',
    });
    page.setDefaultTimeout(8000);
    const preferences = {
      ...defaultUserPreferences,
      appearance: options.dark ? ('dark' as const) : ('light' as const),
    };
    const writeGate = gate(),
      selectedGate = gate();
    const state = {
      instances: [instance(7), instance(17, options.archived)],
      writes: [] as Array<{
        path: string;
        body: ReturnType<typeof EmployeeInstanceLifecycleInputSchema.parse>;
      }>,
      blockedWrites: [] as string[],
      errors: [] as string[],
      historyReads: [] as string[],
      failWrite: false,
      deny: false,
      dropReceipt: false,
      denyReadback: false,
      failReadback: false,
      heldWrite: options.holdWrite ? writeGate.promise : null,
      heldSelected: options.holdSelected ? selectedGate.promise : null,
      selectedReads: 0,
      archivedSessionReads: 0,
      failArchivedSessions: Boolean(options.failArchivedSessions),
      sessionTitles: new Map<string, string>(),
    };
    const flowName = options.generalEmpty ? '项目助理' : '流程哥';
    if (options.generalEmpty) {
      state.instances[1]!.kind = 'general';
      state.instances[1]!.profile = {};
    }
    const currentDetails = (n: number, canArchive = n !== 7) => {
      const data = details(n, canArchive);
      if (n === 17 && options.generalEmpty) {
        data.profile.kind = 'general';
        data.profile.name = flowName;
        data.profile.appearance = {
          avatarType: 'initials',
          avatarValue: '项',
          accentColor: 'rose',
        };
      }
      return EmployeeDetailsSchema.parse(data);
    };
    const currentSession = (n: number) => {
      const row = session(n);
      return {
        ...row,
        title: state.sessionTitles.get(row.id) ?? row.title,
        employeeName: n === 17 ? flowName : row.employeeName,
        archivedAt: n === 17 && options.sessionArchived ? now : null,
      };
    };
    page.on('pageerror', (error) => state.errors.push(error.message));
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname;
      const single =
        /^\/api\/v1\/employee-instances\/([a-f0-9-]{36})(?:\/(lifecycle|content))?$/.exec(
          path,
        );
      if (single) {
        const current = state.instances.find((row) => row.id === single[1]);
        if (!current)
          return route.fulfill(
            json(
              { error: { code: 'RESOURCE_NOT_FOUND', message: 'Unavailable' } },
              404,
            ),
          );
        if (single[2] === 'lifecycle') {
          const body = EmployeeInstanceLifecycleInputSchema.parse(
            request.postDataJSON(),
          );
          state.writes.push({ path, body });
          if (state.heldWrite) await state.heldWrite;
          if (state.deny)
            return route.fulfill(
              json(
                {
                  error: {
                    code: 'AUTHORIZATION_DENIED',
                    message: '没有访问权限。',
                  },
                },
                403,
              ),
            );
          if (current.id === id(7) && body.operation === 'archive')
            return route.fulfill(
              json(
                {
                  error: {
                    code: 'DEFAULT_EMPLOYEE_PROTECTED',
                    message: '默认员工不能归档。',
                  },
                },
                409,
              ),
            );
          if (state.failWrite || body.expectedRevision !== current.revision)
            return route.fulfill(
              json(
                {
                  error: {
                    code: 'VERSION_CONFLICT',
                    message: '员工已变化，请重试。',
                  },
                },
                409,
              ),
            );
          current.revision++;
          current.archivedAt = body.operation === 'archive' ? now : null;
          if (state.dropReceipt) {
            state.dropReceipt = false;
            return route.abort('failed');
          }
          return route.fulfill(json({ instance: current }));
        }
        if (request.method() !== 'GET') {
          state.blockedWrites.push(path);
          return route.fulfill(
            json({ error: { message: 'not part of this fixture' } }, 409),
          );
        }
        if (single[2] === 'content')
          return route.fulfill(
            current.archivedAt
              ? json(
                  {
                    error: {
                      code: 'EMPLOYEE_INSTANCE_ARCHIVED',
                      message:
                        'AI 员工已归档，可以查看历史；恢复后才能继续工作。',
                    },
                  },
                  409,
                )
              : json(
                  currentDetails(
                    current.id === id(7) ? 7 : 17,
                    current.id !== id(7) && !options.cannotArchive,
                  ),
                ),
          );
        state.selectedReads++;
        const snapshot = structuredClone(current);
        if (state.heldSelected && current.id === id(17))
          await state.heldSelected;
        if (state.denyReadback)
          return route.fulfill(
            json({ error: { message: '没有访问权限。' } }, 403),
          );
        if (state.failReadback)
          return route.fulfill(
            json({ error: { message: '读取暂不可用。' } }, 503),
          );
        return route.fulfill(json({ instance: snapshot }));
      }
      if (path === '/api/v1/employee-instances' && request.method() === 'GET') {
        state.historyReads.push(url.searchParams.get('beforeId') ?? 'first');
        const first = options.paginate && !url.searchParams.has('beforeId');
        return route.fulfill(
          json({
            instances: first
              ? [state.instances[0]!]
              : options.paginate
                ? [state.instances[1]!]
                : state.instances,
            nextBeforeId: first ? id(7) : null,
          }),
        );
      }
      if (path.includes('/ai-instances/') && path.endsWith('/content')) {
        const shared = currentDetails(17);
        shared.profile.canArchive = false;
        shared.profile.canMaintainPersonal = false;
        shared.profile.editableFields = [];
        shared.profile.expressionStyle = undefined;
        shared.profile.personalFields = [];
        shared.content.common = [];
        shared.content.scenes = [];
        shared.content.sources = [];
        shared.content.layers = [];
        return route.fulfill(
          json({
            organizationId: id(3),
            userId: id(5),
            visibility: 'shared_only',
            details: shared,
          }),
        );
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
              sessions: [currentSession(17), currentSession(7)].filter(
                (row) => !row.archivedAt,
              ),
              sessionModels: [],
              employeeProfiles: [7, 17].map((n) => ({
                assignmentId: id(n),
                employeeId: id(n + 2),
                ...currentDetails(n).profile,
                skills: [],
                model: {
                  harness: 'dsh',
                  provider: 'codex',
                  model: 'synthetic',
                  reasoningEffort: 'max',
                },
              })),
              employees: [7, 17].map((n) => ({
                id: id(n),
                employeeId: id(n + 2),
                isDefault: n === 7,
                versions: [],
                instances: state.instances.filter(
                  (row) => row.id === id(n) && !row.archivedAt,
                ),
                currentVersion: {
                  id: id(n + 1),
                  manifest: {
                    name: n === 7 ? 'Rice' : flowName,
                    appearance: currentDetails(n).profile.appearance,
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
      if (path === '/api/v1/me/work-automation')
        return route.fulfill(
          json({
            workspaceId: id(4),
            revision: 0,
            settings: defaultWorkAutomation,
            editable: true,
          }),
        );
      if (path === '/api/v1/sessions' && request.method() === 'GET') {
        const target = url.searchParams.get('employeeInstanceId');
        const archived = url.searchParams.get('archived');
        if (archived === 'only') {
          state.archivedSessionReads++;
          if (state.failArchivedSessions)
            return route.fulfill(
              json({ error: { message: '会话读取暂不可用。' } }, 503),
            );
        }
        const sessions = [currentSession(17), currentSession(7)].filter(
          (row) =>
            (!target || row.employeeInstanceId === target) &&
            (archived === 'only'
              ? Boolean(row.archivedAt)
              : archived === 'true' || !row.archivedAt),
        );
        return route.fulfill(
          json({
            sessions,
            nextCursor: null,
            ...(!target
              ? {
                  employeeGroups: sessions.map((row) => ({
                    employeeAssignmentId: row.employeeAssignmentId,
                    employeeInstanceId: row.employeeInstanceId,
                    employeeName: row.employeeName,
                    count: 1,
                  })),
                }
              : {}),
          }),
        );
      }
      const history = /^\/api\/v1\/sessions\/([a-f0-9-]{36})$/.exec(path);
      if (history && request.method() === 'PATCH') {
        const body: unknown = request.postDataJSON();
        if (
          !body ||
          typeof body !== 'object' ||
          !('title' in body) ||
          typeof body.title !== 'string'
        )
          return route.fulfill(
            json({ error: { message: 'Invalid title' } }, 400),
          );
        state.sessionTitles.set(history[1]!, body.title);
        return route.fulfill(
          json({ session: currentSession(history[1] === id(1) ? 17 : 7) }),
        );
      }
      if (history && request.method() === 'GET')
        return route.fulfill(
          json({
            history: {
              session: currentSession(history[1] === id(1) ? 17 : 7),
              messages: [
                {
                  id: id(90),
                  role: 'assistant',
                  content: { text: '原有对话内容继续可读' },
                  runId: null,
                  status: 'completed',
                  createdAt: now,
                },
              ],
              queuedMessages: [],
              contextStatus: {
                percentage: 0,
                pressureTokens: 0,
                thresholdTokens: 40000,
                compactionDue: false,
              },
              nativeContextStatus: null,
            },
          }),
        );
      if (request.method() !== 'GET') state.blockedWrites.push(path);
      return route.fulfill(
        json(
          {
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'Optional fixture service unavailable',
            },
          },
          404,
        ),
      );
    });
    await page.goto(
      `${origin}/?session=${id(options.selectedRice ? 2 : 1)}${options.shared ? '&shared=1' : ''}${options.dark ? '&theme=dark' : ''}`,
    );
    const openDetails = async (name = flowName) => {
      // Wait for the real workspace and transcript, not an instantaneous
      // visibility sample while the initial shell is still loading.
      await page.getByText('原有对话内容继续可读', { exact: true }).waitFor();
      const sidebar = page.locator('#chat-sidebar');
      const toggle = sidebar.getByRole('button', {
        name: /^(展开|收起)侧边栏$/,
      });
      await toggle.waitFor();
      if ((await toggle.getAttribute('aria-label')) === '展开侧边栏')
        await toggle.click();
      const button = sidebar.getByRole('button', {
        name: `查看${name}详情`,
        exact: true,
      });
      await button.click();
      const dialog = page.getByRole('dialog', {
        name: `${name}员工详情`,
        exact: true,
      });
      await dialog.getByRole('heading', { name: name, exact: true }).waitFor();
      return dialog;
    };
    const begin = async () => {
      const detail = await openDetails();
      await detail
        .getByRole('button', { name: '归档这个员工', exact: true })
        .click();
      const confirm = page.getByRole('dialog', {
        name: `归档“${flowName}”？`,
        exact: true,
      });
      await confirm.waitFor();
      return confirm;
    };
    return {
      page,
      state,
      openDetails,
      begin,
      releaseWrite: writeGate.release,
      releaseSelected: selectedGate.release,
      close: async () => {
        writeGate.release();
        selectedGate.release();
        await page.close();
      },
    };
  }

  it('uses authoritative capability and never offers owner archive in shared details or Rice', async () => {
    for (const options of [{ cannotArchive: true }, { shared: true }]) {
      const f = await fixture(options);
      try {
        const detail = options.shared
          ? f.page.getByRole('dialog')
          : await f.openDetails();
        await detail.getByText('流程哥', { exact: true }).first().waitFor();
        expect(
          await detail
            .getByRole('button', { name: '归档这个员工', exact: true })
            .count(),
        ).toBe(0);
        if (!options.shared) {
          await detail
            .getByRole('button', { name: '关闭', exact: true })
            .click();
          const rice = await f.openDetails('Rice');
          expect(
            await rice
              .getByRole('button', { name: '归档这个员工', exact: true })
              .count(),
          ).toBe(0);
        }
        expect(f.state.writes).toEqual([]);
      } finally {
        await f.close();
      }
    }
  });

  it.each([1440, 390])(
    'archives with no duplicate close, preserves draft on cancel and restores current persona at width %s',
    async (width) => {
      const f = await fixture({ width });
      try {
        const composer = f.page.getByRole('textbox', {
          name: '给 流程哥 的消息',
          exact: true,
        });
        await composer.fill('仍需保留的草稿');
        for (const exit of ['Escape', '取消', '遮罩']) {
          const confirm = await f.begin();
          expect(
            await confirm.getByRole('button', { name: /关闭/ }).count(),
          ).toBe(0);
          if (exit === 'Escape') await f.page.keyboard.press('Escape');
          else if (exit === '取消')
            await confirm
              .getByRole('button', { name: '取消', exact: true })
              .click();
          else
            await confirm
              .locator('..')
              .locator(':scope > [aria-hidden="true"]')
              .click({ position: { x: 2, y: 2 } });
          const returned = f.page.getByRole('dialog', {
            name: '流程哥员工详情',
            exact: true,
          });
          await returned.waitFor();
          expect(f.state.writes, `exit=${exit}`).toEqual([]);
          expect(
            await returned.evaluate((node) =>
              node.contains(document.activeElement),
            ),
            `exit=${exit} must return focus inside the same employee`,
          ).toBe(true);
          await returned
            .getByRole('button', { name: '关闭', exact: true })
            .click();
          expect(await composer.inputValue(), `exit=${exit}`).toBe(
            '仍需保留的草稿',
          );
        }
        const confirm = await f.begin();
        const card = await confirm.evaluate((node) => ({
          x: node.getBoundingClientRect().x,
          width: node.getBoundingClientRect().width,
          height: node.getBoundingClientRect().height,
          radius: getComputedStyle(node).borderRadius,
          font: getComputedStyle(node.querySelector('h2')!).fontSize,
          line: getComputedStyle(node.querySelector('h2')!).lineHeight,
        }));
        expect(card.font).toBe('20px');
        expect(card.line).toBe('28px');
        if (width === 390) await expectMobileConfirmation(confirm);
        await confirm.screenshot({
          path: resolve(evidence, `archive-confirm-${width}.png`),
        });
        await confirm
          .getByRole('button', { name: '归档', exact: true })
          .click();
        const archived = f.page.getByRole('dialog', {
          name: '已归档',
          exact: true,
        });
        await archived.getByText('流程哥', { exact: true }).waitFor();
        if (width === 390) await expectMobileRoot(archived);
        expect(
          await f.page
            .locator('#chat-sidebar')
            .getByRole('button', { name: /查看流程哥.*详情/ })
            .count(),
        ).toBe(0);
        expect(await archived.locator('footer').count()).toBe(0);
        await archived.screenshot({
          path: resolve(evidence, `archive-employees-${width}.png`),
        });
        const before = structuredClone(f.state.instances[1]!.profile);
        await archived
          .getByRole('button', { name: '恢复员工', exact: true })
          .click();
        await expect.poll(() => f.state.writes.length).toBe(2);
        const restore = f.state.writes[1]!.body;
        expect(restore.operation).toBe('restore');
        expect(restore.expectedRevision).toBe(3);
        if (restore.operation !== 'restore')
          throw Error('Expected restore request');
        expect(restore.sourceRevision).toBe(3);
        expect(f.state.instances[1]!.profile).toEqual(before);
        await expect
          .poll(() =>
            archived.getByText('还没有已归档员工', { exact: true }).count(),
          )
          .toBe(1);
        expect(f.state.blockedWrites).toEqual([]);
        expect(f.state.errors).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it('keeps the confirmation and target while the archive request is pending', async () => {
    const f = await fixture({ holdWrite: true });
    try {
      const confirm = await f.begin();
      await confirm.getByRole('button', { name: '归档', exact: true }).click();
      await expect.poll(() => f.state.writes.length).toBe(1);
      await f.page.keyboard.press('Escape');
      expect(await confirm.isVisible()).toBe(true);
      expect(
        await confirm
          .getByRole('button', { name: '取消', exact: true })
          .isDisabled(),
      ).toBe(true);
      f.releaseWrite();
      await f.page
        .getByRole('dialog', { name: '已归档', exact: true })
        .waitFor();
    } finally {
      await f.close();
    }
  });

  it('reads back a rejected archive before showing the approved failure and keeps the row active', async () => {
    const f = await fixture();
    try {
      f.state.failWrite = true;
      const confirm = await f.begin();
      const initialReads = f.state.selectedReads;
      await confirm.getByRole('button', { name: '归档', exact: true }).click();
      await confirm
        .getByText('归档失败，员工尚未归档。请重试。', { exact: true })
        .waitFor();
      expect(f.state.selectedReads).toBeGreaterThan(initialReads);
      expect(f.state.instances[1]!.archivedAt).toBeNull();
      expect(
        await f.page
          .getByRole('dialog', { name: '已归档', exact: true })
          .count(),
      ).toBe(0);
    } finally {
      await f.close();
    }
  });

  it('uses current archivedAt across mixed history pages and keeps unarchived old conversations read-only', async () => {
    const f = await fixture({ archived: true, paginate: true });
    try {
      await f.page
        .getByText('AI 员工已归档，可以查看历史；恢复后才能继续工作。', {
          exact: true,
        })
        .waitFor();
      expect(
        await f.page.getByText('原有对话内容继续可读', { exact: true }).count(),
      ).toBe(1);
      expect(
        await f.page.getByRole('textbox', { name: /给.*的消息/ }).count(),
      ).toBe(0);
      expect(f.state.historyReads).toContain(id(7));
      expect(
        await f.page
          .locator('#chat-sidebar')
          .getByText('流程哥', { exact: true })
          .count(),
      ).toBe(0);
      await f.page
        .getByRole('button', { name: '查看归档', exact: true })
        .last()
        .click();
      const dialog = f.page.getByRole('dialog', {
        name: '已归档',
        exact: true,
      });
      await dialog
        .getByRole('button', { name: '查看对话', exact: true })
        .click();
      await dialog.getByText('保留的员工旧对话', { exact: true }).waitFor();
      expect(f.state.writes).toEqual([]);
      expect(f.state.blockedWrites).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('reconciles a lost receipt by current read instead of reporting a false failure', async () => {
    const f = await fixture();
    try {
      f.state.dropReceipt = true;
      const confirm = await f.begin();
      await confirm.getByRole('button', { name: '归档', exact: true }).click();
      await f.page
        .getByRole('dialog', { name: '已归档', exact: true })
        .getByText('流程哥', { exact: true })
        .waitFor();
      expect(f.state.writes.length).toBe(1);
      expect(
        await f.page
          .getByText('归档失败，员工尚未归档。请重试。', { exact: true })
          .count(),
      ).toBe(0);
    } finally {
      await f.close();
    }
  });

  it('drops a late current-instance read after selecting another employee', async () => {
    const f = await fixture({ holdSelected: true });
    try {
      await expect.poll(() => f.state.selectedReads).toBeGreaterThan(0);
      const rice = f.page.locator(`[data-row-key="workspace:${id(7)}"]`);
      if ((await rice.getAttribute('aria-expanded')) !== 'true')
        await rice.click();
      await f.page.locator(`[data-row-key="session:${id(2)}"]`).click();
      f.releaseSelected();
      await f.page
        .getByRole('textbox', { name: '给 Rice 的消息', exact: true })
        .waitFor();
      expect(
        await f.page
          .getByText('AI 员工已归档，可以查看历史；恢复后才能继续工作。', {
            exact: true,
          })
          .count(),
      ).toBe(0);
      expect(f.state.writes).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('reuses the same requestId after a genuinely unconfirmed write without claiming failure', async () => {
    const f = await fixture();
    try {
      const confirm = await f.begin();
      f.state.dropReceipt = true;
      f.state.failReadback = true;
      await confirm.getByRole('button', { name: '归档', exact: true }).click();
      await confirm
        .getByRole('button', { name: '重试', exact: true })
        .waitFor();
      expect(
        await confirm
          .getByText('归档失败，员工尚未归档。请重试。', { exact: true })
          .count(),
      ).toBe(0);
      f.state.failReadback = false;
      await confirm.getByRole('button', { name: '重试', exact: true }).click();
      await f.page
        .getByRole('dialog', { name: '已归档', exact: true })
        .waitFor();
      expect(f.state.writes.length).toBe(2);
      expect(f.state.writes[1]!.body).toEqual(f.state.writes[0]!.body);
    } finally {
      await f.close();
    }
  });

  it('keeps an employee archived after a rejected restore and reads the current revision on retry', async () => {
    const f = await fixture({ archived: true });
    try {
      await f.page
        .getByRole('button', { name: '查看归档', exact: true })
        .last()
        .click();
      const dialog = f.page.getByRole('dialog', {
        name: '已归档',
        exact: true,
      });
      f.state.failWrite = true;
      await dialog
        .getByRole('button', { name: '恢复员工', exact: true })
        .click();
      await dialog
        .getByText('恢复失败，员工仍处于归档状态。请重试。', { exact: true })
        .waitFor();
      expect(f.state.instances[1]!.archivedAt).toBe(now);
      f.state.failWrite = false;
      await dialog
        .getByRole('button', { name: '恢复员工', exact: true })
        .click();
      await expect
        .poll(() =>
          dialog.getByText('还没有已归档员工', { exact: true }).count(),
        )
        .toBe(1);
      expect(f.state.blockedWrites).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('hands rename keyboard ownership back to the same archive page after Escape and save', async () => {
    const f = await fixture({ sessionArchived: true });
    try {
      await f.page
        .getByRole('button', { name: '查看归档', exact: true })
        .last()
        .click();
      const dialog = f.page.getByRole('dialog', {
        name: '已归档',
        exact: true,
      });
      await dialog.getByRole('tab', { name: '对话', exact: true }).click();
      const row = dialog.locator(`[data-row-key="session:${id(1)}"]`);
      const openRename = async () => {
        await row.hover();
        await row.getByRole('button', { name: /^会话.*的操作$/ }).click();
        await f.page
          .getByRole('menuitem', { name: '重命名', exact: true })
          .click();
        const rename = f.page.getByRole('dialog', {
          name: '重命名会话',
          exact: true,
        });
        await rename
          .getByRole('textbox', { name: '会话名称', exact: true })
          .waitFor();
        return rename;
      };
      let rename = await openRename();
      expect(await dialog.count()).toBe(0);
      const input = rename.getByRole('textbox', {
        name: '会话名称',
        exact: true,
      });
      expect(
        await input.evaluate((node) => node === document.activeElement),
      ).toBe(true);
      await f.page.keyboard.press('Tab');
      expect(
        await rename
          .getByRole('button', { name: '取消', exact: true })
          .evaluate((node) => node === document.activeElement),
      ).toBe(true);
      await f.page.keyboard.press('Shift+Tab');
      expect(
        await input.evaluate((node) => node === document.activeElement),
      ).toBe(true);
      await f.page.keyboard.press('Shift+Tab');
      expect(
        await rename
          .getByRole('button', { name: '关闭', exact: true })
          .evaluate((node) => node === document.activeElement),
      ).toBe(true);
      await f.page.keyboard.press('Shift+Tab');
      expect(
        await rename
          .getByRole('button', { name: '保存', exact: true })
          .evaluate((node) => node === document.activeElement),
      ).toBe(true);
      await f.page.keyboard.press('Escape');
      await dialog.getByRole('tab', { name: '对话', selected: true }).waitFor();
      expect(await rename.count()).toBe(0);
      expect(
        await dialog.evaluate((node) => node.contains(document.activeElement)),
      ).toBe(true);
      await row.getByText('保留的员工旧对话', { exact: true }).waitFor();
      rename = await openRename();
      await rename
        .getByRole('textbox', { name: '会话名称', exact: true })
        .fill('改名后的旧对话');
      await rename.getByRole('button', { name: '保存', exact: true }).click();
      await row.getByText('改名后的旧对话', { exact: true }).waitFor();
      expect(
        await dialog.getByRole('tab', { name: '对话', selected: true }).count(),
      ).toBe(1);
      expect(
        await dialog.evaluate((node) => node.contains(document.activeElement)),
      ).toBe(true);
      expect(f.state.sessionTitles.get(id(1))).toBe('改名后的旧对话');
      expect(f.state.writes).toEqual([]);
      expect(f.state.blockedWrites).toEqual([]);
      expect(f.state.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it.each([false, true])(
    'retries failed archived conversation reads without claiming empty or losing retained rows: retained=%s',
    async (retained) => {
      const f = await fixture({
        sessionArchived: true,
        failArchivedSessions: !retained,
        selectedRice: true,
      });
      try {
        await f.page
          .getByRole('button', { name: '查看归档', exact: true })
          .last()
          .click();
        const dialog = f.page.getByRole('dialog', {
          name: '已归档',
          exact: true,
        });
        await dialog.getByRole('tab', { name: '对话', exact: true }).click();
        const title = dialog.getByText('保留的员工旧对话', { exact: true });
        if (retained) {
          await title.waitFor();
          f.state.failArchivedSessions = true;
          await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
        }
        await dialog
          .getByRole('alert')
          .getByText('会话读取暂不可用。', { exact: true })
          .waitFor();
        expect(
          await dialog.getByText('暂无已归档会话', { exact: true }).count(),
        ).toBe(0);
        expect(await title.count()).toBe(retained ? 1 : 0);
        const before = f.state.archivedSessionReads;
        f.state.failArchivedSessions = false;
        await dialog
          .getByRole('button', { name: '重新加载会话列表', exact: true })
          .click();
        await title.waitFor();
        await expect.poll(() => dialog.getByRole('alert').count()).toBe(0);
        expect(f.state.archivedSessionReads).toBeGreaterThan(before);
        expect(f.state.writes).toEqual([]);
        expect(f.state.blockedWrites).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it('keeps a general employee with empty overrides identifiable by its real name and template color through archive and restore', async () => {
    const f = await fixture({ generalEmpty: true });
    try {
      const confirm = await f.begin();
      await confirm.getByRole('button', { name: '归档', exact: true }).click();
      const dialog = f.page.getByRole('dialog', {
        name: '已归档',
        exact: true,
      });
      const heading = dialog.getByRole('heading', {
        name: '项目助理',
        exact: true,
      });
      await heading.waitFor();
      const row = dialog.locator('article').filter({
        has: f.page.getByRole('heading', { name: '项目助理', exact: true }),
      });
      expect(await row.locator('span[aria-hidden="true"]').textContent()).toBe(
        '项',
      );
      expect(
        await row
          .locator('span[aria-hidden="true"]')
          .evaluate((node) =>
            (node as HTMLElement).style.getPropertyValue('--employee-start'),
          ),
      ).toBe(employeeColorPalette.rose.value);
      expect(await dialog.getByText('AI 员工', { exact: true }).count()).toBe(
        0,
      );
      expect(f.state.instances[1]!.profile).toEqual({});
      expect(f.state.writes[0]?.path).toBe(
        `/api/v1/employee-instances/${id(17)}/lifecycle`,
      );
      await row.getByRole('button', { name: '恢复员工', exact: true }).click();
      await expect
        .poll(() =>
          dialog.getByText('还没有已归档员工', { exact: true }).count(),
        )
        .toBe(1);
      expect(f.state.instances[1]!.profile).toEqual({});
      expect(f.state.writes[1]?.body.operation).toBe('restore');
      expect(f.state.writes[1]?.path).toBe(
        `/api/v1/employee-instances/${id(17)}/lifecycle`,
      );
      expect(f.state.blockedWrites).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('uses the approved full-screen archive root through the 641 to 700 px mobile breakpoint', async () => {
    const f = await fixture({ width: 680 });
    try {
      const confirm = await f.begin();
      await expectMobileConfirmation(confirm);
      await confirm.getByRole('button', { name: '归档', exact: true }).click();
      const dialog = f.page.getByRole('dialog', {
        name: '已归档',
        exact: true,
      });
      await dialog
        .getByRole('heading', { name: '流程哥', exact: true })
        .waitFor();
      await expectMobileRoot(dialog);
    } finally {
      await f.close();
    }
  });

  it.each([1440, 390])(
    'keeps the archive surface in the saved real dark theme at width %s',
    async (width) => {
      const f = await fixture({ width, dark: true, archived: true });
      try {
        await expect
          .poll(() => f.page.locator('body').getAttribute('data-ds-dark-theme'))
          .not.toBeNull();
        await f.page
          .getByRole('button', { name: '查看归档', exact: true })
          .last()
          .click();
        const dialog = f.page.getByRole('dialog', {
          name: '已归档',
          exact: true,
        });
        await dialog.getByText('流程哥', { exact: true }).waitFor();
        const paint = await dialog.evaluate((node) => ({
          background: getComputedStyle(node).backgroundColor,
          color: getComputedStyle(node).color,
          width: node.getBoundingClientRect().width,
          viewport: innerWidth,
          headingFont: getComputedStyle(node.querySelector('h2')!).fontSize,
          headingLine: getComputedStyle(node.querySelector('h2')!).lineHeight,
        }));
        expect(paint.background).not.toBe('rgba(0, 0, 0, 0)');
        expect(paint.background).not.toBe('rgb(255, 255, 255)');
        expect(paint.color).not.toBe(paint.background);
        expect(paint.width).toBeLessThanOrEqual(paint.viewport);
        expect(paint.headingFont).toBe('20px');
        expect(paint.headingLine).toBe('28px');
        if (width === 390) await expectMobileRoot(dialog);
        await dialog.screenshot({
          path: resolve(evidence, `archive-employees-dark-${width}.png`),
        });
      } finally {
        await f.close();
      }
    },
  );
});
