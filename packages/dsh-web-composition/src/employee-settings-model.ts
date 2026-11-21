import type { SettingsLauncherOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client';
import type {
  EmployeeSettingsPort,
  EmployeeSettingsScope,
  EmployeeSettingsSnapshot,
  NotificationPreference,
} from './employee-settings-port';

export interface EmployeeSettingsView {
  readonly scope: EmployeeSettingsScope | null;
  readonly snapshot: EmployeeSettingsSnapshot | null;
}

/** UI subscription/cancellation only; the host remains the preference authority. */
export class EmployeeSettingsModel {
  private view: EmployeeSettingsView = { scope: null, snapshot: null };
  private readonly listeners = new Set<() => void>();
  private readonly launchers = new Set<() => void>();
  private controller: AbortController | undefined;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(
    readonly port: EmployeeSettingsPort,
    readonly notificationsEnabled = false,
  ) {
    if (notificationsEnabled && !port.notificationPreferences)
      throw new Error('Employee notification preference port is required');
    this.sync();
    this.unsubscribe = port.subscribe(() => this.sync());
    this.sync();
  }

  getSnapshot = (): EmployeeSettingsView => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private sync() {
    if (this.disposed) return;
    const snapshot = this.port.getSnapshot();
    if (snapshot?.scopeKey === '')
      throw new Error('Authenticated employee settings scope is required');
    let scope = this.view.scope;
    const changed = snapshot?.scopeKey !== scope?.key;
    if (changed) {
      this.controller?.abort();
      this.controller = snapshot ? new AbortController() : undefined;
      scope = snapshot
        ? { key: snapshot.scopeKey, signal: this.controller!.signal }
        : null;
    }
    this.view = { scope, snapshot };
    try {
      if (changed) this.releaseLaunchers();
    } finally {
      for (const listener of this.listeners) listener();
    }
  }

  private current(scope: EmployeeSettingsScope) {
    return !this.disposed && this.view.scope === scope && !scope.signal.aborted;
  }

  openAccount(scope: EmployeeSettingsScope, close: () => void) {
    if (!this.current(scope)) return false;
    this.port.openAccountSettings(scope);
    if (this.current(scope)) close();
    return true;
  }

  reloadPreferences(scope: EmployeeSettingsScope) {
    if (this.current(scope)) this.port.reloadPreferences(scope);
  }

  setStreamingOutput(scope: EmployeeSettingsScope, enabled: boolean) {
    const view = this.view.snapshot?.preferences;
    if (this.current(scope) && view?.values && !view.pending)
      this.port.setStreamingOutput(scope, enabled);
  }

  reloadNotifications(scope: EmployeeSettingsScope) {
    if (this.notificationsEnabled && this.current(scope))
      this.port.notificationPreferences!.reload(scope);
  }

  setNotification(
    scope: EmployeeSettingsScope,
    preference: NotificationPreference,
    enabled: boolean,
  ) {
    const view = this.view.snapshot?.notifications;
    if (
      this.notificationsEnabled &&
      this.current(scope) &&
      view?.values &&
      !view.pending
    )
      this.port.notificationPreferences!.set(scope, preference, enabled);
  }

  bindLauncher(
    scope: EmployeeSettingsScope,
    native: SettingsLauncherOwnerProps,
  ) {
    if (!this.current(scope)) return () => {};
    let bound = true;
    const unbind = this.port.bindNativeLauncher({
      scopeKey: scope.key,
      settingsOpen: native.settingsOpen,
      openSettings: () => {
        if (bound && this.current(scope)) native.openSettings();
      },
    });
    if (!this.current(scope)) {
      bound = false;
      unbind();
      return () => {};
    }
    const dispose = () => {
      if (!bound) return;
      bound = false;
      this.launchers.delete(dispose);
      unbind();
    };
    this.launchers.add(dispose);
    return dispose;
  }

  private releaseLaunchers() {
    const errors: unknown[] = [];
    for (const dispose of [...this.launchers]) {
      try {
        dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, 'Settings launcher cleanup failed');
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.controller?.abort();
    const errors: unknown[] = [];
    try {
      this.unsubscribe();
    } catch (error) {
      errors.push(error);
    }
    this.view = { scope: null, snapshot: null };
    try {
      this.releaseLaunchers();
    } catch (error) {
      errors.push(error);
    } finally {
      for (const listener of this.listeners) {
        try {
          listener();
        } catch (error) {
          errors.push(error);
        }
      }
      this.listeners.clear();
    }
    if (errors.length)
      throw new AggregateError(errors, 'Employee settings cleanup failed');
  }
}
