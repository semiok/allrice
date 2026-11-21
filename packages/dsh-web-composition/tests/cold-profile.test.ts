import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import * as Cordis from '@deepseek-ai/cordis';
import {
  composeEntries,
  loadProfileDirectory,
} from '@deepseek-ai/dsh-app-boot';
import * as Slots from '@deepseek-ai/dsh-client-ui-slots';
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives';
import type * as ClientModules from '@deepseek-ai/dsh-client-modules/client';
import type * as SettingsGeneral from '@deepseek-ai/dsh-client-ui-settings-general/client';
import type * as Schedule from '@deepseek-ai/dsh-client-ui-schedule/client';
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/client';
import type { SettingsLauncherOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client';
import * as React from 'react';
import * as ReactDom from 'react-dom';
import * as ReactDomClient from 'react-dom/client';
import * as Jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { EmployeeSidebarPort } from '../src/employee-sidebar';
import type { EmployeeSettingsPort } from '../src/employee-settings-port';
import { createSettingsHost } from './fixtures/employee-settings/host';

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const hostRequire = createRequire(
  require.resolve('@deepseek-ai/dsh/package.json'),
);
const Store = createRequire(
  require.resolve('@deepseek-ai/dsh-client-ui-primitives/package.json'),
)('@deepseek-ai/dsh-client-store');
const seed = {
  react: React,
  'react-dom': ReactDom,
  'react-dom/client': ReactDomClient,
  'react/jsx-runtime': Jsx,
  '@deepseek-ai/cordis': Cordis,
  '@deepseek-ai/dsh-client-ui-slots': Slots,
  '@deepseek-ai/dsh-client-ui-primitives': Primitives,
  '@deepseek-ai/dsh-client-store': Store,
  zod: require('zod'),
};
const roots: string[] = [],
  contexts: Cordis.Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** Released public ./client artifacts, registered through their real facade. */
function registration(file: string, extra: object = {}) {
  let result:
    | {
        id: string;
        factory: (require: (id: string) => unknown) => Record<string, unknown>;
      }
    | undefined;
  runInNewContext(
    readFileSync(file, 'utf8'),
    {
      window: {
        __ModuleLoader__: {
          load: (value: typeof result) => {
            result = value;
          },
        },
      },
      queueMicrotask,
      setTimeout,
      clearTimeout,
      AbortController,
      AbortSignal,
      URL,
      crypto: globalThis.crypto,
      ...extra,
    },
    { filename: file },
  );
  if (!result) throw new Error('Missing public module registration: ' + file);
  return result;
}

async function coldProfile() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-cold-profile-')),
  );
  roots.push(root);
  await mkdir(join(root, 'node_modules/@allrice'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    await readFile(
      new URL('../profiles/allrice-web/package.json', import.meta.url),
    ),
  );
  await symlink(
    packageRoot,
    join(root, 'node_modules/@allrice/dsh-web-composition'),
    'dir',
  );
  const profile = loadProfileDirectory(
    'allrice-web',
    root,
    hostRequire.resolve('@deepseek-ai/dsh/package.json'),
  );
  expect(profile.skippedBundles).toEqual([]);
  const warnings: string[] = [];
  const entries = composeEntries(
    profile.layers.map((layer) => layer.patches),
    (warning) => warnings.push(warning),
  );
  expect(warnings).toEqual([]);
  const modulesId = '@deepseek-ai/dsh-client-modules';
  const bootstrap = registration(require.resolve(modulesId + '/client'));
  const modules = bootstrap.factory((id) => {
    if (!(id in seed)) throw new Error('Unexpected bootstrap external: ' + id);
    return seed[id as keyof typeof seed];
  }) as typeof ClientModules;
  const localRequire = createRequire(join(root, 'package.json'));
  const artifacts = new Map<string, string>();
  const graphEntries = [];
  for (const row of entries) {
    if (row.disabled === true || !row.name) continue;
    // Reuse the released Host scanner's public bare-package boundary. Plugin
    // subpaths are not independent client module graph entries.
    const name = modules.exactPackageSpecifier(row.name);
    if (!name) continue;
    const resolve = name.startsWith('@allrice/') ? localRequire : hostRequire;
    const manifestFile = resolve.resolve(name + '/package.json');
    const metadata = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const client = modules.parseDshClient(name, metadata.dsh?.client);
    if (client?.platform !== 'web') continue;
    // The native Host serves the declared ./client default. Node's `node`
    // condition instead selects the registry's distinct Node transport face.
    const exported = metadata.exports['./client'];
    const clientExport =
      typeof exported === 'string' ? exported : exported.default;
    expect(typeof clientExport, name).toBe('string');
    const file = fileURLToPath(
      new URL(clientExport, pathToFileURL(manifestFile)),
    );
    const rev = createHash('sha256').update(readFileSync(file)).digest('hex');
    const url = pathToFileURL(file).href + '?rev=' + rev;
    artifacts.set(url, file);
    graphEntries.push({
      id: metadata.name,
      url,
      rev,
      inject: client.inject ?? [],
      external: client.external ?? [],
    });
  }
  const graph = {
    rev: 'cold-profile-proof',
    entries: graphEntries,
    batches: graphEntries.map((row) => ({
      phase: 'application',
      url: row.url,
      rev: row.rev,
      entries: [row.id],
    })),
  };
  const arrived: string[] = [];
  const styles = new Set<{ textContent: string }>();
  // An explicit CSS-resource sink, not a DOM renderer or a native Client mount.
  const document = {
    createElement: (tag: string) => {
      expect(tag).toBe('style');
      const style = {
        dataset: {},
        textContent: '',
        remove: () => styles.delete(style),
      };
      return style;
    },
    head: { append: (style: { textContent: string }) => styles.add(style) },
  };
  const target = { mode: 'queue', pendingQueue: [] };
  const create = modules.createClientModuleSystem as (
    target: object,
    bootstrap: object,
    options: object,
  ) => {
    import: (name: string) => Promise<Record<string, unknown>>;
    entries: { releaseChange: unknown };
  };
  const system = create(
    target,
    { id: modulesId, exports: modules },
    {
      boot: graph,
      staticModules: seed,
      loadBundle: async (url: string) => {
        const file = artifacts.get(url);
        if (!file) throw new Error('Proof carrier has no artifact: ' + url);
        const entry = registration(
          file,
          file === fileURLToPath(new URL('../dist/client.js', import.meta.url))
            ? { document }
            : {},
        );
        arrived.push(entry.id);
        // The public create call replaces the queue facade with its live sink.
        (target as unknown as { load: (entry: object) => void }).load(entry);
      },
    },
  );
  return { entries, graph, system, arrived, styles };
}

it('composes the cold public profile and resolves actual General/layout/schedule module dependencies without ui-sidebar', async () => {
  const { entries, graph, system, arrived } = await coldProfile();
  expect(entries.find((row) => row.id === 'ui-sidebar')?.disabled).toBe(true);
  const ids = graph.entries.map((row) => row.id);
  expect(ids).not.toContain('@deepseek-ai/dsh-client-ui-sidebar');
  for (const name of ['ui-settings-general', 'ui-layout', 'ui-schedule']) {
    const id = '@deepseek-ai/dsh-client-' + name;
    expect(ids).toContain(id);
    expect(typeof (await system.import(id)).apply).toBe('function');
  }
  expect(arrived).not.toContain('@deepseek-ai/dsh-client-ui-sidebar');
  for (const id of [
    'ui-settings-models',
    'ui-settings-agent-loop',
    'ui-settings-plugins',
    'ui-settings-plugin-inventory',
    'ui-settings-shell',
    'ui-settings-subagent',
    'ui-settings-web-search',
    'ui-settings-account',
    'ui-plugin-manager',
  ]) {
    expect(entries.find((row) => row.id === id)?.disabled, id).toBe(true);
    expect(ids, id).not.toContain('@deepseek-ai/dsh-client-' + id);
  }
  for (const [id, host] of [
    ['allrice-settings-models-host', 'settings-models'],
    ['allrice-settings-account-host', 'settings-account'],
    ['allrice-plugin-manager-host', 'plugin-manager'],
  ]) {
    const entry = entries.find((row) => row.id === id);
    expect(entry?.disabled, id).not.toBe(true);
    expect(entry?.name, id).toBe('@allrice/dsh-web-composition/host/' + host);
    expect(ids, id).not.toContain('@allrice/dsh-web-composition/host/' + host);
  }
  for (const id of [
    'settings',
    'settings-controller',
    'account-controller',
    'schedule',
    'plugin-manager',
    'agent-loop',
    'subagent',
    'deepseek-account',
  ]) {
    expect(entries.find((row) => row.id === id)?.disabled, id).not.toBe(true);
    expect(
      entries.find((row) => row.id === id),
      id,
    ).toBeDefined();
  }
});

it('keeps one native settings shell and schedules while the real AllRice declaration unloads and rebuilds', async () => {
  const { system, styles } = await coldProfile();
  const allrice = (await system.import('@allrice/dsh-web-composition')) as {
    inject: string[];
    apply: (ctx: Cordis.Context) => void;
    bindEmployeeSidebar: (
      ctx: Cordis.Context,
      port: EmployeeSidebarPort,
    ) => void;
    bindEmployeeSettings: (
      ctx: Cordis.Context,
      port: EmployeeSettingsPort,
    ) => void;
  };
  const renderer = await system.import('@deepseek-ai/dsh-client-ui-renderer');
  const general = (await system.import(
    '@deepseek-ai/dsh-client-ui-settings-general',
  )) as typeof SettingsGeneral;
  const schedule = (await system.import(
    '@deepseek-ai/dsh-client-ui-schedule',
  )) as typeof Schedule;
  const nativeLayout = await system.import('@deepseek-ai/dsh-client-ui-layout');
  const ctx = new Cordis.Context();
  contexts.push(ctx);
  new (renderer.SlotRegistry as typeof SlotRegistry)(ctx);
  const constant = <T>(value: T) => ({
    getSnapshot: () => value,
    subscribe: () => () => {},
  });
  const commands = new Map<string, unknown>();
  const remote = {
    $host: { isLoopback: false },
    $on: () => () => {},
    schedule: {
      catalog: vi.fn(() => {
        throw new Error('No I/O in registration proof');
      }),
    },
  };
  const services = {
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
      getSnapshot: () => ({ revision: 0 }),
      subscribe: () => () => {},
    },
    connection: { state: constant('connected'), reconnect: vi.fn() },
    remote,
    'remote.settings': {},
    'remote.schedule': remote.schedule,
    configForms: {
      developerTools: { enabled: constant(false), setEnabled: vi.fn() },
    },
    shortcuts: {
      catalog: constant([]),
      register: (command: { id: string }) => {
        commands.set(command.id, command);
        return () => commands.delete(command.id);
      },
    },
    modules: system,
    conversation: {},
    uiConversation: { events: { register: vi.fn() } },
    uiWorkspace: { openSession: vi.fn(), startSession: vi.fn() },
    sessions: { list: constant({ phase: 'ready', sessions: [] }) },
    workspaces: { list: constant({ phase: 'ready', workspaces: [] }) },
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { tabsIn: () => [], openTab: vi.fn() },
    theme: { overrideTokens: () => () => {} },
  };
  for (const [name, value] of Object.entries(services))
    ctx.provide(name as never, value);
  const panels = Store.createSnapshotStore({
    activePanelId: null as string | null,
  });
  const layout = new (nativeLayout.LayoutController as typeof LayoutController)(
    {
      selectPanel: (id: string | null) => panels.set({ activePanelId: id }),
      toggleSidebar: vi.fn(),
      openRightbar: vi.fn(),
      closeRightbar: vi.fn(),
    } as never,
    (id) => ctx.slots.entries('main').some((entry) => entry.options.key === id),
    panels,
  );
  ctx.provide('layout', layout);
  // Native Layout's public slot contract, without executing its DOM presenter.
  const declareLayout = () =>
    ctx.slots.register(
      {
        name: 'root',
        children: {
          sidebar: { kind: 'single', scope: 'root' },
          main: { kind: 'keyed', scope: 'root' },
          'shell.overlay': { kind: 'list', scope: 'root' },
        },
      },
      ({ renderSlot }) =>
        renderSlot('sidebar', { collapsed: false, width: 280 }),
    );
  let removeLayout = declareLayout();
  allrice.bindEmployeeSidebar(ctx, {
    getSnapshot: () => {
      throw new Error('Registration proof does not render a fake employee UI');
    },
    subscribe: () => () => {},
    createEmployee: vi.fn(),
    openArchive: vi.fn(),
    openEmployeeSettings: vi.fn(),
  });
  const owner = createSettingsHost();
  allrice.bindEmployeeSettings(ctx, owner.port);
  const nativeGeneral = ctx.plugin(general);
  await nativeGeneral;
  const nativeSchedule = ctx.plugin(schedule);
  await nativeSchedule;
  const sidebar = ctx.plugin(allrice);
  await sidebar;
  const shell = () => ctx.slots.entriesOfSlot('sidebar.settings')[0]!;
  const assertLive = () => {
    expect(styles.size).toBe(1);
    expect(ctx.slots.entries('sidebar')).toHaveLength(1);
    expect(ctx.slots.entries('sidebar')[0]?.children).toEqual({
      'sidebar.settings': { kind: 'single', scope: 'root' },
    });
    expect(ctx.slots.entries('sidebar.settings')).toHaveLength(1);
    expect(typeof shell().component).toBe('function');
    expect(commands.has('settings.open')).toBe(true);
    expect(
      ctx.slots
        .entriesOfSlot('settings.section')
        .map((entry) => entry.options.id),
    ).toEqual(
      expect.arrayContaining([
        'general',
        'allrice-account',
        'allrice-computer',
        'allrice-work',
        'allrice-apps',
      ]),
    );
    expect(
      ctx.slots
        .entries('settings.general.item')
        .some((entry) => entry.options.id === 'allrice-notifications'),
    ).toBe(false);
    expect(
      ctx.slots.entries('main').map((entry) => entry.options.key),
    ).toContain('schedules');
    layout.selectPanel('schedules' as never);
    expect(panels.getSnapshot().activePanelId).toBe('schedules');
    expect(remote.schedule.catalog).not.toHaveBeenCalled();
  };
  assertLive();
  expect(() =>
    ctx.slots.register(
      {
        name: 'sidebar',
        priority: 0,
        children: { 'sidebar.settings': { kind: 'single', scope: 'root' } },
      },
      ({ renderSlot }) => renderSlot('sidebar.settings', { wide: true }),
    ),
  ).toThrow('already declared');
  const firstShell = shell();
  await sidebar.dispose();
  expect(styles.size).toBe(0);
  expect(ctx.slots.spec('sidebar.settings')).toBeUndefined();
  expect(ctx.slots.spec('settings.section')).toBeUndefined();
  expect(commands.has('settings.open')).toBe(false);
  const next = ctx.plugin(allrice);
  await next;
  assertLive();
  expect(shell()).not.toBe(firstShell);
  removeLayout();
  expect(ctx.slots.spec('sidebar.settings')).toBeUndefined();
  removeLayout = declareLayout();
  assertLive();
  await nativeSchedule.dispose();
  expect(() => layout.selectPanel('schedules' as never)).toThrow(
    'not registered',
  );
  // Static owner-props check only: it does not exercise effects, the modal or
  // an authenticated owner. It must fail while Workflow's renderer seam is absent.
  const launcher = ctx.slots.entriesOfSlot('settings.launcher')[0]!;
  const html = renderToStaticMarkup(
    React.createElement(
      launcher.component as React.ComponentType<SettingsLauncherOwnerProps>,
      {
        wide: true,
        settingsOpen: false,
        openSettings: vi.fn(),
        openOnboarding: vi.fn(),
      },
    ),
  );
  expect(
    html,
    'The composition must install the real AllRice launcher, not a null row',
  ).toContain('aria-label="设置"');
  expect(html.startsWith('<button ')).toBe(true);
  removeLayout();
});
