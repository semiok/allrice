// Focused presentation/controller checks. Native installed browser coverage is
// in employee-topbar.browser.test.ts; these checks do not prove paint or focus.
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import {
  apply,
  bindEmployeePanels,
  EmployeePanelsEntries,
  EmployeePanelsGuide,
  EmployeePanelsHeader,
} from '../src/employee-panels';
import { apply as applyTopbar } from '../src/employee-topbar';
import type { nativeStartCorner } from '../src/employee-topbar';
import type { ExpandButtonProps } from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import {
  syntheticNavigation,
  syntheticPanelsOwner,
} from './fixtures/employee-panels/owner';
import { nativeClientModule } from './native-client-module.mjs';

const require = createRequire(import.meta.url);
const presentation = require('../src/client.cjs');
const child = require('../src/child-pane.cjs');
const contexts: Context[] = [];
const name = 'conversation.session.header.actions';
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
});

function setup() {
  const ctx = new Context();
  contexts.push(ctx);
  const { SlotRegistry } = nativeClientModule(
    '@deepseek-ai/dsh-client-ui-renderer',
  );
  new SlotRegistry(ctx);
  ctx.provide('theme', { overrideTokens: () => () => {} });
  const navigation = syntheticNavigation(ctx);
  ctx.slots.register(
    {
      name: 'root',
      children: {
        [name]: { kind: 'list', scope: 'session' },
        'conversation.composer': { kind: 'chain', scope: 'session' },
        'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
        'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
        'sidebar.right.tab.guide': { kind: 'chain', scope: 'session' },
        'conversation.session.header.corner': {
          kind: 'single',
          scope: 'session',
        },
      },
    },
    () => null,
  );
  return { ctx, ...navigation };
}

it('removes only the preset label while ordering after the final native read-only catalog action', async () => {
  const { ctx } = setup();
  const openResource = vi.fn();
  Object.assign(ctx.sidebarRight, { openResource });
  const component = () => React.createElement('button', null, '原生目录');
  const refreshProjection = vi.fn();
  ctx.slots.register(
    { name, id: 'agent-preset', order: -10 },
    () => '标准模式',
  );
  ctx.slots.register(
    {
      name,
      id: 'subagent-catalog',
      order: 10,
      locale: 'subagent',
      inject: () => ({
        refreshProjection,
        openChild: vi.fn(),
        openChildAside: vi.fn(),
      }),
    },
    component,
  );
  await ctx.plugin({
    apply: (scope: Context) => child.registerChildPane(scope, React),
  });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const catalog = ctx.slots
    .entriesOfSlot(name)
    .find((entry) => entry.options.id === 'subagent-catalog')!;
  await ctx.plugin(presentation);
  await ctx.plugin({ apply });
  await bindEmployeePanels(ctx, syntheticPanelsOwner().port);
  const entries = ctx.slots.entriesOfSlot(name);
  const preset = entries.find((entry) => entry.options.id === 'agent-preset')!;
  const panels = entries.find(
    (entry) => entry.options.id === 'allrice-employee-panels.header',
  )!;
  expect(preset.component()).toBeNull();
  expect(entries.find((entry) => entry.options.id === 'subagent-catalog')).toBe(
    catalog,
  );
  expect(panels.options.order).toBeGreaterThan(catalog.options.order!);
  expect(catalog.component).toBe(component);
  expect(catalog.locale).toBe('subagent');
  const actions = Reflect.apply(catalog.inject!, undefined, ['parent']);
  expect(actions.refreshProjection).toBe(refreshProjection);
  const address = {
    parentSessionId: 'parent',
    childSessionId: 'child',
    mode: 'continuable',
  };
  actions.openChild(address);
  actions.openChildAside(address);
  expect(openResource.mock.calls).toEqual([
    [
      'dsh-resource://subagentchat/session/child?parent=parent&mode=continuable',
      { kind: 'subagentchat', preferNewPane: false },
    ],
    [
      'dsh-resource://subagentchat/session/child?parent=parent&mode=continuable',
      { kind: 'subagentchat', preferNewPane: false },
    ],
  ]);
});

it('keeps all four launchers in materials-first order across closed/open/closed and opens the selected native page directly', () => {
  const { ctx, right } = setup();
  const owner = syntheticPanelsOwner();
  let expanded = false;
  right.isExpanded = () => expanded;
  const props = {
    ctx,
    binding: owner.binding,
    sessionId: owner.sessionId,
  } as Parameters<typeof EmployeePanelsHeader>[0];
  const labels = ['企业资料', '交付成果，2 项新增', '记忆', '能力'];
  for (const value of [false, true, false]) {
    expanded = value;
    const html = renderToStaticMarkup(
      React.createElement(EmployeePanelsHeader, props),
    );
    expect(
      [...html.matchAll(/<button\b[^>]*aria-label="([^"]+)"/g)].map(
        (match) => match[1],
      ),
    ).toEqual(labels);
    expect(html).not.toContain('展开工作台');
    const entries = EmployeePanelsEntries({
      ...props,
      snapshot: owner.snapshot(),
    })!;
    for (const kind of [
      'materials',
      'files',
      'experience',
      'workflow',
    ] as const)
      entries.props.onOpen(kind);
  }
  expect(vi.mocked(right.openTab).mock.calls.map((call) => call[0])).toEqual(
    Array.from({ length: 3 }, () => [
      'allrice-employee-panels.materials',
      'allrice-employee-panels.files',
      'allrice-employee-panels.experience',
      'allrice-employee-panels.workflow',
    ]).flat(),
  );
  expect(right.toggleExpanded).not.toHaveBeenCalled();
});

it('renders the four existing Start cards and descriptions and fails closed when the owner becomes unavailable', () => {
  const { ctx } = setup();
  const owner = syntheticPanelsOwner();
  const openTab = vi.fn();
  const props = {
    ctx,
    binding: owner.binding,
    sessionId: owner.sessionId,
    useTabInfo: () => ({
      tab: {
        visible: true,
        signal: owner.lifetime.signal,
        actions: { openTab },
      },
    }),
  } as unknown as Parameters<typeof EmployeePanelsGuide>[0];
  const render = () =>
    renderToStaticMarkup(React.createElement(EmployeePanelsGuide, props));
  const html = render();
  expect(
    [...html.matchAll(/<strong>(.*?)<\/strong>/g)].map((item) => item[1]),
  ).toEqual(['企业资料', '交付成果', '记忆', '能力']);
  for (const description of [
    '公司、部门和你自己可用的参考资料',
    '员工交付的文件和你在对话中上传的文件',
    '员工记住的你的偏好和工作习惯',
    '打开这位员工的业务工作台',
  ])
    expect(html).toContain(description);
  expect(html).not.toContain('新建终端');
  // Rendering above exercises hooks; assert the same owner fails closed once
  // invalidated rather than manufacturing an empty-success Start page.
  owner.publish(null);
  expect(render()).toBe('');
  expect(openTab).not.toHaveBeenCalled();
});

it('retains the native corner component/store/injection and routes the expand gesture to native Start', async () => {
  const { ctx, right } = setup();
  const storeRequire = createRequire(
    require.resolve('@deepseek-ai/dsh-client-ui-primitives/package.json'),
  );
  const { defineStore } = storeRequire('@deepseek-ai/dsh-client-store');
  const store = defineStore({ init: () => ({}), actions: {} });
  const inject = () => ({
    hooks: { shortcuts: { getSnapshot: () => [], subscribe: () => () => {} } },
  });
  const Native = () => null;
  ctx.slots.register(
    {
      name: 'conversation.session.header.corner',
      store,
      locale: 'sidebarRight',
      inject,
    },
    Native,
  );
  const plugin = ctx.plugin({ apply: applyTopbar });
  await plugin;
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const entry = ctx.slots.entriesOfSlot(
    'conversation.session.header.corner',
  )[0]!;
  expect(entry.store).toBe(store);
  expect(entry.inject).toBe(inject);
  expect(entry.locale).toBe('sidebarRight');
  const setExpanded = vi.fn();
  const props = {
    sessionId: 'synthetic-native-session',
    actions: { setExpanded },
  } as unknown as ExpandButtonProps;
  const Wrapped = entry.component as ReturnType<typeof nativeStartCorner>;
  const element = Wrapped(props);
  expect(element.type).toBe(Native);
  element.props.actions.setExpanded(props.sessionId, true);
  expect(right.openTab).toHaveBeenLastCalledWith('guide');
  expect(setExpanded).not.toHaveBeenCalled();
  element.props.actions.setExpanded(props.sessionId, false);
  expect(setExpanded).toHaveBeenCalledWith(props.sessionId, false);
  await plugin.dispose();
  expect(
    ctx.slots.entriesOfSlot('conversation.session.header.corner')[0]?.component,
  ).toBe(Native);
});
