/** Real tenant/sidebar/detail/form, synthetic shared HTTP contracts, no Run. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AutomationCatalogQuerySchema,
  AutomationCatalogSchema,
  BridgeDeviceSchema,
  EmployeeDetailsSchema,
  EmployeeInstanceProfileSchema,
  EmployeeInstanceSchema,
  EmployeeMemoryPageSchema,
  UpdateEmployeeInstanceInputSchema,
  UserMonthlyQuotaSchema,
  WorkspaceReadinessSchema,
  defaultUserPreferences,
  defaultWorkAutomation,
  employeeColorPalette,
  workspaceCapabilityIds,
  type EmployeeInstance,
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
const json = (value: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(value),
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}

suite('U1 Rice full persona from the real employee entry', () => {
  let browser: Browser, server: Server, origin: string;
  const evidence = resolve('.local/met249-u1-rice-persona');
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/employee-rice-persona-page.tsx'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/rice-persona-fixture',
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
      const asset = assets.get(new URL(req.url!, 'http://localhost').pathname);
      res.setHeader(
        'Content-Type',
        asset
          ? req.url!.endsWith('.css')
            ? 'text/css'
            : 'text/javascript'
          : 'text/html',
      );
      res.end(
        asset ??
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-rice-persona-page.css"><div id="root"></div><script type="module" src="/employee-rice-persona-page.js"></script>',
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
    console.info(`Rice persona evidence: ${evidence}`);
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
      entry?: 'default' | 'assignment';
      fields?: 'full' | 'missing' | 'style' | 'visible-only';
      maintain?: boolean;
    } = {},
  ) {
    const width = options.width ?? 1440;
    const preferences = {
      ...defaultUserPreferences,
      appearance: options.dark ? ('dark' as const) : ('light' as const),
    };
    const bases = [7, 17].map((n) => {
      const detail = employeeDetailsFixture();
      detail.profile.instanceId = id(n);
      detail.profile.kind = n === 7 ? 'general' : 'custom';
      detail.profile.name = n === 7 ? 'Rice' : '流程哥';
      detail.profile.source =
        n === 7
          ? detail.profile.source
          : {
              kind: 'tenant_version',
              employeeVersionId: id(n + 1),
            };
      detail.profile.isDefaultRice = n === 7;
      detail.profile.canMaintainPersonal = options.maintain !== false;
      detail.profile.editableFields =
        options.fields === 'missing'
          ? undefined
          : options.fields === 'style'
            ? ['expressionStyle']
            : options.fields === 'visible-only'
              ? [
                  'name',
                  'appearance',
                  'mission',
                  'workStyle',
                  'expressionStyle',
                ]
              : EmployeeInstanceProfileSchema.keyof().options;
      // Synthetic inherited image: the UI still uses its approved initials
      // preview, but a color edit must not rewrite the persisted avatar kind.
      detail.profile.appearance = {
        avatarType: 'image',
        avatarValue: '/synthetic-avatar.png',
        accentColor: 'violet',
      };
      detail.content.instanceId = id(n);
      detail.content.employeeId = id(n + 2);
      return detail;
    });
    const instances = bases.map((detail, i) =>
      EmployeeInstanceSchema.parse({
        id: detail.profile.instanceId,
        assignmentId: id((i === 0 ? 7 : 17) + 100),
        organizationId: id(3),
        workspaceId: id(4),
        ownerId: id(5),
        kind: detail.profile.kind,
        revision: detail.profile.revision,
        profile: {
          description: '保留未由表单修改的个人简介',
          role: '保留未由表单修改的个人角色',
          expressionStyle: 'concise',
        },
        source: detail.profile.source,
        creationSource: detail.profile.source,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      }),
    );
    const rawGate = gate(),
      rawSent = gate(),
      writeGate = gate();
    const state = {
      instances,
      rawGate: null as Promise<void> | null,
      writeGate: null as Promise<void> | null,
      saveStatus: 200,
      rawStatus: 200,
      rawOverride: null as Partial<EmployeeInstance> | null,
      receiptOverride: null as Partial<EmployeeInstance> | null,
      writes: [] as Array<{
        instanceId: string;
        body: ReturnType<typeof UpdateEmployeeInstanceInputSchema.parse>;
      }>,
      rawReads: [] as string[],
      errors: [] as string[],
      unexpected: [] as string[],
    };
    const resolved = (target: string) => {
      const index = instances.findIndex((item) => item.id === target);
      if (index < 0) throw Error('Unknown synthetic employee target');
      const detail = structuredClone(bases[index]!);
      const instance = instances[index]!;
      detail.profile = {
        ...detail.profile,
        revision: instance.revision,
        name: instance.profile.name ?? detail.profile.name,
        description: instance.profile.description ?? detail.profile.description,
        appearance: instance.profile.appearance ?? detail.profile.appearance,
        expressionStyle: instance.profile.expressionStyle,
        personalFields: EmployeeInstanceProfileSchema.keyof().options.filter(
          (field) => field in instance.profile,
        ),
        identity: {
          ...detail.profile.identity,
          role: instance.profile.role ?? detail.profile.identity.role,
          mission: instance.profile.mission ?? detail.profile.identity.mission,
          workStyle:
            instance.profile.workStyle ?? detail.profile.identity.workStyle,
        },
      };
      return EmployeeDetailsSchema.parse(detail);
    };
    const page = await browser.newPage({
      viewport: { width, height: width < 600 ? 844 : 1000 },
      isMobile: width < 600,
      hasTouch: width < 600,
      colorScheme: options.dark ? 'dark' : 'light',
      reducedMotion: 'reduce',
    });
    page.setDefaultTimeout(8000);
    page.on('pageerror', (error) => state.errors.push(error.message));
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname;
      const target = path.split('/')[4];
      if (request.method() === 'GET' && path.endsWith('/content'))
        return route.fulfill(json(resolved(target!)));
      if (
        path.startsWith('/api/v1/employee-instances/') &&
        instances.some(
          (item) => path === `/api/v1/employee-instances/${item.id}`,
        )
      ) {
        const index = instances.findIndex((item) => item.id === target);
        if (request.method() === 'GET') {
          state.rawReads.push(target!);
          const heldRaw = target === id(7) && state.rawGate;
          if (heldRaw) await heldRaw;
          if (state.rawStatus !== 200)
            return route.fulfill(
              json({ error: { message: 'No access' } }, state.rawStatus),
            );
          await route.fulfill(
            json({ instance: { ...instances[index]!, ...state.rawOverride } }),
          );
          if (heldRaw) rawSent.release();
          return;
        }
        if (request.method() === 'PATCH') {
          const body = UpdateEmployeeInstanceInputSchema.parse(
            request.postDataJSON(),
          );
          state.writes.push({ instanceId: target!, body });
          if (!('profile' in body))
            return route.fulfill(json({ error: 'reset_not_allowed' }, 400));
          if (state.writeGate) await state.writeGate;
          if (state.saveStatus !== 200)
            return route.fulfill(
              json({ error: { message: '保存暂时失败。' } }, state.saveStatus),
            );
          const before = instances[index]!;
          instances[index] = EmployeeInstanceSchema.parse({
            ...before,
            revision: before.revision + 1,
            profile:
              before.kind === 'general'
                ? { ...before.profile, ...body.profile }
                : body.profile,
          });
          return route.fulfill(
            json({
              instance: { ...instances[index]!, ...state.receiptOverride },
            }),
          );
        }
      }
      if (request.method() === 'GET' && path.endsWith('/scene-skills'))
        return route.fulfill(
          json({ instanceId: target, revision: 0, skills: [] }),
        );
      if (request.method() === 'GET' && path === '/api/v1/memories/manage')
        return route.fulfill(
          json(
            EmployeeMemoryPageSchema.parse({
              organizationId: id(3),
              workspaceId: id(4),
              ownerId: id(5),
              instanceId: url.searchParams.get('instanceId'),
              state: url.searchParams.get('state'),
              total: 0,
              memories: [],
              nextCursor: null,
              budget: null,
            }),
          ),
        );
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
              employeeProfiles: bases.map((detail, index) => ({
                assignmentId: instances[index]!.assignmentId,
                employeeId: detail.content.employeeId,
                name: detail.profile.name,
                description: detail.profile.description,
                appearance: detail.profile.appearance,
                identity: detail.profile.identity,
                skills: [],
                model: {
                  harness: 'dsh',
                  provider: 'codex',
                  model: 'gpt-6.1-sol',
                  reasoningEffort: 'max',
                },
              })),
              employees: bases.map((detail, index) => ({
                id: instances[index]!.assignmentId,
                instanceId: instances[index]!.id,
                employeeId: detail.content.employeeId,
                employeeKey:
                  index === 0 ? 'default-assistant' : 'synthetic-personal',
                isDefault: index === 0,
                versions: [],
                instances: [instances[index]!],
                currentVersion: {
                  id: detail.profile.source.employeeVersionId,
                  manifest: {
                    schemaVersion: 2,
                    key:
                      index === 0 ? 'default-assistant' : 'synthetic-personal',
                    isDefaultRice: index === 0,
                    name: detail.profile.name,
                    description: detail.profile.description,
                    appearance: detail.profile.appearance,
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
      // The real workbench reads these projections even when no session exists.
      // Keep their member/workspace scope and shared response contracts; other
      // methods, targets and unknown APIs still reach the unexpected gate.
      if (
        request.method() === 'GET' &&
        url.searchParams.get('workspaceId') === id(4)
      ) {
        if (path === '/api/v1/workspace/monthly-quota')
          return route.fulfill(
            json(
              UserMonthlyQuotaSchema.parse({
                organizationId: id(3),
                workspaceId: id(4),
                userId: id(5),
                displayName: 'Synthetic member',
                monthlyTokenLimit: 5000000,
                usedTokens: 2824029,
                remainingTokens: 2175971,
                remainingPercent: 43.51942,
                unknownUsageRuns: 0,
                periodStart: now,
                resetsAt: now,
                observedAt: now,
              }),
            ),
          );
        if (path === '/api/v1/workspace/readiness')
          return route.fulfill(
            json(
              WorkspaceReadinessSchema.parse({
                schemaVersion: 1,
                organizationId: id(3),
                workspaceId: id(4),
                viewerId: id(5),
                sessionId: url.searchParams.get('sessionId'),
                employeeVersionId: bases[0]!.profile.source.employeeVersionId,
                observedAt: now,
                basis: 'next_task',
                canAdminister: false,
                capabilities: workspaceCapabilityIds.map((capability) => ({
                  id: capability,
                  state:
                    capability === 'report'
                      ? 'ready'
                      : capability === 'local_files'
                        ? 'needs_configuration'
                        : 'not_released',
                  reason:
                    capability === 'report'
                      ? 'ready'
                      : capability === 'local_files'
                        ? 'bridge_missing'
                        : 'release_disabled',
                  action:
                    capability === 'report'
                      ? 'compose'
                      : capability === 'local_files'
                        ? 'bridge'
                        : 'guide',
                  target: capability === 'local_files' ? 'local' : 'cloud',
                  responsibleRole: 'user',
                  releaseEnabled: ['report', 'local_files'].includes(
                    capability,
                  ),
                  authorization: 'normal_policy',
                })),
              }),
            ),
          );
        if (path === '/api/v1/bridge/devices')
          return route.fulfill(
            json({ devices: BridgeDeviceSchema.array().parse([]) }),
          );
        if (path === '/api/v1/scheduled-tasks') {
          AutomationCatalogQuerySchema.parse(
            Object.fromEntries(url.searchParams),
          );
          return route.fulfill(
            json(
              AutomationCatalogSchema.parse({ tasks: [], nextCursor: null }),
            ),
          );
        }
      }
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
      state.unexpected.push(`${request.method()} ${path}`);
      return route.fulfill(json({ error: 'fixture_unhandled' }, 404));
    });
    const query = new URLSearchParams();
    if (options.dark) query.set('theme', 'dark');
    // The existing URL selects employeeId; assignmentId and instanceId remain
    // distinct so a display projection cannot accidentally change authority.
    if (options.entry === 'assignment') query.set('employee', id(9));
    await page.goto(`${origin}/?${query}`);
    await page
      .getByRole('textbox', { name: '给 Rice 的消息', exact: true })
      .waitFor();
    const sidebar = async () => {
      const toggle = page.getByRole('button', {
        name: '展开侧边栏',
        exact: true,
      });
      if (await toggle.isVisible()) await toggle.click();
    };
    const openDetails = async (name = 'Rice') => {
      await sidebar();
      await page
        .getByRole('button', { name: `查看${name}详情`, exact: true })
        .click();
      const dialog = page.getByRole('dialog', {
        name: `${name}员工详情`,
        exact: true,
      });
      await dialog
        .getByRole('region', { name: '基础与人设', exact: true })
        .waitFor();
      return dialog;
    };
    const openEditor = async () => {
      await page.getByRole('button', { name: '编辑员工', exact: true }).click();
      const editor = page.getByRole('dialog', {
        name: '编辑人设',
        exact: true,
      });
      return editor;
    };
    const close = async () => {
      rawGate.release();
      writeGate.release();
      await page.close();
      expect(state.unexpected).toEqual([]);
      expect(state.errors).toEqual([]);
    };
    const run = async (body: () => Promise<void>) => {
      try {
        await body();
      } catch (primaryError) {
        try {
          await close();
        } catch (cleanupError) {
          throw new AggregateError(
            [primaryError, cleanupError],
            'Rice persona test body failed; fixture cleanup also failed.',
            { cause: primaryError },
          );
        }
        throw primaryError;
      }
      await close();
    };
    return {
      page,
      state,
      openDetails,
      openEditor,
      sidebar,
      run,
      holdRaw: () => {
        state.rawGate = rawGate.promise;
      },
      releaseRaw: rawGate.release,
      rawSent: rawSent.promise,
      holdWrite: () => {
        state.writeGate = writeGate.promise;
      },
      releaseWrite: writeGate.release,
    };
  }

  async function paint(locator: Locator) {
    await expect
      .poll(
        () =>
          locator.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            let ancestor: Element | null = node;
            while (ancestor) {
              const css = getComputedStyle(ancestor);
              if (
                Number(css.opacity) !== 1 ||
                css.visibility !== 'visible' ||
                css.display === 'none'
              )
                return false;
              ancestor = ancestor.parentElement;
            }
            const hit = document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            );
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              hit !== null &&
              node.contains(hit) &&
              !node
                .getAnimations({ subtree: true })
                .some(
                  (animation) =>
                    animation.playState === 'running' || animation.pending,
                )
            );
          }),
        { timeout: 5000 },
      )
      .toBe(true);
  }

  it.each([
    { width: 1440, dark: false, entry: 'default' as const },
    { width: 390, dark: false, entry: 'default' as const },
    { width: 1440, dark: true, entry: 'assignment' as const },
    { width: 390, dark: true, entry: 'assignment' as const },
  ])(
    'saves the Rice persona through the real entry at $width px dark=$dark entry=$entry',
    async ({ width, dark, entry }) => {
      const f = await fixture({ width, dark, entry });
      await f.run(async () => {
        const composer = f.page.getByRole('textbox', {
          name: '给 Rice 的消息',
          exact: true,
        });
        await composer.fill('不发送的原工作草稿。');
        await f.openDetails();
        const editor = await f.openEditor();
        await editor
          .getByRole('textbox', { name: '员工名字', exact: true })
          .fill('青禾');
        await editor
          .getByRole('radio', {
            name: employeeColorPalette.teal.label,
            exact: true,
          })
          .check();
        const mission = editor.getByRole('textbox', {
          name: '使命',
          exact: true,
        });
        expect(await mission.inputValue()).toBe('帮助完成研究');
        await mission.fill('完成研究并核对结论');
        const workStyle = editor.getByRole('textbox', {
          name: '工作方式',
          exact: true,
        });
        expect(await workStyle.inputValue()).toBe('按步骤交付');
        await workStyle.fill('先核对资料，再按步骤交付');
        await editor
          .getByRole('combobox', { name: '表达偏好', exact: true })
          .selectOption('exploratory');
        expect(await editor.getByRole('radio').count()).toBe(10);
        expect(
          await editor
            .getByRole('button', { name: '关闭', exact: true })
            .count(),
        ).toBe(0);
        await paint(editor);
        const editorPaint = await editor.evaluate((node, darkMode) => {
          const css = getComputedStyle(node),
            input = node.querySelector('input')!;
          const rect = node.getBoundingClientRect();
          return {
            surface: css.backgroundColor,
            expectedSurface: css
              .getPropertyValue(
                darkMode
                  ? '--dsw-static-neutral-bluish-850'
                  : '--dsw-static-neutral-bluish-00',
              )
              .trim(),
            font: getComputedStyle(input).fontFamily,
            bounds: { x: rect.x, right: rect.right },
            overflow: node.scrollWidth > node.clientWidth,
            theme: document.documentElement.dataset.theme,
          };
        }, dark);
        expect(editorPaint.surface).toBe(editorPaint.expectedSurface);
        expect(editorPaint.font).toMatch(/sans-serif/);
        expect(editorPaint.theme).toBe(dark ? 'dark' : 'light');
        expect(editorPaint.bounds.x).toBeGreaterThanOrEqual(0);
        expect(editorPaint.bounds.right).toBeLessThanOrEqual(width);
        expect(editorPaint.overflow).toBe(false);
        await editor.screenshot({
          path: resolve(
            evidence,
            `rice-editor-${width}-${dark ? 'dark' : 'light'}.png`,
          ),
        });
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        const saved = f.page.getByRole('dialog', {
          name: '青禾员工详情',
          exact: true,
        });
        const card = saved.getByRole('region', {
          name: '基础与人设',
          exact: true,
        });
        await card
          .getByRole('heading', { name: '青禾', exact: true })
          .waitFor();
        expect(f.state.writes).toHaveLength(1);
        const write = f.state.writes[0]!;
        expect(write.instanceId).toBe(id(7));
        expect(write.body).toMatchObject({
          workspaceId: id(4),
          expectedRevision: 2,
          profile: {
            name: '青禾',
            mission: '完成研究并核对结论',
            workStyle: '先核对资料，再按步骤交付',
            expressionStyle: 'exploratory',
            appearance: {
              avatarType: 'image',
              avatarValue: '/synthetic-avatar.png',
              accentColor: 'teal',
            },
          },
        });
        if (!('profile' in write.body)) throw Error('Expected profile patch');
        expect(write.body.profile).not.toHaveProperty('description');
        expect(write.body.profile).not.toHaveProperty('role');
        expect(f.state.instances[0]!.profile).toMatchObject({
          description: '保留未由表单修改的个人简介',
          role: '保留未由表单修改的个人角色',
        });
        expect(write.body).not.toHaveProperty('operation');
        expect(write.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
        await paint(saved);
        const cardPaint = await card.evaluate((node, darkMode) => {
          const css = getComputedStyle(node);
          return {
            surface: css.backgroundColor,
            text: css.color,
            expectedSurface: css
              .getPropertyValue(
                darkMode
                  ? '--dsw-static-neutral-bluish-875'
                  : '--dsw-static-neutral-bluish-00',
              )
              .trim(),
            expectedText: css
              .getPropertyValue(
                darkMode
                  ? '--dsw-static-neutral-bluish-50'
                  : '--dsw-static-neutral-bluish-1000',
              )
              .trim(),
            accent: css.getPropertyValue('--employee-start').trim(),
          };
        }, dark);
        expect(cardPaint.surface).toBe(cardPaint.expectedSurface);
        expect(cardPaint.text).toBe(cardPaint.expectedText);
        expect(cardPaint.accent).toBe(employeeColorPalette.teal.value);
        await saved.screenshot({
          path: resolve(
            evidence,
            `rice-saved-${width}-${dark ? 'dark' : 'light'}.png`,
          ),
        });
        await saved.getByRole('button', { name: '关闭', exact: true }).click();
        const renamedComposer = f.page.getByRole('textbox', {
          name: '给 青禾 的消息',
          exact: true,
        });
        await renamedComposer.waitFor();
        expect(await renamedComposer.inputValue()).toBe('不发送的原工作草稿。');
        await f.page
          .getByRole('heading', { name: '与 青禾 工作', exact: true })
          .waitFor();
        await f.sidebar();
        const entryButton = f.page.getByRole('button', {
          name: '查看青禾详情',
          exact: true,
        });
        await entryButton.waitFor();
        expect(
          await entryButton.evaluate((node) =>
            getComputedStyle(node).getPropertyValue('--employee-start').trim(),
          ),
        ).toBe(employeeColorPalette.teal.value);
        await writeFile(
          resolve(
            evidence,
            `rice-paint-${width}-${dark ? 'dark' : 'light'}.json`,
          ),
          JSON.stringify({ editorPaint, cardPaint, entry, write }, null, 2),
        );
      });
    },
    40_000,
  );

  it.each([
    { kind: 'general' as const, name: 'Rice', index: 0 },
    { kind: 'custom' as const, name: '流程哥', index: 1 },
  ])(
    'keeps untouched defaults inherited in a $kind name-only save through the real entry',
    async ({ kind, name, index }) => {
      const f = await fixture();
      await f.run(async () => {
        const before = structuredClone(f.state.instances[index]!);
        await f.openDetails(name);
        const editor = await f.openEditor();
        const renamed = kind === 'general' ? '青禾' : '青禾自定义';
        await editor
          .getByRole('textbox', { name: '员工名字', exact: true })
          .fill(renamed);
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await f.page
          .getByRole('dialog', { name: `${renamed}员工详情`, exact: true })
          .waitFor();
        expect(f.state.writes).toHaveLength(1);
        const write = f.state.writes[0]!;
        if (!('profile' in write.body)) throw Error('Expected profile write');
        expect(write.instanceId).toBe(before.id);
        expect(write.body.profile).not.toHaveProperty('mission');
        expect(write.body.profile).not.toHaveProperty('workStyle');
        expect(write.body.profile).not.toHaveProperty('appearance');
        expect(write.body.profile).toEqual(
          kind === 'general'
            ? { name: renamed }
            : { ...before.profile, name: renamed },
        );
        expect(f.state.instances[index]!.profile).toEqual({
          ...before.profile,
          name: renamed,
        });
        expect(f.state.instances[index]!.revision).toBe(before.revision + 1);
      });
    },
  );

  it('returns without a write when the empty Rice or saved custom persona was not edited', async () => {
    for (const [name, index] of [
      ['Rice', 0],
      ['流程哥', 1],
    ] as const) {
      const f = await fixture();
      await f.run(async () => {
        if (index === 0) f.state.instances[index]!.profile = {};
        const before = structuredClone(f.state.instances[index]!);
        await f.openDetails(name);
        const editor = await f.openEditor();
        await editor.getByRole('button', { name: '保存', exact: true }).click();
        await f.page
          .getByRole('dialog', { name: `${name}员工详情`, exact: true })
          .waitFor();
        expect(f.state.writes).toEqual([]);
        expect(f.state.instances[index]).toEqual(before);
      });
    }
  });

  it('persists explicitly edited default-valued text and expression without copying the other displayed defaults', async () => {
    const f = await fixture();
    await f.run(async () => {
      f.state.instances[0]!.profile = {};
      await f.openDetails();
      const editor = await f.openEditor();
      const mission = editor.getByRole('textbox', {
        name: '使命',
        exact: true,
      });
      const originalMission = await mission.inputValue();
      const expression = editor.getByRole('combobox', {
        name: '表达偏好',
        exact: true,
      });
      expect(await expression.inputValue()).toBe('structured');
      await mission.fill('临时编辑的使命');
      await mission.fill(originalMission);
      await expression.selectOption('concise');
      await expression.selectOption('structured');
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await f.page
        .getByRole('dialog', { name: 'Rice员工详情', exact: true })
        .waitFor();
      expect(f.state.writes).toHaveLength(1);
      const write = f.state.writes[0]!;
      if (!('profile' in write.body)) throw Error('Expected profile patch');
      expect(write.body.profile).toEqual({
        mission: originalMission,
        expressionStyle: 'structured',
      });
      expect(f.state.instances[0]!.profile).toEqual(write.body.profile);
    });
  });

  it('keeps missing and partial persona capability closed at the real detail entry', async () => {
    for (const fields of ['missing', 'style'] as const) {
      const f = await fixture({ fields });
      await f.run(async () => {
        const detail = await f.openDetails();
        expect(
          await detail
            .getByRole('button', { name: '编辑员工', exact: true })
            .count(),
        ).toBe(0);
        expect(f.state.rawReads).toEqual([]);
        expect(f.state.writes).toEqual([]);
      });
    }
  }, 30_000);

  it('keeps the failed Rice draft and request identity while the existing save lock protects every exit', async () => {
    const f = await fixture({ width: 390 });
    await f.run(async () => {
      f.state.saveStatus = 503;
      await f.openDetails();
      const editor = await f.openEditor();
      await editor
        .getByRole('textbox', { name: '员工名字', exact: true })
        .fill('青禾');
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await editor.getByRole('alert').waitFor();
      expect(
        await editor
          .getByRole('textbox', { name: '员工名字', exact: true })
          .inputValue(),
      ).toBe('青禾');
      expect(f.state.instances[0]!.revision).toBe(2);
      f.holdWrite();
      f.state.saveStatus = 200;
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await expect.poll(() => f.state.writes.length).toBe(2);
      expect(
        await editor
          .getByRole('button', { name: '返回员工详情', exact: true })
          .isDisabled(),
      ).toBe(true);
      expect(
        await editor
          .getByRole('button', { name: '取消', exact: true })
          .isDisabled(),
      ).toBe(true);
      await f.page.keyboard.press('Escape');
      expect(await editor.isVisible()).toBe(true);
      expect(f.state.writes[0]!.body).toEqual(f.state.writes[1]!.body);
      f.releaseWrite();
      await f.page
        .getByRole('dialog', { name: '青禾员工详情', exact: true })
        .waitFor();
    });
  }, 30_000);

  it('rejects changed raw identity or a forbidden outgoing raw field without a persona write', async () => {
    const cases: Array<Partial<EmployeeInstance>> = [
      { revision: 99 },
      { workspaceId: id(44) },
      { archivedAt: now },
      { source: { kind: 'tenant_version', employeeVersionId: id(888) } },
    ];
    for (const rawOverride of cases) {
      const f = await fixture();
      await f.run(async () => {
        f.state.rawOverride = rawOverride;
        await f.openDetails();
        const editor = await f.openEditor();
        await editor.getByRole('alert').waitFor();
        expect(await editor.getByRole('textbox').count()).toBe(0);
        expect(f.state.writes).toEqual([]);
      });
    }
    const f = await fixture({ fields: 'visible-only' });
    await f.run(async () => {
      await f.openDetails('流程哥');
      const editor = await f.openEditor();
      await editor
        .getByRole('textbox', { name: '员工名字', exact: true })
        .fill('改名流程哥');
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await editor.getByRole('alert').waitFor();
      expect(f.state.writes).toEqual([]);
    });
  }, 50_000);

  it('cancels a pending Rice read and opens the other real employee without reusing the late raw profile', async () => {
    const f = await fixture({ width: 390 });
    await f.run(async () => {
      f.holdRaw();
      await f.openDetails();
      const editor = await f.openEditor();
      await expect.poll(() => f.state.rawReads.length).toBe(1);
      await editor
        .getByRole('button', { name: '返回员工详情', exact: true })
        .click();
      await f.page
        .getByRole('dialog', { name: 'Rice员工详情', exact: true })
        .getByRole('button', { name: '关闭', exact: true })
        .click();
      await f.openDetails('流程哥');
      const other = await f.openEditor();
      await other
        .getByRole('textbox', { name: '员工名字', exact: true })
        .waitFor();
      f.releaseRaw();
      await f.rawSent;
      expect(
        await other
          .getByRole('textbox', { name: '员工名字', exact: true })
          .inputValue(),
      ).toBe('流程哥');
      await other.getByRole('button', { name: '取消', exact: true }).click();
      await f.page
        .getByRole('dialog', { name: '流程哥员工详情', exact: true })
        .waitFor();
      expect(f.state.writes).toEqual([]);
      expect(f.state.rawReads).toEqual([id(7), id(17)]);
    });
  }, 30_000);

  it('keeps a mismatched Rice source receipt out of the local saved identity', async () => {
    const f = await fixture();
    await f.run(async () => {
      await f.openDetails();
      const editor = await f.openEditor();
      await editor
        .getByRole('textbox', { name: '员工名字', exact: true })
        .fill('青禾');
      f.state.receiptOverride = {
        source: {
          kind: 'tenant_version',
          employeeVersionId: id(888),
        },
      };
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await editor.getByRole('alert').waitFor();
      expect(f.state.writes).toHaveLength(1);
      expect(await editor.isVisible()).toBe(true);
      expect(
        await editor
          .getByRole('textbox', { name: '员工名字', exact: true })
          .inputValue(),
      ).toBe('青禾');
      await editor.getByRole('button', { name: '取消', exact: true }).click();
      const unchanged = f.page.getByRole('dialog', {
        name: 'Rice员工详情',
        exact: true,
      });
      await unchanged
        .getByRole('heading', { name: 'Rice', exact: true })
        .waitFor();
      expect(
        await unchanged
          .getByRole('heading', { name: '青禾', exact: true })
          .count(),
      ).toBe(0);
    });
  }, 30_000);
});
