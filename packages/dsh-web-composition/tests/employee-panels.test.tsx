// Unit-only synthetic UI controllers; no browser, DB, model or VM.
import { Context } from '@deepseek-ai/cordis';
import { ReferenceSelectionSchema } from '@allrice/contracts';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {
  PropsRenderSlots,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apply,
  bindEmployeePanels,
  EmployeePanelBody,
  EmployeePanelContent,
  EmployeePanelsHeader,
  EmployeePanelsEntries,
} from '../src/employee-panels';
import {
  assertEmployeePanelsCurrent,
  employeePanelKinds,
  employeePanelsActions,
  employeePanelsSnapshot,
  EmployeePanelsUnavailableError,
  guardEmployeePanelProps,
  subscribeEmployeePanels,
  insertEmployeePanelReference,
} from '../src/employee-panels-model';
import type { EmployeePanelsReference } from '../src/employee-panels-port';
import { EnterpriseMaterialsPanel } from '../../../apps/web/app/chatflow/enterprise-materials-panel';
import { WorkbenchFilesPanel } from '../../../apps/web/app/chatflow/workbench-files-panel';
import { EmployeeMemorySidebar } from '../../../apps/web/app/chatflow/employee-memory-sidebar';
import { EmployeeCapabilitiesPanel } from '../../../apps/web/app/chatflow/employee-capabilities-panel';
import { WorkbenchEntries } from '../../../apps/web/app/chatflow/workbench-modules';
import { nativeClientModule } from './native-client-module.mjs';
import {
  syntheticNavigation,
  syntheticPanelsOwner,
} from './fixtures/employee-panels/owner';

const contexts: Context[] = [];
const referenceSelection = () =>
  ReferenceSelectionSchema.parse({
    sourceId: '00000000-0000-4000-8000-000000000004',
    revisionId: '00000000-0000-4000-8000-000000000005',
    revision: 2,
    fileName: 'synthetic-reference.md',
    purpose: 'Synthetic fixture',
    digest: 'sha256:' + 'a'.repeat(64),
    checksum: 'sha256:' + 'b'.repeat(64),
    ownership: {
      scope: 'personal',
      organizationId: '00000000-0000-4000-8000-000000000006',
      ownerId: '00000000-0000-4000-8000-000000000001',
    },
  });
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.restoreAllMocks();
});

function setup() {
  const ctx = new Context();
  contexts.push(ctx);
  const { SlotRegistry } = nativeClientModule(
    '@deepseek-ai/dsh-client-ui-renderer',
  );
  new SlotRegistry(ctx);
  const navigation = syntheticNavigation(ctx);
  const root = ctx.slots.register(
    {
      name: 'root',
      children: {
        main: { kind: 'keyed', scope: 'root' },
        'sidebar.right.pane.tab': {
          kind: 'keyed',
          scope: 'session',
          inject: {
            hooks: {
              tabInfo: () => () => {
                throw Error('Synthetic registration has no native pane');
              },
            },
          },
        },
        'conversation.session.header.actions': {
          kind: 'list',
          scope: 'session',
        },
      },
    },
    ({
      renderSlot,
    }: PropsRenderSlots<
      'main' | 'sidebar.right.pane.tab' | 'conversation.session.header.actions'
    >) => {
      // Declarer-only fixture; it does not render a native Frame/Host.
      void renderSlot;
      return null;
    },
  );
  return { ctx, ...navigation, root };
}

function content(
  ctx: Context,
  owner: ReturnType<typeof syntheticPanelsOwner>,
  kind: keyof typeof employeePanelKinds,
  signal = owner.lifetime.signal,
) {
  return EmployeePanelContent({
    ctx,
    binding: owner.binding,
    sessionId: owner.sessionId,
    snapshot: owner.snapshot(),
    signal,
    kind,
  });
}

const headerProps = (
  ctx: Context,
  owner: ReturnType<typeof syntheticPanelsOwner>,
) =>
  ({
    ctx,
    binding: owner.binding,
    sessionId: owner.sessionId,
  }) as Parameters<typeof EmployeePanelsHeader>[0];

describe('public registration and owner lifetime', () => {
  it('registers nothing without an owner, then four page types and one header, restoring cleanly on unload', async () => {
    const { ctx, definitions } = setup();
    const contribution = ctx.plugin({ apply });
    await contribution;
    expect(definitions.size).toBe(0);
    expect(ctx.slots.entries('sidebar.right.pane.tab')).toHaveLength(0);
    const owner = syntheticPanelsOwner();
    const installed = bindEmployeePanels(ctx, owner.port);
    await installed;
    expect([...definitions.keys()]).toEqual(Object.values(employeePanelKinds));
    expect(
      ctx.slots
        .entries('sidebar.right.pane.tab')
        .map((entry) => entry.options.key),
    ).toEqual(Object.values(employeePanelKinds));
    expect(
      ctx.slots.entries('conversation.session.header.actions'),
    ).toHaveLength(1);
    const binding = ctx.allriceEmployeePanels;
    await installed.dispose();
    expect(binding.signal.aborted).toBe(true);
    expect(definitions.size).toBe(0);
    expect(ctx.slots.entries('sidebar.right.pane.tab')).toHaveLength(0);
    expect(
      ctx.slots.entries('conversation.session.header.actions'),
    ).toHaveLength(0);
    const replacement = bindEmployeePanels(ctx, owner.port);
    await replacement;
    expect(definitions.size).toBe(4);
    await contribution.dispose();
    expect(definitions.size).toBe(0);
    expect(ctx.slots.entries('sidebar.right.pane.tab')).toHaveLength(0);
  });

  it('unsubscribes exactly once and clears already-mounted content when the owner aborts', () => {
    const owner = syntheticPanelsOwner();
    const listener = vi.fn();
    const stop = subscribeEmployeePanels(
      owner.binding,
      owner.sessionId,
      listener,
    );
    expect(owner.listeners.size).toBe(1);
    owner.publish({ ...owner.snapshot(), filesUnread: 3 });
    expect(listener).toHaveBeenCalledTimes(1);
    owner.lifetime.abort();
    expect(owner.listeners.size).toBe(0);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(employeePanelsSnapshot(owner.binding, owner.sessionId)).toBeNull();
    stop();
    owner.publish(null);
    expect(listener).toHaveBeenCalledTimes(2);
    subscribeEmployeePanels(owner.binding, owner.sessionId, listener)();
    expect(owner.listeners.size).toBe(0);
  });

  it('rejects a detached scope, unavailable target and ended tab before invoking original callbacks', async () => {
    const { ctx } = setup();
    const owner = syntheticPanelsOwner();
    const snapshot = owner.snapshot();
    const file = content(ctx, owner, 'files');
    const memory = content(ctx, owner, 'experience');
    owner.publish({ ...snapshot, scopeKey: 'new-authority' });
    expect(() => file.props.onOpen({})).toThrow(EmployeePanelsUnavailableError);
    expect(() => memory.props.onConfirm({})).toThrow(
      EmployeePanelsUnavailableError,
    );
    expect(owner.onOpen).not.toHaveBeenCalled();
    expect(owner.onConfirm).not.toHaveBeenCalled();
    owner.publish(null);
    expect(() =>
      assertEmployeePanelsCurrent(owner.binding, owner.sessionId, snapshot),
    ).toThrow(EmployeePanelsUnavailableError);
    owner.publish(snapshot);
    const tab = new AbortController();
    const guarded = content(ctx, owner, 'files', tab.signal);
    tab.abort();
    expect(() => guarded.props.onOpen({})).toThrow(
      EmployeePanelsUnavailableError,
    );
  });

  it('keeps callback arguments, receiver, return value and original errors intact', () => {
    const failure = new Error('Actual owner failure');
    const check = vi.fn();
    const props = {
      value: 7,
      onRead(this: { value: number }, value: number) {
        return this.value + value;
      },
      onWrite() {
        throw failure;
      },
    };
    const guarded = guardEmployeePanelProps(props, check);
    expect(guarded.onRead(3)).toBe(10);
    expect(() => guarded.onWrite()).toThrow(failure);
    expect(check).toHaveBeenCalledTimes(2);
  });
});

describe('real components and original header behavior', () => {
  it('renders each original component and preserves owner data/actions without cloning a panel', () => {
    const { ctx } = setup();
    const owner = syntheticPanelsOwner();
    const expected = {
      materials: EnterpriseMaterialsPanel,
      files: WorkbenchFilesPanel,
      experience: EmployeeMemorySidebar,
      workflow: EmployeeCapabilitiesPanel,
    };
    for (const kind of Object.keys(expected) as Array<keyof typeof expected>) {
      const element = content(ctx, owner, kind);
      expect(element.type).toBe(expected[kind]);
      expect(element.props.active).toBe(true);
    }
    const row = { objectId: 'exact-object' };
    content(ctx, owner, 'files').props.onOpen(row);
    expect(owner.onOpen).toHaveBeenCalledWith(row);
  });

  it('SSR uses real empty/loading UI without a fetch shim or a network request', () => {
    const { ctx } = setup();
    const owner = syntheticPanelsOwner();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const html = Object.keys(employeePanelKinds).map((kind) =>
      renderToStaticMarkup(
        content(ctx, owner, kind as keyof typeof employeePanelKinds),
      ),
    );
    expect(html[0]).toContain('交付成果');
    expect(html[1]).toContain('企业资料');
    expect(html[2]).toContain('Rice');
    expect(html[3]).toContain('Rice · 能力');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains the legacy Dock toggle by default and hides only the explicitly disabled toggle', () => {
    const props = {
      counts: { files: 2, materials: 0, experience: 0, workflow: 0 },
      workflow: true,
      experience: true,
      open: false,
      onOpen: vi.fn(),
      onToggle: vi.fn(),
    };
    const original = renderToStaticMarkup(
      createElement(WorkbenchEntries, props),
    );
    expect(original).toContain('展开工作台');
    expect(
      renderToStaticMarkup(
        createElement(WorkbenchEntries, { ...props, showToggle: true }),
      ),
    ).toBe(original);
    const native = renderToStaticMarkup(
      createElement(WorkbenchEntries, { ...props, showToggle: false }),
    );
    expect(native).not.toContain('展开工作台');
    expect((native.match(/type="button"/g) ?? []).length).toBe(4);
    expect(native).toContain('2 项新增');
  });

  it('keeps files unread and the other three zero, refusing unknown counts and absent snapshots', () => {
    const { ctx } = setup();
    const owner = syntheticPanelsOwner();
    const render = () =>
      renderToStaticMarkup(
        createElement(EmployeePanelsHeader, headerProps(ctx, owner)),
      );
    expect(render()).toContain('2 项新增');
    const snapshot = owner.snapshot();
    owner.publish({ ...snapshot, filesUnread: null });
    expect(render()).toBe('');
    owner.publish(null);
    expect(render()).toBe('');
    owner.publish({ ...snapshot, filesUnread: 0 });
    expect(render()).not.toContain('项新增');
    expect((render().match(/type="button"/g) ?? []).length).toBe(4);
    owner.lifetime.abort();
    expect(render()).toBe('');
  });

  it('opens all four native kinds and refuses an old Session or authority callback', () => {
    const { ctx, right, selectSession } = setup();
    const owner = syntheticPanelsOwner();
    const entries = EmployeePanelsEntries({
      ...headerProps(ctx, owner),
      snapshot: owner.snapshot(),
    })!;
    for (const kind of Object.keys(employeePanelKinds) as Array<
      keyof typeof employeePanelKinds
    >)
      entries.props.onOpen(kind);
    expect(vi.mocked(right.openTab).mock.calls.map((call) => call[0])).toEqual(
      Object.values(employeePanelKinds),
    );
    selectSession(undefined);
    expect(() => entries.props.onOpen('files')).toThrow(
      EmployeePanelsUnavailableError,
    );
    selectSession(owner.sessionId);
    owner.publish({ ...owner.snapshot(), scopeKey: 'new-authority' });
    expect(() => entries.props.onOpen('files')).toThrow(
      EmployeePanelsUnavailableError,
    );
    expect(right.openTab).toHaveBeenCalledTimes(4);
  });

  it('does not render a hidden or already-closed native pane', () => {
    const { ctx } = setup();
    const owner = syntheticPanelsOwner();
    const tab = new AbortController();
    const props = {
      ...headerProps(ctx, owner),
      kind: 'experience',
      useTabInfo: () => ({ tab: { visible: false, signal: tab.signal } }),
    } as unknown as Parameters<typeof EmployeePanelBody>[0];
    expect(renderToStaticMarkup(createElement(EmployeePanelBody, props))).toBe(
      '',
    );
    tab.abort();
    expect(
      renderToStaticMarkup(
        createElement(EmployeePanelBody, {
          ...props,
          useTabInfo: () =>
            ({ tab: { visible: true, signal: tab.signal } }) as ReturnType<
              PropsRuntime<'sidebar.right.pane.tab'>['useTabInfo']
            >,
        }),
      ),
    ).toBe('');
  });
});

describe('explicit reference and native main bridges', () => {
  it('forwards the exact authorized reference, native Session and lifetime to the owner bridge', () => {
    const { ctx, selectSession } = setup();
    const owner = syntheticPanelsOwner();
    const reference = referenceSelection();
    const element = content(ctx, owner, 'materials');
    element.props.onUse(reference);
    expect(owner.port.useReference).toHaveBeenCalledWith({
      sessionId: owner.sessionId,
      scopeKey: owner.snapshot().scopeKey,
      reference,
      signal: owner.lifetime.signal,
    });
    selectSession(undefined);
    expect(() => element.props.onUse(reference)).toThrow(
      EmployeePanelsUnavailableError,
    );
    selectSession(owner.sessionId);
    owner.publish({ ...owner.snapshot(), scopeKey: 'new-employee' });
    expect(() => element.props.onUse(reference)).toThrow(
      EmployeePanelsUnavailableError,
    );
    expect(owner.port.useReference).toHaveBeenCalledTimes(1);
  });

  it('keeps the plus visible/read-only without a bridge and never converts refusal into success', () => {
    const { ctx } = setup();
    const owner = syntheticPanelsOwner();
    delete owner.port.useReference;
    expect(content(ctx, owner, 'materials').props.readOnly).toBe(true);
    expect(content(ctx, owner, 'files').props.readOnly).toBe(true);
    const reference: EmployeePanelsReference = referenceSelection();
    expect(() =>
      insertEmployeePanelReference(
        owner.binding,
        owner.sessionId,
        owner.snapshot(),
        owner.lifetime.signal,
        reference,
      ),
    ).toThrow(EmployeePanelsUnavailableError);
    owner.port.useReference = () => false;
    expect(() =>
      content(ctx, owner, 'materials').props.onUse(reference),
    ).toThrow(EmployeePanelsUnavailableError);
    const failure = new Error('Native span changed');
    owner.port.useReference = () => {
      throw failure;
    };
    expect(() => content(ctx, owner, 'files').props.onUse(reference)).toThrow(
      failure,
    );
  });

  it('opens only the actual registered key returned by the capability owner, with no management fallback', async () => {
    const { ctx, layout } = setup();
    const owner = syntheticPanelsOwner();
    const key = 'actual-business-panel' as MainPanelId;
    const actions = employeePanelsActions(
      ctx,
      owner.binding,
      owner.sessionId,
      owner.snapshot(),
      owner.lifetime.signal,
    );
    await expect(actions.openMain(() => null)).rejects.toThrow(
      EmployeePanelsUnavailableError,
    );
    await expect(actions.openMain(() => key)).rejects.toThrow(
      EmployeePanelsUnavailableError,
    );
    expect(layout.selectPanel).not.toHaveBeenCalled();
    const remove = ctx.slots.register({ name: 'main', key }, () => null);
    await actions.openMain(() => key);
    expect(layout.selectPanel).toHaveBeenCalledExactlyOnceWith(key);
    remove();
    await expect(actions.openMain(() => key)).rejects.toThrow(
      EmployeePanelsUnavailableError,
    );
    expect(layout.selectPanel).toHaveBeenCalledTimes(1);
  });

  it('refuses a late capability resolution after scope change, tab close or owner unload', async () => {
    const { ctx, layout, selectSession } = setup();
    const owner = syntheticPanelsOwner();
    const key = 'actual-business-panel' as MainPanelId;
    ctx.slots.register({ name: 'main', key }, () => null);
    for (const invalidate of ['scope', 'tab', 'session', 'owner'] as const) {
      selectSession(owner.sessionId);
      const tab = new AbortController();
      const snapshot = owner.snapshot();
      const actions = employeePanelsActions(
        ctx,
        owner.binding,
        owner.sessionId,
        snapshot,
        tab.signal,
      );
      let resolve!: (value: MainPanelId) => void;
      const pending = actions.openMain(
        () =>
          new Promise<MainPanelId>((done) => {
            resolve = done;
          }),
      );
      if (invalidate === 'scope')
        owner.publish({ ...snapshot, scopeKey: 'new-scope' });
      else if (invalidate === 'tab') tab.abort();
      else if (invalidate === 'session') selectSession(undefined);
      else owner.lifetime.abort();
      resolve(key);
      await expect(pending).rejects.toThrow(EmployeePanelsUnavailableError);
    }
    expect(layout.selectPanel).not.toHaveBeenCalled();
  });

  it('passes the scoped navigation bridge to the original capability content owner', async () => {
    const { ctx, layout } = setup();
    const owner = syntheticPanelsOwner();
    const key = 'actual-capability-main' as MainPanelId;
    ctx.slots.register({ name: 'main', key }, () => null);
    const base = owner.snapshot();
    const render = vi.fn(
      (actions: ReturnType<typeof employeePanelsActions>) => ({
        ...base.workflow(actions),
        children: createElement(
          'button',
          { onClick: () => actions.openMain(() => key) },
          'Synthetic owner action',
        ),
      }),
    );
    owner.publish({ ...base, workflow: (actions) => render(actions) });
    const element = content(ctx, owner, 'workflow');
    expect(element.type).toBe(EmployeeCapabilitiesPanel);
    await (
      element.props.children as ReactElement<{ onClick: () => Promise<void> }>
    ).props.onClick();
    expect(layout.selectPanel).toHaveBeenCalledExactlyOnceWith(key);
  });
});
