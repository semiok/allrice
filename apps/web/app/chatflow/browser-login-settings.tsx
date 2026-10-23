'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import styles from './sidebar-settings.module.css';

type Grant = {
  grantId: string;
  deviceId: string;
  enabled: boolean;
  persistLogin: boolean;
  profile: { network?: string; origins: string[] };
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
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const scope = `${workspaceId}/${deviceId}`;
  const currentScope = useRef(scope);
  const readRevision = useRef(0);
  currentScope.current = scope;
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const revision = ++readRevision.current;
      const response = await fetch(
        `/api/v1/admin/local-browser?workspaceId=${encodeURIComponent(workspaceId)}`,
        { cache: 'no-store', signal },
      );
      if (!response.ok) throw Error('浏览器登录设置读取失败，请重试。');
      const body = (await response.json()) as { grants: Grant[] };
      if (
        !signal?.aborted &&
        revision === readRevision.current &&
        currentScope.current === `${workspaceId}/${deviceId}`
      ) {
        setGrant(
          body.grants.find(
            (item) =>
              item.deviceId === deviceId &&
              item.enabled &&
              item.profile.network === 'public_https' &&
              item.profile.origins.length === 0,
          ) ?? null,
        );
      }
    },
    [workspaceId, deviceId],
  );
  useEffect(() => {
    readRevision.current += 1;
    setGrant(null);
    setConfirmClear(false);
    setBusy(false);
    setMessage('');
    setError('');
  }, [scope]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void refresh(controller.signal).catch((cause) => {
      if (!controller.signal.aborted && currentScope.current === scope)
        setError(cause.message);
    });
    return () => controller.abort();
  }, [active, refresh, scope]);
  async function clearLogin() {
    if (!grant || busy) return;
    const requestScope = scope;
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
          rememberLogin: true,
        }),
      });
      if (!response.ok) throw Error('设置未保存，请刷新电脑状态后重试。');
      const replacement = (await response.json().catch(() => null)) as Omit<
        Grant,
        'enabled'
      > | null;
      if (currentScope.current !== requestScope) return;
      readRevision.current += 1;
      setGrant(replacement ? { ...replacement, enabled: true } : null);
      setConfirmClear(false);
      setMessage(
        '已切换到空白登录资料；电脑连接后会清理旧资料，并结束正在使用旧登录的浏览器。后续登录仍会保留。',
      );
      await refresh().catch(() => {
        if (currentScope.current === requestScope)
          setError(
            '登录已清除，但电脑状态刷新失败。重新打开此页可查看最新状态。',
          );
      });
    } catch (cause) {
      if (currentScope.current === requestScope)
        setError(
          cause instanceof Error ? cause.message : '设置未保存，请重试。',
        );
    } finally {
      if (currentScope.current === requestScope) setBusy(false);
    }
  }
  return (
    <div className={styles.browserLoginPreferences}>
      {grant && (
        <>
          <div
            className={`${styles.capabilitySetting} ${styles.browserRetention}`}
          >
            <div>
              <strong>浏览器登录</strong>
              <p>
                {grant.persistLogin
                  ? '网站登录保存在这台电脑，供后续任务使用。'
                  : '当前浏览器使用临时登录资料。'}
              </p>
            </div>
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              onClick={() => setConfirmClear(true)}
            >
              清除登录
            </Button>
          </div>
          {confirmClear && (
            <div
              className={styles.computerClearRow}
              role="group"
              aria-label="清除浏览器登录确认"
            >
              <p>
                清除这台电脑的网站登录？之后需要重新登录，后续登录将默认保留。
              </p>
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => setConfirmClear(false)}
              >
                取消
              </Button>{' '}
              <Button
                type="button"
                disabled={busy}
                onClick={() => void clearLogin()}
              >
                {busy ? '正在清除…' : '确认清除'}
              </Button>
            </div>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
