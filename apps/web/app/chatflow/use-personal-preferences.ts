'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  defaultUserPreferences,
  UserPreferencesSchema,
  type UserPreferences,
  type UserPreferencesInput,
} from '@allrice/contracts';
import { setAppearance } from '../../lib/theme/appearance';
import type { Workspace } from './chatflow-types';
import { readJson } from './chatflow-utils';

export function usePersonalPreferences(
  workspace: Workspace | null,
  headers: Record<string, string>,
) {
  const viewerId = workspace?.viewerId;
  const scope = `${workspace?.organizationId}/${workspace?.workspaceId}/${viewerId}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const request = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    preferences?: UserPreferences;
    pending: boolean;
    error?: string;
  } | null>(null);
  const execute = useCallback(
    async (update?: UserPreferencesInput) => {
      if (!viewerId || saving.current) return false;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      saving.current = update !== undefined;
      const current = () =>
        currentScope.current === scope && request.current === controller;
      setSnapshot((previous) => ({
        ...(previous?.scope === scope ? previous : {}),
        scope,
        pending: true,
        error: undefined,
      }));
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch('/api/v1/me/preferences', {
          method: update === undefined ? 'GET' : 'PATCH',
          headers: { ...headers, 'content-type': 'application/json' },
          ...(update === undefined ? {} : { body: JSON.stringify(update) }),
          cache: 'no-store',
          signal: controller.signal,
        });
        const result = await readJson<{
          viewerId: string;
          preferences: unknown;
        }>(response);
        if (result.viewerId !== viewerId)
          throw Error('账号已变化，请刷新后重试');
        const preferences = UserPreferencesSchema.parse(result.preferences);
        if (current() && !controller.signal.aborted) {
          setSnapshot({ scope, preferences, pending: false });
          return true;
        }
      } catch (error) {
        if (current())
          setSnapshot((previous) => ({
            ...(previous?.scope === scope ? previous : {}),
            scope,
            pending: false,
            error:
              error instanceof Error && error.name !== 'AbortError'
                ? error.message
                : '个人偏好读取或保存超时，请重试',
          }));
      } finally {
        window.clearTimeout(timeout);
        if (current()) {
          request.current = null;
          saving.current = false;
        }
      }
      return false;
    },
    [viewerId, scope, headers],
  );
  useEffect(
    () => () => {
      request.current?.abort();
      request.current = null;
      saving.current = false;
    },
    [scope],
  );
  const own = snapshot?.scope === scope ? snapshot : null;
  const value = own?.preferences ?? {
    ...defaultUserPreferences,
    ...workspace?.preferences,
  };
  // Each newly read or saved value is what the server holds: the theme follows.
  const appearance = viewerId ? value.appearance : null;
  useEffect(() => {
    if (appearance) setAppearance(appearance);
  }, [appearance]);
  return {
    scope,
    value,
    pending: own?.pending ?? false,
    error: own?.error,
    available: !!viewerId,
    reload: () => execute(),
    setPreferences: (value: UserPreferencesInput) => execute(value),
    setStreamingOutput: (value: boolean) => execute({ streamingOutput: value }),
  };
}
