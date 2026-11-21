import type { ReactElement } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { SettingsLauncherOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client';

export type EmployeeSettingsSection = 'computer' | 'work' | 'apps';
export type NotificationPreference = 'taskCompleted' | 'needsConfirmation';

/** Host-only identity lifetime. The authenticated owner supplies its remount key. */
export interface EmployeeSettingsScope {
  readonly key: string;
  readonly signal: AbortSignal;
}

/** Values and request status belong to the existing authenticated reader. */
export interface EmployeePreferenceView<Key extends string> {
  readonly values: Readonly<Record<Key, boolean>> | null;
  readonly pending: boolean;
  readonly error: string | null;
}

export interface EmployeeSettingsSnapshot {
  readonly scopeKey: string;
  readonly preferences: EmployeePreferenceView<'streamingOutput'>;
  readonly notifications?: EmployeePreferenceView<NotificationPreference>;
}

/** Only the native settings shell owns its open state and open action. */
export interface NativeEmployeeSettingsLauncher {
  readonly scopeKey: string;
  readonly settingsOpen: boolean;
  readonly openSettings: () => void;
}

/** Personal preferences only. This port does not send notifications. */
export interface EmployeeNotificationPreferencesPort {
  reload: (scope: EmployeeSettingsScope) => void;
  set: (
    scope: EmployeeSettingsScope,
    preference: NotificationPreference,
    enabled: boolean,
  ) => void;
}

/**
 * Supplied by the trusted AllRice owner, never by an employee/guest payload.
 * Async actions publish pending/error/authoritative values through the snapshot.
 * Callbacks must use the supplied signal and their current server-side identity.
 */
export interface EmployeeSettingsPort {
  getSnapshot: () => EmployeeSettingsSnapshot | null;
  subscribe: (listener: () => void) => () => void;
  renderSection: (
    section: EmployeeSettingsSection,
    scope: EmployeeSettingsScope,
  ) => ReactElement;
  /** Opens the existing account, password, logout, quota and storage surface. */
  openAccountSettings: (scope: EmployeeSettingsScope) => void;
  reloadPreferences: (scope: EmployeeSettingsScope) => void;
  setStreamingOutput: (scope: EmployeeSettingsScope, enabled: boolean) => void;
  /** Disposer must release only this binding, including when it is superseded. */
  bindNativeLauncher: (launcher: NativeEmployeeSettingsLauncher) => () => void;
  notificationPreferences?: EmployeeNotificationPreferencesPort;
}

export interface EmployeeSettingsOptions {
  /** M1 defaults to hidden. Enabling requires a real named preference port. */
  notifications?: boolean;
  /** Optional owner UI; actions become active only for the committed binding. */
  renderLauncher?: (props: SettingsLauncherOwnerProps) => ReactElement | null;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    allriceEmployeeSettings: EmployeeSettingsPort;
  }
}

/** Bind only from the authenticated owner plugin's Cordis lifetime. */
export function bindEmployeeSettings(ctx: Context, port: EmployeeSettingsPort) {
  ctx.provide('allriceEmployeeSettings', port);
}
