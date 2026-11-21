import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as ReactDom from 'react-dom';
import * as Jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import type { ChatSidebarFrame } from '../../../apps/web/app/chatflow/chat-sidebar-frame';
import {
  SidebarSettingsButton,
  SidebarSettingsTrigger,
} from '../../../apps/web/app/chatflow/sidebar-settings-trigger';
import styles from '../../../apps/web/app/chatflow/dsh-upstream/settings/SettingsRoot.module.css';

const require = createRequire(import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);

it('publishes a resolvable settings port contract without requiring app source files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'allrice-public-settings-'));
  try {
    const installed = join(root, 'node_modules/@allrice/dsh-web-composition');
    await mkdir(join(installed, 'src'), { recursive: true });
    await writeFile(join(installed, 'package.json'), JSON.stringify(manifest));
    const declared = manifest.exports['./settings-types'].types;
    expect(manifest.files).toContain(declared.replace(/^\.\//, ''));
    await writeFile(
      join(installed, declared),
      await readFile(new URL('../' + declared, import.meta.url)),
    );
    for (const name of [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-settings',
      '@types/react',
    ]) {
      const target = join(root, 'node_modules', name);
      await mkdir(dirname(target), { recursive: true });
      await symlink(
        dirname(require.resolve(name + '/package.json')),
        target,
        'dir',
      );
    }
    const file = join(root, 'consumer.ts');
    await writeFile(
      file,
      `import type { EmployeeSettingsPort, EmployeeSettingsScope, EmployeeSettingsOptions } from '@allrice/dsh-web-composition/settings-types';
export function use(port: EmployeeSettingsPort, scope: EmployeeSettingsScope) {
  port.setStreamingOutput(scope, true);
  // @ts-expect-error This UI port must not expose a native transport or credentials.
  port.transport;
}
export const options: EmployeeSettingsOptions = { notifications: false };
`,
    );
    const program = ts.createProgram([file], {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      types: [],
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    });
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        ),
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('exports the settings binder from the built module-table artifact and shares native atoms', async () => {
  let factory:
    | ((require: (name: string) => unknown) => Record<string, unknown>)
    | undefined;
  const artifact = await readFile(
    new URL('../dist/client.js', import.meta.url),
    'utf8',
  );
  expect(artifact).not.toContain('__allriceSettingsIntegration');
  expect(manifest.files.some((file: string) => file.startsWith('tests'))).toBe(
    false,
  );
  runInNewContext(artifact, {
    AbortController,
    document: {
      // Browser markdown's detached entity-decoder probe, never used to render
      // or decode in this module-export proof. Unknown DOM access still fails.
      createElement: (tag: string) => {
        expect(tag).toBe('i');
        return { innerHTML: '', textContent: '' };
      },
    },
    window: {
      __ModuleLoader__: {
        load(entry: { factory: typeof factory }) {
          factory = entry.factory;
        },
      },
    },
  });
  const baseline = {
    react: React,
    'react-dom': ReactDom,
    'react/jsx-runtime': Jsx,
    '@deepseek-ai/dsh-client-ui-primitives': Primitives,
    zod: require('zod'),
  };
  const requested: string[] = [];
  const exports = factory!((name) => {
    requested.push(name);
    if (!(name in baseline))
      throw new Error('Unpublished client external: ' + name);
    return baseline[name as keyof typeof baseline];
  });
  for (const name of [
    'apply',
    'bindEmployeeSidebar',
    'bindEmployeeSettings',
    'bindEmployeePanels',
  ])
    expect(typeof exports[name], name).toBe('function');
  expect(requested).toContain('@deepseek-ai/dsh-client-ui-primitives');
  const ctx = { provide: vi.fn() },
    port = {};
  (exports.bindEmployeeSettings as (ctx: object, port: object) => void)(
    ctx,
    port,
  );
  expect(ctx.provide).toHaveBeenCalledExactlyOnceWith(
    'allriceEmployeeSettings',
    port,
  );
  let install: { apply: (ctx: object) => void } | undefined;
  const fork = {},
    disposers: (() => void)[] = [];
  const owner = {
    provide: vi.fn(),
    effect: (effect: () => () => void) => disposers.push(effect()),
  };
  const scope = {
    plugin: (plugin: typeof install) => {
      install = plugin;
      return fork;
    },
  };
  expect(
    (exports.bindEmployeePanels as (ctx: object, port: object) => object)(
      scope,
      port,
    ),
  ).toBe(fork);
  install!.apply(owner);
  expect(owner.provide).toHaveBeenCalledWith('allriceEmployeePanels', {
    port,
    signal: expect.any(AbortSignal),
  });
  const binding = owner.provide.mock.calls[0]![1] as { signal: AbortSignal };
  expect(binding.signal.aborted).toBe(false);
  for (const dispose of disposers) dispose();
  expect(binding.signal.aborted).toBe(true);
});

it('preserves the existing 3.x settings row and uses only its button inside a native row', () => {
  for (const collapsed of [false, true]) {
    const props = { collapsed, expanded: true, onOpen: vi.fn() };
    const button = renderToStaticMarkup(
      React.createElement(SidebarSettingsButton, props),
    );
    const row = renderToStaticMarkup(
      React.createElement(SidebarSettingsTrigger, props),
    );
    expect(row).toBe(
      `<div class="${styles.triggerRow} ${collapsed ? styles.railRow : ''}">${button}</div>`,
    );
    expect(button).toContain(
      'aria-label="设置" title="设置" aria-haspopup="dialog" aria-expanded="true"',
    );
    expect(button.startsWith('<button ')).toBe(true);
    expect(button).not.toContain('<div');
    expect(button.includes('>设置</span>')).toBe(!collapsed);
  }
});

it('keeps the installed sidebar frame free of panel action spacing and danger styling', async () => {
  type Style = {
    dataset: Record<string, string>;
    textContent: string;
    remove: () => void;
  };
  const sheets: Style[] = [];
  let factory:
    | ((require: (name: string) => unknown) => Record<string, unknown>)
    | undefined;
  runInNewContext(
    await readFile(new URL('../dist/client.js', import.meta.url), 'utf8'),
    {
      AbortController,
      document: {
        createElement: (tag: string) => {
          if (tag === 'style')
            return { dataset: {}, textContent: '', remove: vi.fn() };
          expect(tag).toBe('i');
          return { innerHTML: '', textContent: '' };
        },
        head: { append: (style: Style) => sheets.push(style) },
      },
      window: {
        __ModuleLoader__: {
          load: (entry: { factory: typeof factory }) => {
            factory = entry.factory;
          },
        },
      },
    },
  );
  const baseline = {
    react: React,
    'react-dom': ReactDom,
    'react/jsx-runtime': Jsx,
    '@deepseek-ai/dsh-client-ui-primitives': Primitives,
    zod: require('zod'),
  };
  const exports = factory!((name) => {
    if (!(name in baseline)) throw Error('Unpublished external: ' + name);
    return baseline[name as keyof typeof baseline];
  });
  const disposers: (() => void)[] = [];
  (exports.apply as (ctx: object) => void)({
    slots: { inject: vi.fn() },
    theme: { overrideTokens: () => () => {} },
    inject: vi.fn(),
    effect: (effect: () => () => void) => disposers.push(effect()),
  });
  expect(sheets).toHaveLength(1);
  const Frame = exports.ChatSidebarFrame as typeof ChatSidebarFrame;
  const markup = renderToStaticMarkup(
    React.createElement(Frame, {
      collapsed: false,
      employeeTree: 'synthetic tree',
      settings: 'synthetic settings',
      onCollapsedChange: vi.fn(),
      onCreateEmployee: vi.fn(),
    }),
  );
  const frameClasses = markup
    .match(/<aside[^>]*class="([^"]+)"/)![1]!
    .split(/\s+/)
    .filter(Boolean);
  const directRules = [
    ...sheets[0]!.textContent.matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ].filter((rule) =>
    rule[1]!
      .split(',')
      .some((selector) =>
        frameClasses.some((name) => selector.trim() === '.' + name),
      ),
  );
  expect(directRules.length).toBeGreaterThanOrEqual(frameClasses.length);
  // These declarations came from colliding panel actions in the first real
  // failure. The actual sidebar frame has no action padding/margins/font/color.
  for (const rule of directRules)
    expect(rule[2], rule[1]).not.toMatch(
      /(?:^|;)(?:padding(?:-[a-z-]+)?|margin(?:-[a-z-]+)?|color|font|font-size|line-height|cursor):/,
    );
  for (const dispose of disposers) dispose();
  expect(sheets[0]!.remove).toHaveBeenCalledOnce();
});
