import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { nativeClientModule } from './native-client-module.mjs';

const require = createRequire(import.meta.url);
const { registerChildPane, childTaskTitle } = require('../src/child-pane.cjs');
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
});
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const catalogName = 'conversation.session.header.actions';

it('reuses the native catalog, opens both gestures aside and releases replacements on unload/redeclaration', async () => {
  const ctx = new Context();
  contexts.push(ctx);
  const { SlotRegistry } = nativeClientModule(
    '@deepseek-ai/dsh-client-ui-renderer',
  );
  new SlotRegistry(ctx);
  const openResource = vi.fn();
  ctx.provide('sidebarRight', { openResource });
  const plugin = ctx.plugin({
    apply: (scope: Context) => registerChildPane(scope, React),
  });
  await plugin;
  const declare = () =>
    ctx.slots.register(
      {
        name: 'root',
        children: {
          [catalogName]: { kind: 'list', scope: 'session' },
          'conversation.composer': { kind: 'chain', scope: 'session' },
          'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
        },
      },
      () => null,
    );
  let removeDeclaration = declare();
  await settle(); // declaration exists before the upstream plugin is registered
  const component = () => 'native';
  const refreshProjection = vi.fn();
  const mainOpen = vi.fn();
  const registerNative = () =>
    ctx.slots.register(
      {
        name: catalogName,
        id: 'subagent-catalog',
        locale: 'subagent',
        order: 10,
        inject: () => ({
          openChild: mainOpen,
          openChildAside: mainOpen,
          refreshProjection,
        }),
      },
      component,
    );
  let removeNative = registerNative();
  await settle();
  const check = () => {
    const entries = ctx.slots.entriesOfSlot(catalogName);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.component).toBe(component);
    expect(entry.locale).toBe('subagent');
    expect(entry.options.order).toBe(10);
    const actions = Reflect.apply(entry.inject!, undefined, ['parent']);
    expect(actions.refreshProjection).toBe(refreshProjection);
    for (const mode of ['one-shot', 'continuable', 'unknown']) {
      const address = {
        childSessionId: 'child/with space',
        parentSessionId: 'parent&1',
        mode,
      };
      actions.openChild(address);
      actions.openChildAside(address);
      const [url, options] = openResource.mock.calls.at(-1)!;
      expect(new URL(url).searchParams.get('parent')).toBe('parent&1');
      expect(new URL(url).searchParams.get('mode')).toBe(mode);
      expect(url).toContain('child%2Fwith%20space');
      expect(options).toEqual({ kind: 'subagentchat', preferNewPane: false });
    }
    expect(mainOpen).not.toHaveBeenCalled();
  };
  check();
  removeNative();
  await settle();
  expect(ctx.slots.entriesOfSlot(catalogName)).toHaveLength(0);
  removeNative = registerNative();
  await settle();
  check();
  removeDeclaration();
  await settle();
  removeDeclaration = declare();
  removeNative = registerNative();
  await settle();
  check();
  await plugin.dispose();
  await settle();
  expect(ctx.slots.entries(catalogName)).toHaveLength(1);
  expect(ctx.slots.entriesOfSlot(catalogName)[0]?.component).toBe(component);
  expect(ctx.slots.entries('conversation.composer')).toHaveLength(0);
  expect(ctx.slots.entries('sidebar.right.pane.tab.title')).toHaveLength(0);
  removeNative();
  removeDeclaration();
});

it('denies the composer for every child mode, including running continuable, but leaves root input unchanged', async () => {
  const ctx = new Context();
  contexts.push(ctx);
  const { SlotRegistry } = nativeClientModule(
    '@deepseek-ai/dsh-client-ui-renderer',
  );
  new SlotRegistry(ctx);
  ctx.slots.register(
    {
      name: 'root',
      children: {
        'conversation.composer': { kind: 'chain', scope: 'session' },
      },
    },
    () => null,
  );
  await ctx.plugin({
    apply: (scope: Context) => registerChildPane(scope, React),
  });
  const entry = ctx.slots.entries('conversation.composer')[0]!;
  const select = (owner: unknown) =>
    Reflect.apply(entry.select!, undefined, [owner]);
  expect(select({ session: {} })).toBeNull();
  expect(select({ session: null })).toBeNull();
  for (const mode of ['one-shot', 'continuable', 'unknown'])
    for (const running of [false, true])
      expect(
        select({
          session: {
            running,
            subagent: { address: { mode }, parentAvailable: true },
          },
        }),
      ).toEqual({ readOnly: true });
  const rendered = entry.component({});
  expect(rendered.type).toBe('div');
  expect(rendered.props.children).toBe('只读会话 · 由主员工安排后续工作');
});

it('uses live descriptor/catalog/task titles, with no internal id or malformed-address leakage', () => {
  const address =
    'dsh-resource://subagentchat/session/child?parent=parent&mode=continuable';
  const snapshot = { byId: {}, projectionsBySession: {} };
  expect(childTaskTitle(address, snapshot)).toBe('子智能体');
  const updated = {
    byId: {
      child: {
        title: '任务摘要',
        projectionValues: { subagent: { label: '实时任务名' } },
      },
    },
    projectionsBySession: {
      parent: {
        values: { subagentCatalog: [{ id: 'child', label: '目录任务名' }] },
      },
    },
  };
  expect(childTaskTitle(address, updated)).toBe('实时任务名');
  updated.byId.child.projectionValues.subagent.label = '';
  expect(childTaskTitle(address, updated)).toBe('目录任务名');
  updated.projectionsBySession.parent.values.subagentCatalog = [];
  expect(childTaskTitle(address, updated)).toBe('任务摘要');
  for (const bad of [
    'broken',
    'dsh-resource://file/session/child',
    'dsh-resource://subagentchat/session/%E0',
  ])
    expect(childTaskTitle(bad, updated)).toBe('子智能体');
});
