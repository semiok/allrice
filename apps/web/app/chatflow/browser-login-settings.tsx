'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import styles from './sidebar-settings.module.css';

type Grant = {
  grantId: string;
  deviceId: string;
  enabled: boolean;
  persistLogin: boolean;
  profile: { network?: string };
};

export function BrowserLoginSettings({
  workspaceId,
  deviceId,
  active,
}: {
  workspaceId: string;
  deviceId: string;
  active: boolean;
}) {
  const [grant, setGrant] = useState<Grant | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(
        `/api/v1/admin/local-browser?workspaceId=${workspaceId}`,
        { cache: 'no-store', signal },
      );
      if (!response.ok) throw Error('浏览器登录设置读取失败，请重试。');
      const body = (await response.json()) as { grants: Grant[] };
      if (!signal?.aborted)
        setGrant(
          body.grants.find(
            (item) =>
              item.deviceId === deviceId &&
              item.enabled &&
              item.profile.network === 'public_https',
          ) ?? null,
        );
    },
    [workspaceId, deviceId],
  );
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void refresh(controller.signal).catch((cause) => {
      if (!controller.signal.aborted) setError(cause.message);
    });
    return () => controller.abort();
  }, [active, refresh]);
  async function save(rememberLogin: boolean, clear = false) {
    if (!grant || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/v1/admin/local-browser', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          action: 'login_preferences',
          grantId: grant.grantId,
          rememberLogin,
        }),
      });
      if (!response.ok) throw Error('设置未保存，请刷新电脑状态后重试。');
      await refresh();
      setMessage(
        clear || !rememberLogin
          ? '已切换到空白登录资料；电脑连接后会清除旧资料，并结束正在使用旧登录的浏览器。'
          : '已开启，后续任务会保留本次使用的登录状态。',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '设置未保存，请重试。');
    } finally {
      setBusy(false);
    }
  }
  if (!grant && !error) return null;
  return (
    <div>
      {grant && (
        <>
          <div className={styles.capabilitySetting}>
            <div>
              <strong>保留浏览器登录</strong>
              <p>
                默认开启。登录资料保存在这台电脑的专用浏览器中，供你的后续任务使用。
              </p>
            </div>
            <Switch
              label="保留浏览器登录"
              checked={grant.persistLogin}
              disabled={busy}
              onChange={(value) => void save(value)}
            />
          </div>
          <Button
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => void save(grant.persistLogin, true)}
          >
            清除浏览器登录
          </Button>
        </>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
