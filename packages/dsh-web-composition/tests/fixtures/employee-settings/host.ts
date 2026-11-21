import { createElement } from 'react';
import { vi } from 'vitest';
import type {
  EmployeeSettingsPort,
  EmployeeSettingsScope,
  EmployeeSettingsSnapshot,
  NativeEmployeeSettingsLauncher,
} from '../../../src/employee-settings-port';

export function createSettingsHost() {
  let snapshot: EmployeeSettingsSnapshot | null = {
    scopeKey: 'person-a/employee-a/binding-1',
    preferences: {
      values: { streamingOutput: true },
      pending: false,
      error: null,
    },
    notifications: {
      values: { taskCompleted: false, needsConfirmation: false },
      pending: false,
      error: null,
    },
  };
  const listeners = new Set<() => void>();
  const launchers = new Set<NativeEmployeeSettingsLauncher>();
  const unbind = vi.fn();
  const port: EmployeeSettingsPort = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    renderSection: vi.fn((section, scope: EmployeeSettingsScope) =>
      createElement(
        'div',
        { 'data-existing-section': section, 'data-scope': scope.key },
        `existing ${section} surface`,
      ),
    ),
    openAccountSettings: vi.fn(),
    reloadPreferences: vi.fn(),
    setStreamingOutput: vi.fn(),
    bindNativeLauncher: (launcher) => {
      launchers.add(launcher);
      return () => {
        launchers.delete(launcher);
        unbind();
      };
    },
    notificationPreferences: { reload: vi.fn(), set: vi.fn() },
  };
  return {
    port,
    listeners,
    launchers,
    unbind,
    set(value: EmployeeSettingsSnapshot | null) {
      snapshot = value;
      for (const listener of [...listeners]) listener();
    },
    update(value: Partial<EmployeeSettingsSnapshot>) {
      if (!snapshot) throw new Error('Fixture has no current identity');
      this.set({ ...snapshot, ...value });
    },
  };
}
