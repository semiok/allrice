import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Context } from '@deepseek-ai/cordis';
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots';
import type { SettingsLauncherOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, bindEmployeeSettings } from '../src/employee-settings';
import { EmployeeSettingsModel } from '../src/employee-settings-model';
import type { EmployeeSettingsScope } from '../src/employee-settings-port';
import { nativeClientModule } from './native-client-module.mjs';
import { createSettingsHost } from './fixtures/employee-settings/host';

const contexts: Context[] = [];
const models: EmployeeSettingsModel[] = [];
afterEach(async () => {
  for (const model of models.splice(0)) model.dispose();
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
});

function setupModel(notifications = false) {
  const host = createSettingsHost();
  const model = new EmployeeSettingsModel(host.port, notifications);
  models.push(model);
  const scope = () => model.getSnapshot().scope!;
  return { host, model, scope };
}

function nativeLauncher(settingsOpen = false): SettingsLauncherOwnerProps {
  return {
    wide: true,
    settingsOpen,
    openSettings: vi.fn(),
    openOnboarding: vi.fn(),
  };
}

describe('trusted employee settings actions', () => {
  it('opens the real account owner and then closes the native panel', () => {
    const { host, model, scope } = setupModel();
    const close = vi.fn();
    expect(model.openAccount(scope(), close)).toBe(true);
    expect(host.port.openAccountSettings).toHaveBeenCalledWith(scope());
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not dismiss the panel when the owner cannot open the account', () => {
    const { host, model, scope } = setupModel();
    const close = vi.fn();
    host.port.openAccountSettings = () => {
      throw new Error('owner unavailable');
    };
    expect(() => model.openAccount(scope(), close)).toThrow(
      'owner unavailable',
    );
    expect(close).not.toHaveBeenCalled();
  });

  it('does not close a new identity panel when account navigation changes the binding synchronously', () => {
    const { host, model, scope } = setupModel();
    const close = vi.fn();
    host.port.openAccountSettings = () =>
      host.update({ scopeKey: 'person-b/employee-b/binding-2' });
    model.openAccount(scope(), close);
    expect(close).not.toHaveBeenCalled();
  });

  it('passes the current abort signal to existing preference actions, without writing a local value', () => {
    const { host, model, scope } = setupModel();
    model.reloadPreferences(scope());
    model.setStreamingOutput(scope(), false);
    expect(host.port.reloadPreferences).toHaveBeenCalledWith(scope());
    expect(host.port.setStreamingOutput).toHaveBeenCalledWith(scope(), false);
    expect(
      model.getSnapshot().snapshot?.preferences.values?.streamingOutput,
    ).toBe(true);
    host.update({
      preferences: {
        values: { streamingOutput: false },
        pending: false,
        error: null,
      },
    });
    expect(
      model.getSnapshot().snapshot?.preferences.values?.streamingOutput,
    ).toBe(false);
  });

  it('does not write before a value is read or while its real writer is pending', () => {
    const { host, model, scope } = setupModel();
    host.update({ preferences: { values: null, pending: false, error: null } });
    model.setStreamingOutput(scope(), false);
    host.update({
      preferences: {
        values: { streamingOutput: true },
        pending: true,
        error: null,
      },
    });
    model.setStreamingOutput(scope(), false);
    expect(host.port.setStreamingOutput).not.toHaveBeenCalled();
  });

  it('aborts old reads and rejects callbacks retained across a person/employee change and revocation', () => {
    const { host, model, scope } = setupModel(true);
    const old = scope();
    const close = vi.fn();
    host.update({
      scopeKey: 'person-b/employee-b/binding-2',
      preferences: {
        values: { streamingOutput: false },
        pending: false,
        error: null,
      },
    });
    expect(old.signal.aborted).toBe(true);
    expect(
      model.getSnapshot().snapshot?.preferences.values?.streamingOutput,
    ).toBe(false);
    model.openAccount(old, close);
    model.reloadPreferences(old);
    model.setStreamingOutput(old, true);
    model.reloadNotifications(old);
    model.setNotification(old, 'taskCompleted', true);
    expect(host.port.openAccountSettings).not.toHaveBeenCalled();
    expect(host.port.reloadPreferences).not.toHaveBeenCalled();
    expect(host.port.setStreamingOutput).not.toHaveBeenCalled();
    expect(host.port.notificationPreferences?.reload).not.toHaveBeenCalled();
    expect(host.port.notificationPreferences?.set).not.toHaveBeenCalled();
    const latest = scope();
    host.set(null);
    expect(latest.signal.aborted).toBe(true);
    expect(model.getSnapshot()).toEqual({ scope: null, snapshot: null });
    model.openAccount(latest, close);
    expect(close).not.toHaveBeenCalled();
  });

  it('does not revive a retained action when the same key returns after revocation', () => {
    const { host, model, scope } = setupModel();
    const originalSnapshot = host.port.getSnapshot();
    const old = scope();
    host.set(null);
    host.set(originalSnapshot);
    expect(scope()).not.toBe(old);
    expect(old.signal.aborted).toBe(true);
    model.setStreamingOutput(old, false);
    expect(host.port.setStreamingOutput).not.toHaveBeenCalled();
  });

  it('does not lose an identity change made while installing its source subscription', () => {
    const host = createSettingsHost();
    const subscribe = host.port.subscribe;
    host.port.subscribe = (listener) => {
      host.update({ scopeKey: 'person-b/employee-b/binding-2' });
      return subscribe(listener);
    };
    const model = new EmployeeSettingsModel(host.port);
    models.push(model);
    expect(model.getSnapshot().scope?.key).toBe(
      'person-b/employee-b/binding-2',
    );
  });
});

describe('native shell launcher lifetime', () => {
  it('forwards the actual native open callback/state and releases it on scope change', () => {
    const { host, model, scope } = setupModel();
    const native = nativeLauncher(true);
    const off = model.bindLauncher(scope(), native);
    const binding = [...host.launchers][0]!;
    expect(binding.settingsOpen).toBe(true);
    expect(binding.scopeKey).toBe(scope().key);
    binding.openSettings();
    expect(native.openSettings).toHaveBeenCalledOnce();
    host.update({ scopeKey: 'new/binding' });
    expect(host.launchers.size).toBe(0);
    binding.openSettings();
    expect(native.openSettings).toHaveBeenCalledOnce();
    off();
    expect(host.unbind).toHaveBeenCalledOnce();
  });

  it('invalidates a captured callback on same-scope disposal while a new launcher still opens', () => {
    const { host, model, scope } = setupModel();
    const currentScope = scope();
    const oldNative = nativeLauncher();
    const off = model.bindLauncher(currentScope, oldNative);
    const oldOpen = [...host.launchers][0]!.openSettings;
    off();
    oldOpen();
    expect(oldNative.openSettings).not.toHaveBeenCalled();
    expect(host.unbind).toHaveBeenCalledOnce();
    const nextNative = nativeLauncher();
    const nextOff = model.bindLauncher(currentScope, nextNative);
    const nextOpen = [...host.launchers][0]!.openSettings;
    oldOpen();
    nextOpen();
    expect(oldNative.openSettings).not.toHaveBeenCalled();
    expect(nextNative.openSettings).toHaveBeenCalledOnce();
    off();
    expect(host.unbind).toHaveBeenCalledOnce();
    expect(scope()).toBe(currentScope);
    expect(currentScope.signal.aborted).toBe(false);
    nextOff();
    nextOpen();
    expect(nextNative.openSettings).toHaveBeenCalledOnce();
    expect(host.unbind).toHaveBeenCalledTimes(2);
  });

  it('invalidates before owner cleanup, including a reentrant callback and cleanup error', () => {
    const { host, model, scope } = setupModel();
    const native = nativeLauncher();
    let capturedOpen = () => {};
    const unbind = vi.fn(() => {
      capturedOpen();
      throw new Error('owner cleanup failed');
    });
    host.port.bindNativeLauncher = (launcher) => {
      capturedOpen = launcher.openSettings;
      return unbind;
    };
    const off = model.bindLauncher(scope(), native);
    expect(() => off()).toThrow('owner cleanup failed');
    capturedOpen();
    expect(native.openSettings).not.toHaveBeenCalled();
    off();
    expect(unbind).toHaveBeenCalledOnce();
  });

  it('immediately releases a launcher when the owner changes identity during binding', () => {
    const { host, model, scope } = setupModel();
    const bind = host.port.bindNativeLauncher;
    host.port.bindNativeLauncher = (launcher) => {
      const off = bind(launcher);
      host.update({ scopeKey: 'new/binding' });
      return off;
    };
    model.bindLauncher(scope(), nativeLauncher());
    expect(host.launchers.size).toBe(0);
  });

  it('aborts, unsubscribes and releases every binding even when one cleanup fails', () => {
    const { host, model, scope } = setupModel();
    const originalScope = scope();
    const off = vi.fn();
    host.port.bindNativeLauncher = () =>
      off.mock.calls.length === 0
        ? () => {
            off();
            throw new Error('first cleanup failed');
          }
        : off;
    model.bindLauncher(scope(), nativeLauncher());
    model.bindLauncher(scope(), nativeLauncher());
    expect(() => model.dispose()).toThrow(AggregateError);
    expect(off).toHaveBeenCalledTimes(2);
    expect(originalScope.signal.aborted).toBe(true);
    expect(host.listeners.size).toBe(0);
    expect(model.getSnapshot()).toEqual({ scope: null, snapshot: null });
  });

  it('still publishes the cleared identity when a launcher cleanup reports a failure', () => {
    const { host, model, scope } = setupModel();
    host.port.bindNativeLauncher = () => () => {
      throw new Error('owner cleanup failed');
    };
    model.bindLauncher(scope(), nativeLauncher());
    const changed = vi.fn();
    model.subscribe(changed);
    expect(() => host.set(null)).toThrow(AggregateError);
    expect(model.getSnapshot()).toEqual({ scope: null, snapshot: null });
    expect(changed).toHaveBeenCalledOnce();
  });

  it('still aborts and releases launchers when the source unsubscriber reports a failure', () => {
    const host = createSettingsHost();
    const subscribe = host.port.subscribe;
    host.port.subscribe = (listener) => {
      const off = subscribe(listener);
      return () => {
        off();
        throw new Error('source cleanup failed');
      };
    };
    const model = new EmployeeSettingsModel(host.port);
    models.push(model);
    const scope = model.getSnapshot().scope!;
    model.bindLauncher(scope, nativeLauncher());
    const changed = vi.fn();
    model.subscribe(changed);
    expect(() => model.dispose()).toThrow();
    expect(scope.signal.aborted).toBe(true);
    expect(host.listeners.size).toBe(0);
    expect(host.launchers.size).toBe(0);
    expect(model.getSnapshot()).toEqual({ scope: null, snapshot: null });
    expect(changed).toHaveBeenCalledOnce();
  });
});

describe('notification feature gate', () => {
  it('never reads or writes hidden notifications, even if a preference port is present', () => {
    const { host, model, scope } = setupModel();
    model.reloadNotifications(scope());
    model.setNotification(scope(), 'taskCompleted', true);
    expect(host.port.notificationPreferences?.reload).not.toHaveBeenCalled();
    expect(host.port.notificationPreferences?.set).not.toHaveBeenCalled();
  });

  it('requires the named preference port when explicitly enabled', () => {
    const host = createSettingsHost();
    delete host.port.notificationPreferences;
    expect(() => new EmployeeSettingsModel(host.port, true)).toThrow(
      'preference port is required',
    );
    expect(host.listeners.size).toBe(0);
  });

  it('writes only the named current preference and renders the owner result, with no delivery call', () => {
    const { host, model, scope } = setupModel(true);
    model.reloadNotifications(scope());
    model.setNotification(scope(), 'needsConfirmation', true);
    expect(host.port.notificationPreferences?.reload).toHaveBeenCalledWith(
      scope(),
    );
    expect(host.port.notificationPreferences?.set).toHaveBeenCalledWith(
      scope(),
      'needsConfirmation',
      true,
    );
    expect(model.getSnapshot().snapshot?.notifications?.values).toEqual({
      taskCompleted: false,
      needsConfirmation: false,
    });
    host.update({
      notifications: {
        values: { taskCompleted: false, needsConfirmation: true },
        pending: false,
        error: null,
      },
    });
    expect(
      model.getSnapshot().snapshot?.notifications?.values?.needsConfirmation,
    ).toBe(true);
    host.update({
      notifications: { values: null, pending: true, error: null },
    });
    model.setNotification(scope(), 'taskCompleted', true);
    expect(host.port.notificationPreferences?.set).toHaveBeenCalledTimes(1);
  });
});

type Seats =
  | 'settings.section'
  | 'settings.general.item'
  | 'settings.launcher'
  | 'settings.action';
function TestRoot({ renderSlot }: PropsRenderSlots<Seats>) {
  return createElement(
    'main',
    {},
    renderSlot('settings.general.item', {}),
    renderSlot('settings.section', { close: () => {} }),
  );
}

async function setupSlots(notifications?: boolean, bind = true) {
  const ctx = new Context();
  contexts.push(ctx);
  const renderer = nativeClientModule(
    '@deepseek-ai/dsh-client-ui-renderer',
  ) as { apply: (ctx: Context) => void };
  renderer.apply(ctx);
  const host = createSettingsHost();
  if (bind) bindEmployeeSettings(ctx, host.port);
  const options = { notifications };
  const plugin = ctx.plugin({ inject: ['slots'], apply }, options);
  await plugin;
  const declare = () =>
    ctx.slots.register(
      {
        name: 'root',
        children: {
          'settings.section': { kind: 'list', scope: 'root' },
          'settings.general.item': { kind: 'list', scope: 'root' },
          'settings.launcher': { kind: 'single', scope: 'root' },
          'settings.action': { kind: 'list', scope: 'root' },
        },
      },
      TestRoot,
    );
  const remove = declare();
  // The released renderer is browser-only. Exercise its real winning entries
  // here; full native-shell rendering is covered by the prepared browser suite.
  const html = () =>
    [
      ...ctx.slots.entriesOfSlot('settings.general.item'),
      ...ctx.slots.entriesOfSlot('settings.section'),
    ]
      .map((entry) =>
        renderToStaticMarkup(
          createElement(
            entry.component as ComponentType<{ close: () => void }>,
            { close: () => {} },
          ),
        ),
      )
      .join('');
  return { ctx, host, plugin, declare, remove, html, options };
}

describe('public native settings assembly', () => {
  it('registers real account/business entries only after a trusted owner exists, with hidden notifications by default', async () => {
    const { ctx, host, html } = await setupSlots(undefined, false);
    expect(ctx.slots.entries('settings.section')).toHaveLength(0);
    bindEmployeeSettings(ctx, host.port);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      ctx.slots.entries('settings.section').map((entry) => entry.options.id),
    ).toEqual([
      'allrice-account',
      'allrice-computer',
      'allrice-work',
      'allrice-apps',
    ]);
    const output = html();
    expect(output).toContain('打开账号设置');
    expect(output).toContain('existing computer surface');
    expect(output).toContain('existing work surface');
    expect(output).toContain('existing apps surface');
    expect(output).toContain('aria-label="流式输出"');
    expect(output).not.toContain('任务完成通知');
    expect(output).not.toContain('设计预览');
    expect(output).not.toContain('API');
    expect(host.port.renderSection).toHaveBeenCalledTimes(3);
    for (const [, scope] of vi.mocked(host.port.renderSection).mock.calls)
      expect((scope as EmployeeSettingsScope).signal.aborted).toBe(false);
  });

  it('leaves all native general rows intact and restores shaded management rows on unload', async () => {
    const { ctx, plugin } = await setupSlots();
    const native = () => createElement('span', {}, 'native');
    for (const id of [
      'language',
      'appearance',
      'font-size',
      'transcript-view',
      'current-version',
      'permission',
      'developer-tools',
      'session-log-deepseek',
    ])
      ctx.slots.register({ name: 'settings.general.item', id }, native);
    ctx.slots.register(
      { name: 'settings.action', id: 'open-document' },
      native,
    );
    const nativeIds = () =>
      ctx.slots
        .entriesOfSlot('settings.general.item')
        .filter((entry) => entry.component === native)
        .map((entry) => entry.options.id);
    expect(nativeIds()).toEqual([
      'language',
      'appearance',
      'font-size',
      'transcript-view',
      'current-version',
    ]);
    expect(
      (
        ctx.slots.entriesOfSlot('settings.action')[0]!.component as () => null
      )(),
    ).toBeNull();
    await plugin.dispose();
    expect(nativeIds()).toContain('permission');
    expect(nativeIds()).toContain('developer-tools');
    expect(nativeIds()).toContain('session-log-deepseek');
    expect(ctx.slots.entries('settings.section')).toHaveLength(0);
    expect(ctx.slots.entriesOfSlot('settings.action')[0]?.component).toBe(
      native,
    );
  });

  it('rebinds exactly once after native slot declarations are destroyed and recreated', async () => {
    const { ctx, remove, declare } = await setupSlots();
    remove();
    declare();
    expect(ctx.slots.entries('settings.section')).toHaveLength(4);
    expect(
      ctx.slots
        .entries('settings.general.item')
        .filter((entry) => entry.options.id === 'allrice-streaming-output'),
    ).toHaveLength(1);
    expect(ctx.slots.entries('settings.launcher')).toHaveLength(1);
  });

  it('does not expose hidden notifications when a caller mutates an old options object', async () => {
    const { ctx, options, remove, declare } = await setupSlots(false);
    options.notifications = true;
    remove();
    declare();
    expect(
      ctx.slots
        .entries('settings.general.item')
        .some((entry) => entry.options.id === 'allrice-notifications'),
    ).toBe(false);
  });

  it('renders enabled notification controls only from the authoritative preference snapshot', async () => {
    const { host, html } = await setupSlots(true);
    expect(html()).toContain('aria-label="任务完成通知"');
    expect(html()).toContain('aria-label="需要确认通知"');
    host.update({
      notifications: { values: null, pending: true, error: null },
    });
    expect(html()).not.toContain('aria-label="任务完成通知"');
    expect(html()).toContain('正在读取通知偏好');
    host.update({
      notifications: {
        values: null,
        pending: false,
        error: '通知偏好读取失败',
      },
    });
    expect(html()).toContain('通知偏好读取失败');
    expect(html()).toContain('重新读取');
  });

  it('removes prior identity content immediately after revocation', async () => {
    const { host, html } = await setupSlots();
    expect(html()).toContain('existing computer surface');
    host.set(null);
    const output = html();
    expect(output).not.toContain('existing computer surface');
    expect(output).not.toContain('aria-label="流式输出"');
    expect(output).toContain('当前设置不可用');
  });
});
