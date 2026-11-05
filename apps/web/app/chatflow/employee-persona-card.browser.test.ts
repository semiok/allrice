/** Real detail/read/edit UI in Chrome with synthetic HTTP; no DB or model. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EmployeeInstanceSchema,
  type EmployeeInstance,
} from '@allrice/contracts';
import type {
  Browser,
  Page,
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

suite('U1 employee persona card', () => {
  let browser: Browser, server: Server, origin: string;
  const screenshotDir = resolve('.local/met249-u1-persona');
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const result = await build({
      entryPoints: ['apps/web/test/employee-persona-card-page.tsx'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      outdir: '/fixture',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      define: {
        'process.env.NODE_ENV': '"development"',
        'process.env': '{}',
      },
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
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/employee-persona-card-page.css"><div id="root"></div><script type="module" src="/employee-persona-card-page.js"></script>',
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
    await mkdir(screenshotDir, { recursive: true });
    console.info(`U1 persona evidence: ${screenshotDir}`);
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30_000);

  async function open(options: {
    width: number;
    shared?: boolean;
    general?: boolean;
    dark?: boolean;
  }) {
    const details = employeeDetailsFixture();
    details.profile.kind = options.general ? 'general' : 'custom';
    details.profile.name = '流程哥';
    details.profile.identity.mission =
      '理解目标，推进工作，交付清晰、可用的结果。\n' +
      '每一项结论都保留事实依据，未确认的事项明确列出。'.repeat(6);
    details.profile.identity.workStyle =
      '先确认目标和资料，再分步执行；信息不足时及时说明，交付时列出待确认事项。\n' +
      '交付时说明已完成内容、需要补充的资料和下一步。'.repeat(8);
    details.profile.personalFields = ['expressionStyle'];
    if (options.shared) {
      details.profile.canMaintainPersonal = false;
      details.profile.personalFields = [];
    }
    const instance = EmployeeInstanceSchema.parse({
      id: id(7),
      assignmentId: id(7),
      organizationId: id(3),
      workspaceId: id(4),
      ownerId: id(5),
      kind: details.profile.kind,
      revision: details.profile.revision,
      profile: {
        name: details.profile.name,
        description: '未由人设表单修改的个人简介',
        mission: details.profile.identity.mission,
        workStyle: details.profile.identity.workStyle,
        expressionStyle: details.profile.expressionStyle,
        appearance: details.profile.appearance,
      },
      creationSource: details.profile.source,
      source: details.profile.source,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    const state = {
      details,
      instance,
      failSave: true,
      saveGate: null as Promise<void> | null,
      writes: [] as Array<{
        expectedRevision: number;
        requestId: string;
        profile: EmployeeInstance['profile'];
      }>,
      reads: [] as string[],
      errors: [] as string[],
    };
    const page = await browser.newPage({
      viewport: { width: options.width, height: 1000 },
      isMobile: options.width < 600,
      hasTouch: options.width < 600,
      reducedMotion: 'reduce',
    });
    page.setDefaultTimeout(8000);
    page.on('pageerror', (cause) => state.errors.push(cause.message));
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === 'GET') state.reads.push(path);
      if (path.endsWith('/content')) {
        const instanceId = path.split('/').at(-2);
        const current = structuredClone(state.details);
        if (instanceId === id(17)) {
          current.profile.instanceId = id(17);
          current.content.instanceId = id(17);
          current.profile.name = '另一位员工';
          current.profile.identity.mission = '另一位员工的使命';
        }
        return route.fulfill(
          json(
            options.shared
              ? {
                  organizationId: id(3),
                  userId: id(5),
                  visibility: 'shared_only',
                  details: current,
                }
              : current,
          ),
        );
      }
      if (path === `/api/v1/employee-instances/${id(7)}`) {
        if (request.method() === 'GET')
          return route.fulfill(json({ instance: state.instance }));
        const body = request.postDataJSON();
        state.writes.push(body);
        if (state.saveGate) await state.saveGate;
        if (state.failSave)
          return route.fulfill(
            json({ error: { message: '保存暂时失败。' } }, 503),
          );
        state.instance = EmployeeInstanceSchema.parse({
          ...state.instance,
          revision: state.instance.revision + 1,
          profile: body.profile,
        });
        state.details.profile = {
          ...state.details.profile,
          revision: state.instance.revision,
          name: state.instance.profile.name!,
          appearance: state.instance.profile.appearance,
          expressionStyle: state.instance.profile.expressionStyle,
          identity: {
            ...state.details.profile.identity,
            mission: state.instance.profile.mission!,
            workStyle: state.instance.profile.workStyle!,
          },
        };
        return route.fulfill(json({ instance: state.instance }));
      }
      return route.fulfill(
        json({ error: { message: '未提供合成请求。' } }, 404),
      );
    });
    const query = new URLSearchParams();
    if (options.shared) query.set('shared', '1');
    if (options.dark) query.set('theme', 'dark');
    await page.goto(`${origin}/?${query}`);
    return { page, state };
  }

  const showDetails = async (page: Page) => {
    await page
      .getByRole('button', { name: '打开员工详情', exact: true })
      .click();
    const card = page.getByRole('region', { name: '基础与人设', exact: true });
    await card.waitFor();
    return card;
  };

  const showEditor = async (page: Page) => {
    await page.getByRole('button', { name: '编辑员工', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '编辑人设', exact: true });
    await editor
      .getByRole('textbox', { name: '员工名字', exact: true })
      .waitFor();
    return editor;
  };

  it.each([1440, 390])(
    'shows the whole persona and retains avatar color through a failed save at %ipx',
    async (width) => {
      const { page, state } = await open({ width });
      try {
        const card = await showDetails(page);
        expect(await card.locator('dt').allTextContents()).toEqual([
          '使命',
          '工作方式',
          '表达偏好',
        ]);
        expect(await card.locator('dd').allTextContents()).toEqual([
          state.details.profile.identity.mission,
          state.details.profile.identity.workStyle,
          '简洁，结论优先',
        ]);
        const measured = await card.evaluate((node) => {
          const styleOf = (element: Element) => {
            const style = getComputedStyle(element);
            return {
              family: style.fontFamily,
              size: style.fontSize,
              line: style.lineHeight,
              weight: style.fontWeight,
              color: style.color,
            };
          };
          const firstLineTop = (element: Element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return range.getClientRects()[0]!.top;
          };
          const avatarStyle = getComputedStyle(
            node.querySelector('span[aria-hidden="true"]')!,
          );
          const personaStyle = getComputedStyle(node.querySelector('dl')!);
          return {
            name: styleOf(node.querySelector('h3')!),
            label: styleOf(node.querySelector('dt')!),
            body: styleOf(node.querySelector('dd')!),
            cardColor: getComputedStyle(node).color,
            firstLineOffsets: Array.from(
              node.querySelectorAll('dl > div'),
              (row) =>
                firstLineTop(row.querySelector('dd')!) -
                firstLineTop(row.querySelector('dt')!),
            ),
            avatar: {
              width: avatarStyle.width,
              height: avatarStyle.height,
              size: avatarStyle.fontSize,
            },
            cardRadius: getComputedStyle(node).borderRadius,
            personaSpacing: {
              marginTop: personaStyle.marginTop,
              paddingTop: personaStyle.paddingTop,
            },
            allTextFits: Array.from(node.querySelectorAll('h3, dd')).every(
              (element) =>
                element.scrollHeight <= element.clientHeight + 1 &&
                element.scrollWidth <= element.clientWidth + 1 &&
                getComputedStyle(element).webkitLineClamp === 'none',
            ),
            rowColumns: getComputedStyle(node.querySelector('dl > div')!)
              .gridTemplateColumns,
            cardFits: node.scrollWidth <= node.clientWidth,
          };
        });
        expect(measured.name).toMatchObject({
          size: '16px',
          line: '24px',
          weight: '600',
        });
        expect(measured.label).toMatchObject({
          size: '12px',
          line: width < 700 ? '18px' : '22px',
        });
        expect(measured.body).toMatchObject({
          size: '12px',
          line: width < 700 ? '18px' : '22px',
        });
        expect(measured.body.color).toBe(measured.cardColor);
        if (width >= 700) {
          for (const offset of measured.firstLineOffsets)
            expect(Math.abs(offset)).toBeLessThan(1);
        }
        expect(measured.avatar).toEqual(
          width < 700
            ? { width: '40px', height: '40px', size: '18px' }
            : { width: '44px', height: '44px', size: '20px' },
        );
        expect(measured.cardRadius).toBe(width < 700 ? '12px' : '16px');
        expect(measured.personaSpacing).toEqual(
          width < 700
            ? { marginTop: '16px', paddingTop: '16px' }
            : { marginTop: '12px', paddingTop: '12px' },
        );
        expect(measured.name.family).toBe(measured.body.family);
        expect(measured.allTextFits).toBe(true);
        expect(measured.cardFits).toBe(true);
        expect(measured.rowColumns.split(' ')).toHaveLength(
          width < 700 ? 1 : 2,
        );
        await card.screenshot({
          path: `${screenshotDir}/persona-card-${width}.png`,
        });
        await card
          .getByRole('button', { name: '编辑员工', exact: true })
          .click();
        const form = page.getByRole('form', {
          name: '编辑员工信息',
          exact: true,
        });
        await form.waitFor();
        expect(
          await form
            .getByRole('radio', { name: '鸢尾紫', exact: true })
            .isChecked(),
        ).toBe(true);
        await form.getByRole('radio', { name: '薄荷绿', exact: true }).check();
        await form
          .getByRole('textbox', { name: '员工名字', exact: true })
          .fill('周报伙伴');
        await form.screenshot({
          path: `${screenshotDir}/persona-editor-color-${width}.png`,
        });
        await form.getByRole('button', { name: '保存', exact: true }).click();
        await form.getByRole('alert').waitFor();
        expect(
          await form
            .getByRole('textbox', { name: '员工名字', exact: true })
            .inputValue(),
        ).toBe('周报伙伴');
        expect(
          await form
            .getByRole('radio', { name: '薄荷绿', exact: true })
            .isChecked(),
        ).toBe(true);
        state.failSave = false;
        await form.getByRole('button', { name: '保存', exact: true }).click();
        await page
          .getByRole('region', { name: '基础与人设' })
          .getByRole('heading', { name: '周报伙伴', exact: true })
          .waitFor();
        expect(state.writes).toHaveLength(2);
        expect(state.writes[1]!.requestId).toBe(state.writes[0]!.requestId);
        expect(state.writes[1]!.profile.appearance?.accentColor).toBe('green');
        expect(state.writes[1]!.profile.description).toBe(
          '未由人设表单修改的个人简介',
        );
        expect(
          await page
            .getByRole('region', { name: '基础与人设' })
            .getAttribute('data-employee-accent'),
        ).toBe('green');
        expect(state.errors).toEqual([]);
        await writeFile(
          `${screenshotDir}/persona-${width}.json`,
          JSON.stringify(measured, null, 2),
        );
      } finally {
        await page.close();
      }
    },
    30_000,
  );

  it.each([1440, 390])(
    'returns from the persona editor to its employee without saving at %ipx',
    async (width) => {
      const { page, state } = await open({ width });
      try {
        const card = await showDetails(page);
        const exits = ['back', 'cancel', 'Escape', 'backdrop'] as const;
        let measured;
        for (const exit of exits) {
          const editor = await showEditor(page);
          await editor
            .getByRole('heading', { name: '编辑人设', exact: true })
            .waitFor();
          expect(
            await editor
              .getByRole('button', { name: '关闭', exact: true })
              .count(),
          ).toBe(0);
          const name = editor.getByRole('textbox', {
            name: '员工名字',
            exact: true,
          });
          expect(await name.inputValue()).toBe('流程哥');
          expect(
            await editor.getByRole('radio', { name: '鸢尾紫' }).isChecked(),
          ).toBe(true);
          await name.fill(`未保存的${exit}名字`);
          await editor.getByRole('radio', { name: '薄荷绿' }).check();
          if (exit === 'back') {
            measured = await editor.evaluate((node) => {
              const header = node.querySelector(':scope > header')!;
              const button = header.querySelector('button')!;
              const buttonRect = button.getBoundingClientRect();
              const heading = header
                .querySelector('h2')!
                .getBoundingClientRect();
              return {
                fits: node.scrollWidth <= node.clientWidth,
                buttonBeforeTitle: buttonRect.right <= heading.left,
                centers: Math.abs(
                  buttonRect.top +
                    buttonRect.height / 2 -
                    (heading.top + heading.height / 2),
                ),
                visibleControls: Array.from(
                  header.querySelectorAll('button'),
                ).every((control) => {
                  const rect = control.getBoundingClientRect();
                  return (
                    rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth
                  );
                }),
              };
            });
            expect(measured.fits).toBe(true);
            expect(measured.buttonBeforeTitle).toBe(true);
            expect(measured.centers).toBeLessThan(1);
            expect(measured.visibleControls).toBe(true);
            await editor.screenshot({
              path: `${screenshotDir}/persona-editor-back-${width}.png`,
            });
            await editor
              .getByRole('button', { name: '返回员工详情', exact: true })
              .focus();
            await page.keyboard.press('Enter');
          } else if (exit === 'Escape') {
            await page.keyboard.press('Escape');
          } else if (exit === 'backdrop') {
            await page.mouse.click(1, 1);
          } else {
            await editor
              .getByRole('button', { name: '取消', exact: true })
              .click();
          }
          await card
            .getByRole('heading', { name: '流程哥', exact: true })
            .waitFor();
          expect(await editor.count()).toBe(0);
          expect(
            await page
              .getByRole('button', { name: '关闭', exact: true })
              .isVisible(),
          ).toBe(true);
          expect(
            await page.getByRole('button', { name: '返回员工详情' }).count(),
          ).toBe(0);
          expect(
            await page
              .getByRole('dialog')
              .evaluate((node) => node.contains(document.activeElement)),
          ).toBe(true);
          expect(state.writes).toEqual([]);
        }
        await writeFile(
          `${screenshotDir}/persona-editor-back-${width}.json`,
          JSON.stringify({ measured, exits, writes: state.writes }, null, 2),
        );
        await page.getByRole('button', { name: '关闭', exact: true }).click();
        expect(await page.getByRole('dialog').count()).toBe(0);
        expect(state.errors).toEqual([]);
      } finally {
        await page.close();
      }
    },
    30_000,
  );

  it('keeps the persona editor open while saving and preserves a failed draft before returning', async () => {
    const { page, state } = await open({ width: 390 });
    let finishSave = () => {};
    state.saveGate = new Promise<void>((done) => {
      finishSave = done;
    });
    try {
      const card = await showDetails(page);
      const editor = await showEditor(page);
      const name = editor.getByRole('textbox', {
        name: '员工名字',
        exact: true,
      });
      await name.fill('保存失败仍保留的名字');
      await editor.getByRole('radio', { name: '薄荷绿' }).check();
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await expect.poll(() => state.writes.length).toBe(1);
      expect(
        await editor.getByRole('button', { name: '关闭', exact: true }).count(),
      ).toBe(0);
      for (const label of ['返回员工详情', '取消'])
        expect(
          await editor
            .getByRole('button', { name: label, exact: true })
            .isDisabled(),
        ).toBe(true);
      await page.keyboard.press('Escape');
      await page.mouse.click(1, 1);
      expect(await editor.isVisible()).toBe(true);
      expect(await name.inputValue()).toBe('保存失败仍保留的名字');
      await editor.screenshot({
        path: `${screenshotDir}/persona-editor-saving-390.png`,
      });
      finishSave();
      await editor.getByRole('alert').waitFor();
      expect(await name.inputValue()).toBe('保存失败仍保留的名字');
      expect(
        await editor.getByRole('radio', { name: '薄荷绿' }).isChecked(),
      ).toBe(true);
      const back = editor.getByRole('button', {
        name: '返回员工详情',
        exact: true,
      });
      expect(await back.isEnabled()).toBe(true);
      await back.click();
      await card
        .getByRole('heading', { name: '流程哥', exact: true })
        .waitFor();
      expect(state.writes).toHaveLength(1);
      expect(state.instance.profile.name).toBe('流程哥');
      expect(state.errors).toEqual([]);
    } finally {
      finishSave();
      await page.close();
    }
  }, 30_000);

  it('ignores a late editor read after returning and selecting another employee', async () => {
    const { page, state } = await open({ width: 390 });
    let finishRead = () => {},
      startedRead = () => {},
      sentRead = () => {};
    const gate = new Promise<void>((done) => {
      finishRead = done;
    });
    const started = new Promise<void>((done) => {
      startedRead = done;
    });
    const sent = new Promise<void>((done) => {
      sentRead = done;
    });
    await page.route(
      `**/api/v1/employee-instances/${id(7)}?*`,
      async (route) => {
        startedRead();
        await gate;
        await route.fulfill(json({ instance: state.instance }));
        sentRead();
      },
    );
    try {
      await showDetails(page);
      await page.getByRole('button', { name: '编辑员工', exact: true }).click();
      await started;
      const editor = page.getByRole('dialog', {
        name: '编辑人设',
        exact: true,
      });
      await editor.waitFor();
      expect(
        await editor.getByRole('button', { name: '关闭', exact: true }).count(),
      ).toBe(0);
      await editor
        .getByRole('button', { name: '返回员工详情', exact: true })
        .focus();
      await page.keyboard.press('Enter');
      const details = page.getByRole('dialog', {
        name: '流程哥员工详情',
        exact: true,
      });
      await details.getByRole('region', { name: '基础与人设' }).waitFor();
      await expect
        .poll(() =>
          details.evaluate((node) => node.contains(document.activeElement)),
        )
        .toBe(true);
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await page
        .getByRole('button', { name: '切换另一员工', exact: true })
        .click();
      const other = await showDetails(page);
      await other
        .getByRole('heading', { name: '另一位员工', exact: true })
        .waitFor();
      finishRead();
      await sent;
      expect(await editor.count()).toBe(0);
      expect(await other.locator('dd').first().innerText()).toBe(
        '另一位员工的使命',
      );
      expect(state.writes).toEqual([]);
      expect(state.errors).toEqual([]);
    } finally {
      finishRead();
      await page.close();
    }
  }, 30_000);

  it('keeps keyboard focus in employee details after a failed persona read', async () => {
    const { page, state } = await open({ width: 390 });
    await page.route(`**/api/v1/employee-instances/${id(7)}?*`, (route) =>
      route.fulfill(json({ error: { message: '读取人设暂时失败。' } }, 503)),
    );
    try {
      const card = await showDetails(page);
      await card.getByRole('button', { name: '编辑员工', exact: true }).click();
      const editor = page.getByRole('dialog', {
        name: '编辑人设',
        exact: true,
      });
      await editor.getByRole('alert').waitFor();
      expect(
        await editor.getByRole('button', { name: '关闭', exact: true }).count(),
      ).toBe(0);
      expect(await editor.getByRole('textbox').count()).toBe(0);
      await editor
        .getByRole('button', { name: '返回员工详情', exact: true })
        .focus();
      await page.keyboard.press('Enter');
      const details = page.getByRole('dialog', {
        name: '流程哥员工详情',
        exact: true,
      });
      await card.waitFor();
      await expect
        .poll(() =>
          details.evaluate((node) => node.contains(document.activeElement)),
        )
        .toBe(true);
      expect(await editor.count()).toBe(0);
      expect(state.writes).toEqual([]);
      expect(state.errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('shows an unset expression preference only in the owner general persona', async () => {
    const { page, state } = await open({ width: 1440, general: true });
    state.details.profile.expressionStyle = undefined;
    try {
      const card = await showDetails(page);
      expect(await card.locator('dt').allTextContents()).toEqual([
        '使命',
        '工作方式',
        '表达偏好',
      ]);
      expect(await card.locator('dd').last().innerText()).toBe('未设置');
      expect(
        await card
          .getByRole('button', { name: '编辑员工', exact: true })
          .count(),
      ).toBe(0);
      expect(state.writes).toEqual([]);
      expect(state.errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('keeps the shared persona read only and omits the hidden personal preference', async () => {
    const { page, state } = await open({
      width: 390,
      shared: true,
      dark: true,
    });
    state.details.profile.expressionStyle = undefined;
    try {
      const card = await showDetails(page);
      expect(await card.locator('dt').allTextContents()).toEqual([
        '使命',
        '工作方式',
      ]);
      expect(await card.getByText('未设置', { exact: true }).count()).toBe(0);
      expect(
        await card
          .getByRole('button', { name: '编辑员工', exact: true })
          .count(),
      ).toBe(0);
      expect(state.writes).toEqual([]);
      expect(state.reads).toEqual([
        `/api/v1/admin/organizations/${id(3)}/people/${id(5)}/ai-instances/${id(7)}/content`,
      ]);
      expect(await page.getByRole('form').count()).toBe(0);
      expect(
        await page
          .getByText('未由人设表单修改的个人简介', { exact: true })
          .count(),
      ).toBe(0);
      expect(state.errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('keeps a failed or late detail response out of a newly selected employee', async () => {
    const { page, state } = await open({ width: 390 });
    let finishOld!: () => void;
    const oldResponse = new Promise<void>((done) => {
      finishOld = done;
    });
    let startedOld!: () => void;
    const oldStarted = new Promise<void>((done) => {
      startedOld = done;
    });
    let settledOld!: () => void;
    const oldSettled = new Promise<void>((done) => {
      settledOld = done;
    });
    let read = 0;
    await page.route(
      `**/api/v1/employee-instances/${id(7)}/content?*`,
      async (route) => {
        if (++read === 1)
          return route.fulfill(json({ error: { message: '读取失败。' } }, 503));
        startedOld();
        await oldResponse;
        await route.fulfill(json(state.details)).catch(() => {});
        settledOld();
      },
    );
    try {
      await page
        .getByRole('button', { name: '打开员工详情', exact: true })
        .click();
      await page.getByRole('alert').first().waitFor();
      expect(
        await page
          .getByRole('region', { name: '基础与人设', exact: true })
          .count(),
      ).toBe(0);
      await page.getByRole('button', { name: '重新读取', exact: true }).click();
      await page
        .getByRole('status', { name: '正在加载员工详情', exact: true })
        .waitFor();
      await oldStarted;
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await page
        .getByRole('button', { name: '切换另一员工', exact: true })
        .click();
      const card = await showDetails(page);
      await card
        .getByRole('heading', { name: '另一位员工', exact: true })
        .waitFor();
      finishOld();
      await oldSettled;
      expect(
        await card
          .getByRole('heading', { name: '流程哥', exact: true })
          .count(),
      ).toBe(0);
      expect(await card.locator('dd').first().innerText()).toBe(
        '另一位员工的使命',
      );
      expect(state.writes).toEqual([]);
      expect(state.errors).toEqual([]);
    } finally {
      finishOld();
      await page.close();
    }
  });
});
