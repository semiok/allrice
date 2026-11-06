'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cloudProjectCapabilityId as capabilityId,
  UserPreferencesSchema,
  type UserPreferencesInput,
} from '@allrice/contracts';
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import { z } from 'zod';
import styles from './capability-panel.module.css';

const title = '云端项目开发';
const description = '在云端保存项目、运行构建、打开预览并发布成果。';
const scope = '适用于你的所有 AI 员工。更改仅对新对话生效，进行中的对话不变。';
const local = '本机开发由“我的电脑”控制，不受此开关影响。';
const failure = '个人偏好暂时无法保存或读取，请重试';

// Validate the required wire fields without supplying a client-side default.
// Shared preference types and the authoritative default belong to the backend.
const responseSchema = z.object({
  viewerId: z.string().min(1),
  preferences: UserPreferencesSchema,
});
type View = { viewerId: string; enabled: boolean };

export function CloudProjectDevelopmentSetting({
  viewerId,
}: {
  viewerId: string | null | undefined;
}) {
  const [view, setView] = useState<View | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const confirmed = useRef<View | null>(null);
  const request = useRef<AbortController | null>(null);

  const execute = useCallback(
    async (enabled?: boolean) => {
      if (
        request.current ||
        (enabled !== undefined &&
          (!confirmed.current || confirmed.current.viewerId !== viewerId))
      )
        return;
      const controller = new AbortController();
      request.current = controller;
      const current = () =>
        request.current === controller && !controller.signal.aborted;
      setPending(true);
      setError('');
      try {
        const response = await fetch('/api/v1/me/preferences', {
          cache: 'no-store',
          signal: controller.signal,
          ...(enabled === undefined
            ? {}
            : {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  capabilities: {
                    [capabilityId]: { configVersion: 1, enabled },
                  },
                } satisfies UserPreferencesInput),
              }),
        });
        const result = responseSchema.safeParse(await response.json());
        if (
          !response.ok ||
          !result.success ||
          result.data.viewerId !== viewerId
        )
          throw Error(failure);
        if (current()) {
          const value = {
            viewerId: result.data.viewerId,
            enabled: result.data.preferences.capabilities[capabilityId].enabled,
          };
          confirmed.current = value;
          setView(value);
        }
      } catch {
        if (current()) setError(failure);
      } finally {
        if (current()) {
          request.current = null;
          setPending(false);
        }
      }
    },
    [viewerId],
  );

  useEffect(() => {
    confirmed.current = null;
    setView(null);
    void execute();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [execute]);
  const own = view?.viewerId === viewerId ? view : null;

  return (
    <div
      className={styles.cloudProjectRow}
      data-cloud-project-development
      aria-busy={pending}
    >
      <details className={styles.card}>
        <summary className={styles.cardTitle}>
          <h3>{title}</h3>
          <span className={styles.cloudSwitchSeat} aria-hidden="true" />
        </summary>
        <div className={styles.cardBody}>
          <p>{description}</p>
          <p>{scope}</p>
          <p>{local}</p>
        </div>
      </details>
      <Switch
        className={styles.cloudProjectSwitch}
        label={title}
        title={`${description} ${scope} ${local}`}
        checked={own?.enabled ?? false}
        disabled={!own || pending || !!error}
        onChange={(enabled) => void execute(enabled)}
      />
      {error && (
        <p role="alert" className={styles.error}>
          {error}{' '}
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void execute()}
          >
            重新读取
          </Button>
        </p>
      )}
    </div>
  );
}
