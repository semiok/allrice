import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import {
  composeEntries,
  loadProfileDirectory,
} from '@deepseek-ai/dsh-app-boot';
import { afterEach, expect, it } from 'vitest';
import { nativeClientModule } from './native-client-module.mjs';
import {
  prepareNativeHistory,
  processSession,
  documentSession,
} from './native-history.mjs';

const require = createRequire(import.meta.url);
const product = require('../src/client.cjs');
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const contexts: Context[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it('shades only named employee controls and restores native occupants on unload/redeclaration', async () => {
  const ctx = new Context();
  contexts.push(ctx);
  const { SlotRegistry } = nativeClientModule(
    '@deepseek-ai/dsh-client-ui-renderer',
  );
  new SlotRegistry(ctx);
  const layers = new Map();
  ctx.provide('theme', {
    overrideTokens: (source: string, tokens: unknown) => {
      layers.set(source, tokens);
      return () => {
        layers.delete(source);
      };
    },
  });
  const plugin = ctx.plugin(product);
  await plugin;
  const native = () => 'native';
  const declare = () =>
    ctx.slots.register(
      {
        name: 'root',
        children: {
          'conversation.input.permission': { kind: 'single', scope: 'session' },
          'conversation.input.model': { kind: 'single', scope: 'session' },
          'conversation.session.header.utilities': {
            kind: 'list',
            scope: 'session',
          },
          'conversation.composer.dock': { kind: 'list', scope: 'session' },
          'conversation.input.activity': { kind: 'single', scope: 'session' },
        },
      },
      native,
    );
  let remove = declare();
  const addDefaults = () => {
    for (const name of [
      'conversation.input.permission',
      'conversation.input.model',
      'conversation.input.activity',
    ] as const) {
      ctx.slots.register({ name }, native);
    }
    for (const id of ['activity', 'usage', 'queue'])
      ctx.slots.register({ name: 'conversation.composer.dock', id }, native);
    for (const id of ['session-log-download', 'other-utility'])
      ctx.slots.register(
        { name: 'conversation.session.header.utilities', id },
        native,
      );
  };
  addDefaults();
  const shaded = () => {
    for (const name of [
      'conversation.input.permission',
      'conversation.input.model',
    ] as const) {
      expect(ctx.slots.entriesOfSlot(name)[0]?.component()).toBeNull();
      expect(ctx.slots.entries(name)).toHaveLength(2);
    }
    expect(
      ctx.slots
        .entriesOfSlot('conversation.composer.dock')
        .filter((entry) => entry.component === native)
        .map((entry) => entry.options.id),
    ).toEqual(['queue']);
    expect(
      ctx.slots
        .entriesOfSlot('conversation.session.header.utilities')
        .filter((entry) => entry.component === native)
        .map((entry) => entry.options.id),
    ).toEqual(['other-utility']);
    expect(
      ctx.slots.entriesOfSlot('conversation.input.activity')[0]?.component,
    ).toBe(native);
  };
  shaded();
  remove();
  remove = declare();
  addDefaults();
  shaded();
  expect(layers.size).toBe(1);
  await plugin.dispose();
  expect(layers.size).toBe(0);
  expect(
    ctx.slots.entriesOfSlot('conversation.input.model')[0]?.component,
  ).toBe(native);
  expect(
    ctx.slots
      .entriesOfSlot('conversation.composer.dock')
      .every((entry) => entry.component === native),
  ).toBe(true);
  remove();
});

it('assembles the independent profile with native question/document/catalog and Host log export intact', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-composition-profile-')),
  );
  roots.push(root);
  const profileDir = join(root, 'allrice-web');
  await mkdir(join(profileDir, 'node_modules/@allrice'), { recursive: true });
  await writeFile(
    join(profileDir, 'package.json'),
    await readFile(
      new URL('../profiles/allrice-web/package.json', import.meta.url),
    ),
  );
  await symlink(
    packageRoot,
    join(profileDir, 'node_modules/@allrice/dsh-web-composition'),
    'dir',
  );
  const profile = loadProfileDirectory(
    'test',
    profileDir,
    require.resolve('@deepseek-ai/dsh/package.json'),
  );
  expect(profile.skippedBundles).toEqual([]);
  const warnings: string[] = [];
  const entries = composeEntries(
    profile.layers.map((layer) => layer.patches),
    (warning) => warnings.push(warning),
  );
  expect(warnings).toEqual([]);
  const entry = (id: string) => entries.find((row) => row.id === id);
  for (const id of ['ui-trajectory', 'open-in-app', 'ui-open-in-app'])
    expect(entry(id)?.disabled).toBe(true);
  for (const id of [
    'ui-user-questions',
    'ui-sidebar-documentpreview',
    'ui-subagent',
    'session-log-download',
    'ui-deliverables',
    'ui-conversation',
    'ui-sidebar-right',
  ]) {
    expect(entry(id), id).toBeDefined();
    expect(entry(id)?.disabled, id).not.toBe(true);
  }
  expect(entry('locale')?.config).toMatchObject({ preference: 'zh' });
  expect(entry('ui-chat')?.config).toMatchObject({
    performanceUsage: 'compact',
  });
  expect(entry('allrice-web-composition')?.name).toBe(
    '@allrice/dsh-web-composition',
  );
  expect(entry('typert-loader')?.config).toMatchObject({
    packages: ['@deepseek-ai/dsh-client-ui-plugin-manager'],
  });
});

it('retains native manager Host behavior through public Host-only entry exports', async () => {
  const ctx = new Context();
  contexts.push(ctx);
  const configurations: object[] = [];
  let released = 0;
  ctx.provide('settings', {
    configure(config: object) {
      configurations.push(config);
      return () => {
        released++;
      };
    },
  });
  const hosts = [];
  for (const name of [
    'plugin-manager',
    'settings-models',
    'settings-account',
  ]) {
    const entry = '@allrice/dsh-web-composition/host/' + name;
    const module = await import(entry);
    const native = await import('@deepseek-ai/dsh-client-ui-' + name);
    expect(module.default ?? module.apply).toBe(native.default ?? native.apply);
    expect((module.default ?? module).Config).toBe(
      (native.default ?? native).Config,
    );
    // Cordis Loader unwraps a module's default export before plugin mounting.
    hosts.push(ctx.plugin(module.default ?? module));
  }
  await Promise.all(hosts);
  expect(typeof ctx.get('pluginRegistryProbe')?.fastest).toBe('function');
  const injected: { kind: string; name: string; value: unknown }[] = [];
  ctx.emit('webserver/index-inject', injected);
  expect(injected).toEqual(
    expect.arrayContaining([
      {
        kind: 'global',
        name: '__DSH_MODELS_ONBOARDING__',
        value: { credentialOnboarding: true },
      },
      {
        kind: 'global',
        name: '__DSH_CONTACT_CONFIG__',
        value: expect.objectContaining({
          contactSource: '',
          bonusAckRetryDelayMs: 1000,
          bonusAckRetryMaxDelayMs: 60_000,
        }),
      },
    ]),
  );
  expect(configurations).toEqual([{ auto: false }]);
  await Promise.all(hosts.map((host) => host.dispose()));
  expect(ctx.get('pluginRegistryProbe')).toBeUndefined();
  expect(released).toBe(1);
  const afterDispose: typeof injected = [];
  ctx.emit('webserver/index-inject', afterDispose);
  expect(afterDispose).toEqual([]);
});

it('reopens portable native process/question/document histories through released persistence', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-composition-history-')),
  );
  roots.push(root);
  const hostRequire = createRequire(
    require.resolve('@deepseek-ai/dsh/package.json'),
  );
  const prepared = await prepareNativeHistory(hostRequire, root);
  expect(prepared.counts[processSession]).toBe(26);
  expect(prepared.counts[documentSession]).toBe(21);
  expect(
    await readFile(
      join(prepared.workspace, '核对说明-长文件名用于验证原生交付文档预览.md'),
      'utf8',
    ),
  ).toContain('56.30 元');
});
