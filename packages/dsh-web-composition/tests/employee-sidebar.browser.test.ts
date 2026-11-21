import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startInstalledProfile } from './installed-profile';
import { documentSession, processSession } from './native-history.mjs';
import { createBrowserArtifacts } from './browser-artifacts';
import { createSidebarFixtureData } from './fixtures/sidebar-data.mjs';
import { compareSidebarPixels } from './sidebar-pixels';
import {
  sidebarBaselineHead,
  writeLegacySidebarBaseline,
} from './legacy-sidebar-baseline';

interface OwnerEvent {
  event: string;
  root?: string;
  employee?: string;
}

interface SidebarTest {
  fixtureEmployee: string;
  commands: { name: string; id?: string }[];
  settingsLauncher: () => { ready: boolean; open: boolean };
  openSession: (id: string) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setState: (state: string) => void;
  baseline: (shown: boolean, width?: number) => void;
  controlledOwner: {
    events: OwnerEvent[];
    start: () => void;
    holdNextCreation: () => void;
    pendingCreation: () => string | null;
    releaseCreation: () => void;
    changeRevision: () => void;
    denyNext: () => void;
    deliverLate: (root: string) => void;
    stop: () => Promise<void>;
  };
  nativeInput: (
    id?: string,
  ) => Promise<{ draft: string; attachmentCount: number }>;
  retainInput: (id?: string) => Promise<void>;
  releaseInput: (id?: string) => void;
  nativeRetention: (id?: string) => {
    referenceCount: number;
    retainedBy: Record<string, number>;
  };
  nativeReady: (id?: string) => Promise<string>;
  nativeScroll: (id?: string) => {
    anchorKey: string;
    anchorTop: number;
    scrollTop: number;
  } | null;
}
declare global {
  interface Window {
    __allriceSidebarTest?: SidebarTest;
    __allriceFixtureEmployee?: string;
  }
}

const suite =
  process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1'
    ? describe
    : describe.skip;
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );

const readingSnapshot = (node: Element) => ({
  at: performance.now(),
  sessionId: node
    .closest('[data-conversation-session]')
    ?.getAttribute('data-conversation-session'),
  scrollTop: node.scrollTop,
  scrollHeight: node.scrollHeight,
  clientHeight: node.clientHeight,
  saved: window.__allriceSidebarTest!.nativeScroll(),
  retention: window.__allriceSidebarTest!.nativeRetention(),
});

const sidebarGeometry = (view: Page, selector = '#chat-sidebar') =>
  view.locator(selector).evaluate((frame) => {
    const read = (node: Element | null) => {
      if (!node) return null;
      const { x, y, width, height } = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        rect: { x, y, width, height },
        className: node.className,
        display: style.display,
        position: style.position,
        width: style.width,
        minWidth: style.minWidth,
        flex: style.flex,
        gridTemplateColumns: style.gridTemplateColumns,
        boxSizing: style.boxSizing,
        borderLeftWidth: style.borderLeftWidth,
        borderRightWidth: style.borderRightWidth,
        reservedScrollbarWidth:
          width -
          node.clientWidth -
          parseFloat(style.borderLeftWidth) -
          parseFloat(style.borderRightWidth),
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
        scrollbarGutter: style.scrollbarGutter,
        scrollbarToken: style.getPropertyValue('--dsh-scrollbar-width').trim(),
        scrollbarPaintWidth: getComputedStyle(node, '::-webkit-scrollbar')
          .width,
        fontFamily: style.fontFamily,
        fontWeight: style.fontWeight,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        fontSmoothing: style.getPropertyValue('-webkit-font-smoothing'),
        textAutospace: style.getPropertyValue('text-autospace'),
        cornerShape: style.getPropertyValue('corner-shape'),
        labelSecondary: style
          .getPropertyValue('--dsw-alias-label-secondary')
          .trim(),
        labelTertiary: style
          .getPropertyValue('--dsw-alias-label-tertiary')
          .trim(),
        leafText: node.childElementCount ? null : node.textContent,
        color: style.color,
        backgroundColor: style.backgroundColor,
        hovered: node.matches(':hover'),
        focused: node === document.activeElement,
      };
    };
    const tree = frame.querySelector('[role="tree"][aria-label="员工与工作"]');
    // The old compact main owns a 57px anchor track; the native slot is inside
    // its own bordered column. Neither hidden anchor is the fixed overlay.
    let column = frame,
      grid = frame.parentElement;
    while (grid && getComputedStyle(grid).display !== 'grid') {
      column = grid;
      grid = grid.parentElement;
    }
    const firstTrack = grid
      ? parseFloat(getComputedStyle(grid).gridTemplateColumns)
      : NaN;
    const columnStyle = getComputedStyle(column);
    const columnInset =
      column === frame
        ? 0
        : parseFloat(columnStyle.borderLeftWidth) +
          parseFloat(columnStyle.borderRightWidth) +
          parseFloat(columnStyle.paddingLeft) +
          parseFloat(columnStyle.paddingRight);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      compact: matchMedia('(max-width: 760px)').matches,
      document: {
        lang: document.documentElement.lang,
        theme: document.documentElement.getAttribute('data-theme'),
        dark: document.body.hasAttribute('data-ds-dark-theme'),
        fonts: document.fonts.status,
        dpr: devicePixelRatio,
      },
      frame: read(frame),
      root: read(frame.lastElementChild),
      parent: read(frame.parentElement),
      layout: read(frame.parentElement?.parentElement ?? null),
      body: read(document.body),
      hostGrid: read(grid),
      hostColumn: read(column),
      anchorBudget: {
        kind: column === frame ? 'grid-track' : 'column-content',
        firstTrack,
        columnInset,
        width: firstTrack - columnInset,
      },
      tree: read(tree),
      groups: [...(tree?.querySelectorAll(':scope > section') ?? [])].map(
        (group) => {
          const label = group.getAttribute('aria-label');
          const row = group.querySelector('[data-row-key^="workspace:"]');
          const title = [...(row?.querySelectorAll('span') ?? [])].find(
            (node) => !node.childElementCount && node.textContent === label,
          );
          const range = document.createRange();
          if (title) range.selectNodeContents(title);
          return {
            label,
            card: read(group.firstElementChild),
            row: read(row),
            title: read(title ?? null),
            titleLines: title
              ? [...range.getClientRects()].map(({ x, y, width, height }) => ({
                  x,
                  y,
                  width,
                  height,
                }))
              : [],
            actions: [
              ...group.firstElementChild!.querySelectorAll('button'),
            ].map(read),
            sessions: [
              ...group.querySelectorAll('[data-row-key^="session:"]'),
            ].map((session) => ({
              id: session.getAttribute('data-row-key'),
              row: read(session),
              title: read(session.children[1] ?? null),
              time: read(session.children[2] ?? null),
            })),
          };
        },
      ),
    };
  });

type SidebarGeometry = Awaited<ReturnType<typeof sidebarGeometry>>;
const sidebarVisualDifferences = (
  before: SidebarGeometry,
  after: SidebarGeometry,
) => {
  const differences: string[] = [];
  const box = (
    path: string,
    a: SidebarGeometry['root'],
    b: SidebarGeometry['root'],
  ) => {
    if (!a || !b) {
      differences.push(`${path}: missing measured element`);
      return;
    }
    for (const key of ['x', 'y', 'width', 'height'] as const)
      if (Math.abs(a.rect[key] - b.rect[key]) > 0.5)
        differences.push(`${path}.${key}: ${a.rect[key]} / ${b.rect[key]}`);
    for (const key of [
      'clientWidth',
      'scrollWidth',
      'reservedScrollbarWidth',
    ] as const)
      if (Math.abs(a[key] - b[key]) > 0.5)
        differences.push(`${path}.${key}: ${a[key]} / ${b[key]}`);
    for (const key of [
      'fontFamily',
      'fontWeight',
      'fontSize',
      'lineHeight',
      'letterSpacing',
      'fontSmoothing',
      'textAutospace',
      'cornerShape',
      'leafText',
      'color',
      'backgroundColor',
      'hovered',
      'focused',
    ] as const)
      if (a[key] !== b[key])
        differences.push(`${path}.${key}: ${a[key]} / ${b[key]}`);
  };
  box('root', before.root, after.root);
  box('tree', before.tree, after.tree);
  if (before.tree?.scrollbarPaintWidth !== after.tree?.scrollbarPaintWidth)
    differences.push(
      `tree.scrollbarPaintWidth: ${before.tree?.scrollbarPaintWidth} / ${after.tree?.scrollbarPaintWidth}`,
    );
  if (before.groups.length !== after.groups.length)
    differences.push('group count differs');
  before.groups.forEach((group, index) => {
    const current = after.groups[index];
    if (!current || group.label !== current.label) {
      differences.push(`group ${index}: identity differs`);
      return;
    }
    for (const key of ['card', 'row', 'title'] as const)
      box(`${group.label}.${key}`, group[key], current[key]);
    if (group.titleLines.length !== current.titleLines.length)
      differences.push(`${group.label}: title line count differs`);
    group.titleLines.forEach((line, index) => {
      const other = current.titleLines[index];
      for (const key of ['x', 'y', 'width', 'height'] as const)
        if (!other || Math.abs(line[key] - other[key]) > 0.5)
          differences.push(`${group.label}.line${index}.${key} differs`);
    });
    if (group.actions.length !== current.actions.length)
      differences.push(`${group.label}: action count differs`);
    group.actions.forEach((action, index) =>
      box(
        `${group.label}.action${index}`,
        action,
        current.actions[index] ?? null,
      ),
    );
    if (group.sessions.length !== current.sessions.length)
      differences.push(`${group.label}: session count differs`);
    group.sessions.forEach((session, index) => {
      const other = current.sessions[index];
      if (!other || other.id !== session.id)
        differences.push(`${session.id}: identity differs`);
      else
        for (const key of ['row', 'title', 'time'] as const)
          box(`${session.id}.${key}`, session[key], other[key]);
    });
  });
  return differences;
};

const prepareSidebarCapture = async (view: Page) => {
  const viewport = view.viewportSize()!;
  // Actual pointer/focus events, not a CSS :hover override. The last viewport
  // pixel is outside both desktop and compact sidebar content.
  await view.mouse.move(viewport.width - 1, viewport.height - 1);
  await view.evaluate(async () => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    await document.fonts.ready;
  });
  await view.waitForFunction(() => {
    const root = document.querySelector('#chat-sidebar')!.lastElementChild!;
    return !root.matches(':hover') && !root.querySelector(':hover');
  });
  await settle(view);
};

suite('real AllRice sidebar in installed native profiles', () => {
  const hosts: Awaited<ReturnType<typeof startInstalledProfile>>[] = [];
  const errors: string[] = [],
    legacyRequests: string[] = [];
  let browser: Browser,
    context: BrowserContext,
    page: Page,
    other: Page,
    legacy: Page,
    artifacts: string,
    legacyUrl: string;
  let readingAttempt: Record<string, unknown> | undefined;

  const open = async (view: Page, host: (typeof hosts)[number]) => {
    view.setDefaultTimeout(15_000);
    view.on('pageerror', (error) => errors.push(error.message));
    view.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/v1/')) legacyRequests.push(path);
    });
    await view.goto(host.authUrl);
    const proceed = view.getByRole('button', { name: /^(Continue|继续)$/ });
    await proceed
      .waitFor({ state: 'visible', timeout: 5000 })
      .catch(() => undefined);
    if (await proceed.isVisible()) await proceed.click();
    await view.goto(host.origin);
    await view.waitForFunction(() => !!window.__allriceSidebarTest);
    await view
      .getByText('请核对三条销售记录，计算合计，并简要说明结果。', {
        exact: true,
      })
      .waitFor();
  };

  beforeAll(async () => {
    artifacts = await createBrowserArtifacts();
    console.info(`Employee sidebar browser evidence: ${artifacts}`);
    legacyUrl = await writeLegacySidebarBaseline(artifacts);
    const options = {
      fixtureGlobals: {
        __allriceSidebarFixtureData: createSidebarFixtureData(),
        __allriceSidebarNativeSessions: {
          first: processSession,
          second: documentSession,
        },
      },
    };
    hosts.push(
      await startInstalledProfile(
        new URL('./fixtures/sidebar-client.js', import.meta.url),
        options,
      ),
    );
    hosts.push(
      await startInstalledProfile(
        new URL('./fixtures/sidebar-client.js', import.meta.url),
        options,
      ),
    );
    browser = await chromium.launch({
      headless: true,
      ...(process.env.ALLRICE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ALLRICE_BROWSER_EXECUTABLE }
        : {}),
    });
    // Both Hosts share one browser context; distinct origins, not two incognito
    // contexts, supply native localStorage isolation in this experiment.
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      timezoneId: 'UTC',
    });
    await context.addInitScript(() => {
      Date.now = () => Date.parse('2026-11-21T12:00:00.000Z');
    });
    page = await context.newPage();
    other = await context.newPage();
    legacy = await context.newPage();
    legacy.on('pageerror', (error) =>
      errors.push(`pinned base: ${error.message}`),
    );
    await other.addInitScript(() => {
      window.__allriceFixtureEmployee = 'writer';
    });
    await open(page, hosts[0]!);
    await open(other, hosts[1]!);
  }, 90_000);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      for (const host of hosts.reverse()) await host.close();
    }
  });

  afterEach(async ({ task }) => {
    const reading = readingAttempt;
    readingAttempt = undefined;
    if (task.result?.state !== 'fail' || !artifacts || !page || page.isClosed())
      return;
    await page.screenshot({
      animations: 'disabled',
      path: join(artifacts, `first-failure-${task.id}.png`),
      fullPage: true,
    });
    await writeFile(
      join(artifacts, `first-failure-${task.id}.json`),
      JSON.stringify(
        {
          name: task.name,
          errors: task.result.errors,
          pageErrors: errors,
          legacyRequests,
          navigation: await page.evaluate(() => ({
            commands: window.__allriceSidebarTest?.commands,
            events: window.__allriceSidebarTest?.controlledOwner.events,
          })),
          layout: await page
            .evaluate(() => {
              const describe = (node: Element) => {
                const rect = node.getBoundingClientRect(),
                  style = getComputedStyle(node);
                return {
                  tag: node.tagName,
                  className: node.getAttribute('class'),
                  label: node.getAttribute('aria-label'),
                  rect: rect.toJSON(),
                  display: style.display,
                  position: style.position,
                  zIndex: style.zIndex,
                  padding: style.padding,
                  margin: style.margin,
                  font: style.font,
                  color: style.color,
                  pointerEvents: style.pointerEvents,
                };
              };
              const sidebar = document.querySelector('#chat-sidebar');
              const targets = [
                sidebar,
                sidebar?.firstElementChild,
                document.querySelector('[data-row-key="session:thread-0"]'),
                document.querySelector('[aria-label="自动化任务"]'),
                [...(sidebar?.querySelectorAll('button') ?? [])].find(
                  (button) => button.textContent?.startsWith('展开其余'),
                ),
              ].filter((node): node is Element => !!node);
              return targets.map((node) => {
                const rect = node.getBoundingClientRect();
                return {
                  ...describe(node),
                  centerHitStack: document
                    .elementsFromPoint(
                      rect.x + rect.width / 2,
                      rect.y + rect.height / 2,
                    )
                    .slice(0, 6)
                    .map(describe),
                };
              });
            })
            .catch((error) => ({ diagnosticError: String(error) })),
          reading: reading && {
            ...reading,
            last: await page
              .locator('[data-conversation-scroll]')
              .first()
              .evaluate(readingSnapshot)
              .catch((error) => ({ error: String(error) })),
          },
        },
        null,
        2,
      ),
    );
  });

  it('preserves the real brand, employee cards, pagination and command entrypoints without any 3.x reader', async () => {
    const sidebar = page.locator('#chat-sidebar');
    expect(
      await sidebar.getByRole('img', { name: 'Allrice Workspace' }).isVisible(),
    ).toBe(true);
    expect(await sidebar.locator('[data-row-key^="session:"]').count()).toBe(
      10,
    );
    await sidebar
      .getByRole('button', { name: /^展开其余/ })
      .first()
      .click();
    expect(
      await sidebar.locator('[data-row-key^="session:"]').count(),
    ).toBeGreaterThan(30);
    await sidebar
      .getByRole('button', { name: '收起更多会话', exact: true })
      .click();
    await sidebar
      .getByRole('button', { name: '创建员工', exact: true })
      .click();
    await sidebar
      .getByRole('button', { name: '查看Rice详情', exact: true })
      .click();
    await sidebar
      .getByRole('button', { name: '和 Rice 开新会话', exact: true })
      .click();
    await page.waitForFunction(
      () => window.__allriceSidebarTest!.settingsLauncher().ready,
    );
    const settingsTrigger = sidebar.getByRole('button', {
      name: '设置',
      exact: true,
    });
    await settingsTrigger.click();
    const settings = page.locator('[data-shortcut-modal="settings"]');
    await settings.waitFor({ state: 'visible' });
    expect(await settings.count()).toBe(1);
    await settings
      .getByRole('button', { name: 'AllRice 账号', exact: true })
      .waitFor();
    await page.waitForFunction(
      () => window.__allriceSidebarTest!.settingsLauncher().open,
    );
    expect(await settingsTrigger.getAttribute('aria-expanded')).toBe('true');
    await settings.getByRole('button', { name: '关闭', exact: true }).click();
    await settings.waitFor({ state: 'detached' });
    await page.waitForFunction(
      () => !window.__allriceSidebarTest!.settingsLauncher().open,
    );
    expect(await settingsTrigger.getAttribute('aria-expanded')).toBe('false');
    await sidebar
      .getByRole('button', { name: '查看归档', exact: true })
      .click();
    await sidebar
      .getByRole('button', { name: '返回当前工作', exact: true })
      .click();
    expect(
      await page.evaluate(() =>
        window.__allriceSidebarTest!.commands.map((row) => row.name),
      ),
    ).toEqual(
      expect.arrayContaining([
        'create-employee',
        'details',
        'new-thread',
        'open-archive',
      ]),
    );
    await sidebar
      .getByRole('button', { name: '自动化任务', exact: true })
      .click();
    await page
      .getByText('还没有自动化任务，在会话中创建的任务会显示在这里', {
        exact: true,
      })
      .waitFor();
    await page.evaluate(
      (id) => window.__allriceSidebarTest!.openSession(id),
      processSession,
    );
    for (const state of ['loading', 'error', 'denied', 'empty', 'ready']) {
      await page.evaluate(
        (kind) => window.__allriceSidebarTest!.setState(kind),
        state,
      );
      if (state === 'error')
        await sidebar.getByText('会话暂未更新', { exact: true }).waitFor();
      if (state === 'loading')
        await sidebar.getByText('正在更新会话…', { exact: true }).waitFor();
      if (state === 'denied')
        await sidebar
          .getByRole('alert')
          .filter({ hasText: '当前员工暂不可用' })
          .waitFor();
      if (state === 'empty')
        expect(
          await sidebar.locator('[data-row-key^="session:"]').count(),
        ).toBe(0);
    }
    expect(legacyRequests).toEqual([]);
  }, 60_000);

  it('drives controlled Cordis/reference lifetimes from real sidebar clicks and ignores superseded UI results', async () => {
    const click = (id: string) =>
      page.locator(`[data-row-key="session:${id}"]`).click();
    const owner = () =>
      page.evaluate(() => window.__allriceSidebarTest!.controlledOwner.events);
    await page.evaluate(() =>
      window.__allriceSidebarTest!.controlledOwner.start(),
    );
    try {
      await click('thread-0');
      await page.waitForFunction(
        () =>
          window.__allriceSidebarTest!.controlledOwner.events.filter(
            (row) => row.event === 'ui:opened',
          ).length === 1,
      );
      const firstRoot = (await owner()).find(
        (row) => row.event === 'create:start',
      )!.root!;
      await click('thread-1');
      await page.waitForFunction(
        () =>
          window.__allriceSidebarTest!.controlledOwner.events.filter(
            (row) => row.event === 'ui:opened',
          ).length === 2,
      );
      expect(
        (await owner()).filter((row) => row.event === 'create:start'),
      ).toHaveLength(1);
      await click('thread-32');
      await page.waitForFunction(
        () =>
          window.__allriceSidebarTest!.controlledOwner.events.filter(
            (row) => row.event === 'ui:opened',
          ).length === 3,
      );
      const events = await owner();
      const closed = events.findIndex(
        (row) => row.root === firstRoot && row.event === 'destroy:done',
      );
      const secondCreate = events.findIndex(
        (row) => row.root !== firstRoot && row.event === 'create:start',
      );
      expect(closed).toBeGreaterThan(-1);
      expect(secondCreate).toBeGreaterThan(closed);
      expect(
        events.filter(
          (row) =>
            row.root === firstRoot && row.event === 'native-reference:release',
        ),
      ).toHaveLength(2);
      expect(
        events.filter((row) => row.root === firstRoot).map((row) => row.event),
      ).toEqual(
        expect.arrayContaining([
          'lifetime:abort',
          'resource:cancel',
          'resource:settled',
          'references:released',
          'cordis:disposed',
        ]),
      );

      await page.evaluate(() =>
        window.__allriceSidebarTest!.controlledOwner.holdNextCreation(),
      );
      await click('thread-0');
      await page.waitForFunction(
        () =>
          window.__allriceSidebarTest!.controlledOwner.pendingCreation() !==
          null,
      );
      const lateRoot = await page.evaluate(() =>
        window.__allriceSidebarTest!.controlledOwner.pendingCreation(),
      );
      await click('thread-32');
      await page.evaluate(() =>
        window.__allriceSidebarTest!.controlledOwner.releaseCreation(),
      );
      await page.waitForFunction(
        () =>
          window.__allriceSidebarTest!.controlledOwner.events.filter(
            (row) => row.event === 'ui:opened',
          ).length === 4,
      );
      await page.evaluate(
        ([first, late]) => {
          window.__allriceSidebarTest!.controlledOwner.deliverLate(first!);
          window.__allriceSidebarTest!.controlledOwner.deliverLate(late!);
        },
        [firstRoot, lateRoot],
      );
      expect(
        await page
          .getByLabel('受控员工导航')
          .getAttribute('data-owner-current'),
      ).toBe('writer');
      const superseded = await owner();
      expect(
        superseded.filter(
          (row) => row.event === 'ui:opened' && row.employee === 'rice',
        ),
      ).toHaveLength(2);
      expect(
        superseded.filter((row) => row.event === 'late-ui:ignored'),
      ).toHaveLength(2);
      expect(
        superseded.some(
          (row) =>
            row.root === lateRoot && row.event === 'native-reference:ready',
        ),
      ).toBe(false);
      expect(
        superseded.some(
          (row) => row.root === lateRoot && row.event === 'cordis:disposed',
        ),
      ).toBe(true);

      await page.evaluate(() =>
        window.__allriceSidebarTest!.controlledOwner.changeRevision(),
      );
      await click('thread-33');
      await page.waitForFunction(
        () =>
          window.__allriceSidebarTest!.controlledOwner.events.filter(
            (row) => row.event === 'ui:opened',
          ).length === 5,
      );
      expect(
        (await owner()).filter((row) => row.event === 'create:start').at(-1)!
          .root,
      ).toContain('writer/2');
      await page.evaluate(() =>
        window.__allriceSidebarTest!.controlledOwner.denyNext(),
      );
      await click('thread-0');
      await page
        .getByRole('alert')
        .filter({ hasText: 'controlled admission denied' })
        .waitFor();
      expect(
        await page
          .getByLabel('受控员工导航')
          .getAttribute('data-owner-current'),
      ).toBe('');
      await writeFile(
        join(artifacts, 'sidebar-navigation-owner.json'),
        JSON.stringify(
          {
            events: await owner(),
            exercised:
              'real sidebar click -> exported EmployeeClientNavigation -> real isolated Cordis Context + native SessionReference retain/release + ReadableStream cancellation; late creation/UI and revision/denial',
            unavailable:
              'Native Web Client/HTTP/WS/Host mount adapter and authenticated DEntry remain unbound; controlled mode does not call uiWorkspace.openSession and does not claim cross-Host native recovery.',
          },
          null,
          2,
        ),
      );
    } finally {
      await page.evaluate(() =>
        window.__allriceSidebarTest!.controlledOwner.stop(),
      );
    }
  }, 60_000);

  it('keeps attachments only while a native Session reference is retained and records scope-release/cross-root boundaries', async () => {
    await page.evaluate(
      (id) => window.__allriceSidebarTest!.openSession(id),
      processSession,
    );
    const editor = page
      .locator('textarea:visible,[contenteditable=true]:visible')
      .first();
    await editor.fill('员工 A 的未发送草稿');
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles({
        name: '合成草稿附件.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('fixture attachment only'),
      });
    await page.waitForFunction(
      async () =>
        (await window.__allriceSidebarTest!.nativeInput()).attachmentCount ===
        1,
    );
    // This is an explicit native reference owned by the fixture, not the
    // production navigation owner (which is still unbound). Keep the original
    // positive attachment assertion and also prove what happens after release.
    await page.evaluate(() => window.__allriceSidebarTest!.retainInput());
    let retainedOwnership, retainedInput;
    try {
      await page.evaluate(
        (id) => window.__allriceSidebarTest!.openSession(id),
        documentSession,
      );
      await page
        .getByText('已按你选择的 Markdown 格式交付核对说明。', { exact: true })
        .waitFor();
      expect(
        await page.evaluate(
          (id) => window.__allriceSidebarTest!.nativeInput(id),
          documentSession,
        ),
      ).toEqual({ draft: '', attachmentCount: 0 });
      retainedOwnership = await page.evaluate(() =>
        window.__allriceSidebarTest!.nativeRetention(),
      );
      expect(retainedOwnership.retainedBy.workspaceOperation).toBe(1);
      await page.evaluate(
        (id) => window.__allriceSidebarTest!.openSession(id),
        processSession,
      );
      await editor.waitFor();
      retainedInput = await page.evaluate(() =>
        window.__allriceSidebarTest!.nativeInput(),
      );
      expect(retainedInput).toEqual({
        draft: '员工 A 的未发送草稿',
        attachmentCount: 1,
      });
    } finally {
      await page.evaluate(() => window.__allriceSidebarTest!.releaseInput());
    }
    await page.evaluate(
      (id) => window.__allriceSidebarTest!.openSession(id),
      documentSession,
    );
    await page
      .getByText('已按你选择的 Markdown 格式交付核对说明。', { exact: true })
      .waitFor();
    const afterRelease = await page.evaluate(() =>
      window.__allriceSidebarTest!.nativeRetention(),
    );
    expect(afterRelease.referenceCount).toBe(0);
    await page.evaluate(
      (id) => window.__allriceSidebarTest!.openSession(id),
      processSession,
    );
    await editor.waitFor();
    const reopened = await page.evaluate(() =>
      window.__allriceSidebarTest!.nativeInput(),
    );
    expect(reopened).toEqual({
      draft: '员工 A 的未发送草稿',
      attachmentCount: 0,
    });
    expect(
      await other.evaluate(() => window.__allriceSidebarTest!.nativeInput()),
    ).toEqual({ draft: '', attachmentCount: 0 });
    await other
      .locator('textarea:visible,[contenteditable=true]:visible')
      .first()
      .fill('员工 B 的独立草稿');
    expect(
      (await page.evaluate(() => window.__allriceSidebarTest!.nativeInput()))
        .draft,
    ).toBe('员工 A 的未发送草稿');

    // A second native root at the SAME origin observes the same persisted draft
    // for the same native ID. This is retained limitation evidence, not product
    // employee authorization or a passed same-origin isolation claim.
    const sameOrigin = await context.newPage();
    try {
      await sameOrigin.addInitScript(() => {
        window.__allriceFixtureEmployee = 'writer';
      });
      await open(sameOrigin, hosts[0]!);
      const same = await sameOrigin.evaluate(() =>
        window.__allriceSidebarTest!.nativeInput(),
      );
      expect(same).toEqual({
        draft: '员工 A 的未发送草稿',
        attachmentCount: 0,
      });
      await writeFile(
        join(artifacts, 'native-storage-boundary.json'),
        JSON.stringify(
          {
            nativeSessionId: processSession,
            syntheticBusinessEmployees: ['rice', 'writer'],
            retainedSession: {
              retentionWhileAway: retainedOwnership,
              reopened: retainedInput,
              owner: 'explicit test-only native SessionReference',
            },
            releasedSession: { retention: afterRelease, reopened },
            sameOriginSecondRoot: same,
            otherOrigin: await other.evaluate(() =>
              window.__allriceSidebarTest!.nativeInput(),
            ),
            conclusion:
              'Draft persistence is origin/session-scoped. Attachments survive only while a Session reference keeps the input scope alive; after the final release they are absent even in the same Host. The fixture retain is not a bound production owner. No authenticated route or cross-root receipt restore is proven.',
          },
          null,
          2,
        ),
      );
    } finally {
      await sameOrigin.close();
    }
    await editor.fill('');
  }, 60_000);

  it('uses the native reading anchor for same-Host session switches', async () => {
    readingAttempt = { phase: 'open' };
    // This history fits at 600px. Use an actually overflowing native viewport,
    // so wheel movement (rather than a synthetic saved value) owns the anchor.
    // Keep the native default disclosure state on both sides of the switch;
    // expanded local details are not a persisted reading-position contract.
    await page.setViewportSize({ width: 1440, height: 300 });
    await page.evaluate(
      (id) => window.__allriceSidebarTest!.openSession(id),
      processSession,
    );
    readingAttempt.openState = await page.evaluate(() =>
      window.__allriceSidebarTest!.nativeReady(),
    );
    expect(readingAttempt.openState).toBe('open');
    const scrollport = async () => {
      const text = await page
        .getByText('请核对三条销售记录，计算合计，并简要说明结果。', {
          exact: true,
        })
        .elementHandle();
      const handle = await text!.evaluateHandle((node) => {
        // ChatViewport binds this same public shell marker before falling back
        // to its own list; do not guess which ancestor happens to overflow.
        return node.closest('[data-conversation-scroll]');
      });
      return handle.asElement();
    };
    const port = await scrollport();
    expect(port).not.toBeNull();
    await page.waitForFunction(
      (node) =>
        node!.scrollHeight > node!.clientHeight + 20 && node!.scrollTop > 0,
      port,
    );
    await settle(page);
    const before = await port!.evaluate(readingSnapshot);
    readingAttempt.beforeWheel = before;
    expect(before.scrollHeight - before.clientHeight).toBeGreaterThan(20);
    expect(before.scrollTop).toBeGreaterThan(0);
    const box = await port!.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, -80);
    readingAttempt.phase = 'native-save';
    readingAttempt.afterWheelDispatch = await port!.evaluate(readingSnapshot);
    // wheel() only dispatches input. Native ChatReading saves after its scroll
    // sampling/scrollend; an async predicate would itself be a truthy Promise.
    const savedHandle = await page.waitForFunction(
      ({ node, previous }) => {
        const position = window.__allriceSidebarTest!.nativeScroll();
        return position !== null &&
          node!.scrollTop < previous &&
          Math.abs(node!.scrollTop - position.scrollTop) <= 0.5
          ? position
          : null;
      },
      { node: port, previous: before.scrollTop },
    );
    const saved = await savedHandle.jsonValue();
    await savedHandle.dispose();
    readingAttempt.saved = saved;
    expect(saved).not.toBeNull();
    expect(saved!.scrollTop).toBeLessThan(before.scrollTop);
    await page.evaluate(
      (id) => window.__allriceSidebarTest!.openSession(id),
      documentSession,
    );
    await page
      .getByText('已按你选择的 Markdown 格式交付核对说明。', { exact: true })
      .waitFor();
    await page.evaluate(
      (id) => window.__allriceSidebarTest!.openSession(id),
      processSession,
    );
    readingAttempt.phase = 'native-restore';
    readingAttempt.reopenedState = await page.evaluate(() =>
      window.__allriceSidebarTest!.nativeReady(),
    );
    expect(readingAttempt.reopenedState).toBe('open');
    await settle(page);
    const restoredPort = await scrollport();
    expect(restoredPort).not.toBeNull();
    await page.waitForFunction(
      ({ node, position }) =>
        Math.abs(node!.scrollTop - position!.scrollTop) <= 0.5,
      { node: restoredPort, position: saved },
    );
    readingAttempt.restored = await restoredPort!.evaluate(readingSnapshot);
    expect(
      Math.abs(
        (await restoredPort!.evaluate((node) => node.scrollTop)) -
          saved!.scrollTop,
      ),
    ).toBeLessThanOrEqual(0.5);
    await writeFile(
      join(artifacts, 'native-reading-anchor.json'),
      JSON.stringify(
        {
          saved,
          beforeWheel: before,
          attempt: readingAttempt,
          restored: await page.evaluate(() =>
            window.__allriceSidebarTest!.nativeScroll(),
          ),
          scope:
            'same native root only; public ChatViewSlotProps owner may wrap chatScroll, but no cross-root owner adapter is bound/tested here',
        },
        null,
        2,
      ),
    );
  }, 60_000);

  it('replays identical Frame/View data in light/dark at 1440/390 and keeps mobile keyboard focus bounded', async () => {
    await mkdir(artifacts, { recursive: true });
    const comparisons: {
      width: number;
      theme: string;
      state: string;
      geometryDifferences: string[];
      pixels: ReturnType<typeof compareSidebarPixels>;
    }[] = [];
    for (const width of [1440, 390])
      for (const theme of ['light', 'dark'] as const) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(
          (mode) => window.__allriceSidebarTest!.setTheme(mode),
          theme,
        );
        if (width === 390) {
          await page
            .getByRole('button', { name: '展开侧边栏', exact: true })
            .click();
          await page
            .getByRole('dialog', { name: '任务与历史', exact: true })
            .waitFor();
        }
        await prepareSidebarCapture(page);
        expect
          .soft(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
          )
          .toBe(false);
        const nativeFrame = page.locator('#chat-sidebar');
        const frameBox = await nativeFrame.boundingBox();
        const native = nativeFrame.locator(':scope > div').last();
        const box = await native.boundingBox();
        const baseUrl = new URL(legacyUrl);
        baseUrl.searchParams.set('theme', theme);
        // sidebarWidth is the containing column's border-box budget. Passing
        // the inner width would subtract the Frame's 1px border a second time.
        baseUrl.searchParams.set('sidebarWidth', String(frameBox!.width));
        await legacy.setViewportSize({ width, height: 1000 });
        await legacy.goto(baseUrl.href);
        await legacy.locator('#chat-sidebar').waitFor();
        await settle(legacy);
        const old = legacy.locator('#chat-sidebar > div').last();
        const capturePair = async (state: 'preview' | 'expanded') => {
          await prepareSidebarCapture(page);
          await prepareSidebarCapture(legacy);
          const current = await sidebarGeometry(page),
            previous = await sidebarGeometry(legacy);
          await appendFile(
            join(artifacts, 'sidebar-geometry.jsonl'),
            `${JSON.stringify({
              width,
              theme,
              phase:
                state === 'preview' ? 'pinned-base' : 'pinned-base-expanded',
              measuredNative: { frame: frameBox, root: box },
              native: current,
              legacy: previous,
            })}\n`,
          );
          const suffix = `${state === 'expanded' ? 'expanded-' : ''}${width}-${theme}`;
          const actual = await native.screenshot({
            animations: 'disabled',
            path: join(artifacts, `native-${suffix}.png`),
          });
          const expected = await old.screenshot({
            animations: 'disabled',
            path: join(artifacts, `base3x-${suffix}.png`),
          });
          const comparison = {
            width,
            theme,
            state,
            geometryDifferences: sidebarVisualDifferences(previous, current),
            pixels: compareSidebarPixels(expected, actual),
          };
          comparisons.push(comparison);
          // Preserve all four screens before the final zero-pixel assertion.
          await appendFile(
            join(artifacts, 'sidebar-visual-comparison.jsonl'),
            `${JSON.stringify(comparison)}\n`,
          );
          return { current, previous };
        };
        const { current, previous } = await capturePair('preview');
        await page.screenshot({
          animations: 'disabled',
          path: join(artifacts, `native-page-${width}-${theme}.png`),
          fullPage: true,
        });
        await legacy.screenshot({
          animations: 'disabled',
          path: join(artifacts, `base3x-page-${width}-${theme}.png`),
          fullPage: true,
        });
        const guards = {
          width,
          theme,
          nativeAnchor: {
            actual: current.frame!.rect.width,
            budget: current.anchorBudget,
          },
          legacyAnchor: {
            actual: previous.frame!.rect.width,
            budget: previous.anchorBudget,
          },
          desktopAnchorDifference: current.compact
            ? null
            : Math.abs(previous.frame!.rect.width - frameBox!.width),
          visibleRootDifference: Math.abs(
            previous.root!.rect.width - box!.width,
          ),
        };
        // Capture both pages and their CSS budgets before any geometry guard.
        // Soft assertions still fail this test, but preserve all eight pairs.
        await appendFile(
          join(artifacts, 'sidebar-width-guards.jsonl'),
          `${JSON.stringify(guards)}\n`,
        );
        expect
          .soft(
            Math.abs(
              guards.nativeAnchor.actual - guards.nativeAnchor.budget.width,
            ),
          )
          .toBeLessThanOrEqual(0.5);
        expect
          .soft(
            Math.abs(
              guards.legacyAnchor.actual - guards.legacyAnchor.budget.width,
            ),
          )
          .toBeLessThanOrEqual(0.5);
        if (guards.desktopAnchorDifference !== null)
          expect.soft(guards.desktopAnchorDifference).toBeLessThanOrEqual(0.5);
        expect.soft(guards.visibleRootDifference).toBeLessThanOrEqual(0.5);
        await page.evaluate(
          (size) => window.__allriceSidebarTest!.baseline(true, size),
          frameBox!.width,
        );
        const baseline = page.locator('[data-sidebar-baseline] #chat-sidebar');
        await baseline.waitFor();
        await appendFile(
          join(artifacts, 'sidebar-geometry.jsonl'),
          `${JSON.stringify({
            width,
            theme,
            phase: 'shared-frame',
            measuredNative: { frame: frameBox, root: box },
            supplementary: await sidebarGeometry(
              page,
              '[data-sidebar-baseline] #chat-sidebar',
            ),
          })}\n`,
        );
        expect
          .soft(
            Math.abs((await baseline.boundingBox())!.width - frameBox!.width),
          )
          .toBeLessThanOrEqual(0.5);
        expect
          .soft(
            Math.abs(
              (await baseline.locator(':scope > div').last().boundingBox())!
                .width - box!.width,
            ),
          )
          .toBeLessThanOrEqual(0.5);
        await baseline.screenshot({
          animations: 'disabled',
          path: join(artifacts, `shared-frame-baseline-${width}-${theme}.png`),
        });
        await page.evaluate(() => window.__allriceSidebarTest!.baseline(false));
        await page
          .locator('#chat-sidebar')
          .getByRole('button', { name: /^展开其余/ })
          .first()
          .click();
        await legacy
          .locator('#chat-sidebar')
          .getByRole('button', { name: /^展开其余/ })
          .first()
          .click();
        await settle(page);
        await settle(legacy);
        expect
          .soft(await page.locator('[data-row-key^="session:"]').count())
          .toBeGreaterThan(30);
        expect
          .soft(await legacy.locator('[data-row-key^="session:"]').count())
          .toBeGreaterThan(30);
        await capturePair('expanded');
        await page
          .getByRole('button', { name: '收起更多会话', exact: true })
          .first()
          .click();
        if (width === 390) {
          const dialog = page.getByRole('dialog', {
            name: '任务与历史',
            exact: true,
          });
          await dialog
            .getByRole('button', { name: '设置', exact: true })
            .focus();
          await page.keyboard.press('Tab');
          expect
            .soft(
              await page
                .getByRole('button', { name: '收起侧边栏', exact: true })
                .evaluate((node) => node === document.activeElement),
            )
            .toBe(true);
          await page.keyboard.press('Escape');
          expect
            .soft(
              await page
                .getByRole('dialog', { name: '任务与历史', exact: true })
                .count(),
            )
            .toBe(0);
        }
      }
    await writeFile(
      join(artifacts, 'sidebar-visual-comparison.json'),
      JSON.stringify(
        {
          geometryToleranceCssPx: 0.5,
          pixelTolerance: 0,
          excludedPixels: 0,
          comparisons,
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(artifacts, 'capture-context.json'),
      JSON.stringify(
        {
          candidate: execFileSync('git', ['rev-parse', 'HEAD'], {
            encoding: 'utf8',
          }).trim(),
          browser: browser.version(),
          platform: process.platform,
          dpr: 1,
          fixedTime: '2026-11-21T12:00:00.000Z',
          reducedMotion: 'reduce',
          timezone: 'UTC',
          animationSampling:
            'Fonts ready; actual pointer moved outside both sidebars and active elements blurred; two animation frames settle; screenshot animations disabled',
          pixelComparison:
            'Exact decoded RGBA; zero threshold, no masks or antialias exclusions. All four screens and expanded states must match.',
          widths: [1440, 390],
          themes: ['light', 'dark'],
          baseline: `Actual pre-extraction ChatSidebar/EmployeeSidebar/SidebarSettings sources and layout CSS from ${sidebarBaselineHead}; same deterministic sidebar-data.mjs and measured width. Shared-frame image is supplementary current-head container comparison only.`,
          errors,
          legacyRequests,
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(artifacts, 'comparison.html'),
      `<!doctype html><meta charset="utf-8"><title>MET-276 真实侧栏对照</title>
<style>body{font:16px system-ui;margin:24px;background:#f3f4f6;color:#111}main{display:flex;gap:24px;align-items:flex-start}img{max-width:100%;border:1px solid #bbb}section{min-width:0}p{max-width:900px}select{font:inherit;margin:12px}</style>
<h1>MET-276 真实 AllRice Frame/View → 原生 sidebar</h1>
<p>待主线逐屏复核。两侧使用同一 sidebar-data.mjs 合成数据、固定时间、DPR1、减少动态效果、相同鼠标/焦点状态和实测相同宽度。左侧真实旧 ChatSidebar 及 main.frame/shell 从固定 base ${sidebarBaselineHead} 编译，源码哈希保存在 legacy-base-sources.json。逐项几何差异与零阈值像素结果见 <a href="sidebar-visual-comparison.json">对比记录</a>；非零差异不豁免。正式 SSO、同 origin 员工草稿隔离、跨根附件/scroll 仍未接通。</p>
<label>画布<select id="width"><option>1440</option><option>390</option></select></label><label>主题<select id="theme"><option>light</option><option>dark</option></select></label>
<label>列表<select id="expanded"><option value="">预览</option><option value="expanded-">展开其余</option></select></label>
<main><section><h2>固定 base 的真实 3.x 入口</h2><img id="before"></section><section><h2>原生 sidebar 内实现</h2><img id="after"></section></main>
<p><a href="capture-context.json">浏览器与源码记录</a> · <a href="native-storage-boundary.json">同 origin 同 ID 负向原件</a> · <a href="native-reading-anchor.json">同根阅读位置记录</a></p>
<script>const w=document.getElementById('width'),t=document.getElementById('theme'),e=document.getElementById('expanded');function show(){document.getElementById('before').src='base3x-'+e.value+w.value+'-'+t.value+'.png';document.getElementById('after').src='native-'+e.value+w.value+'-'+t.value+'.png'}w.onchange=t.onchange=e.onchange=show;show();</script>`,
    );
    expect(errors).toEqual([]);
    expect(legacyRequests).toEqual([]);
    expect(comparisons).toHaveLength(8);
    expect(
      comparisons.filter(
        ({ geometryDifferences, pixels }) =>
          geometryDifferences.length ||
          !pixels.dimensionsMatch ||
          pixels.changedPixels !== 0,
      ),
    ).toEqual([]);
  }, 60_000);
});
