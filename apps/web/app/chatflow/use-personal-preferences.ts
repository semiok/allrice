'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  defaultUserPreferences,
  UserPreferencesSchema,
  type UserPreferences,
} from '@allrice/contracts';
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
    async (streamingOutput?: boolean) => {
      if (!viewerId || saving.current) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      saving.current = streamingOutput !== undefined;
      const current = () =>
        currentScope.current === scope && request.current === controller;
      setSnapshot((previous) => ({
        ...(previous?.scope === scope ? previous : {}),
        scope,
        pending: true,
      }));
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch('/api/v1/me/preferences', {
          method: streamingOutput === undefined ? 'GET' : 'PATCH',
          headers: { ...headers, 'content-type': 'application/json' },
          ...(streamingOutput === undefined
            ? {}
            : { body: JSON.stringify({ streamingOutput }) }),
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
        if (current() && !controller.signal.aborted)
          setSnapshot({ scope, preferences, pending: false });
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
  return {
    value: own?.preferences ?? workspace?.preferences ?? defaultUserPreferences,
    pending: own?.pending ?? false,
    error: own?.error,
    available: !!viewerId,
    reload: () => execute(),
    setStreamingOutput: (value: boolean) => execute(value),
  };
}
