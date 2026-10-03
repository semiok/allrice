'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import { browserPrivateSiteAddress } from '@allrice/contracts';
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
  const [siteGrants, setSiteGrants] = useState<Grant[]>([]);
  const [site, setSite] = useState('');
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
      if (!signal?.aborted) {
        setGrant(
          body.grants.find(
            (item) =>
              item.deviceId === deviceId &&
              item.enabled &&
              item.profile.network === 'public_https' &&
              item.profile.origins.length === 0,
          ) ?? null,
        );
        setSiteGrants(
          body.grants.filter(
            (item) =>
              item.deviceId === deviceId &&
              item.enabled &&
              item.profile.origins.length > 0,
          ),
        );
      }
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
  async function manageSite(grantId?: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      let body;
      if (grantId) body = { workspaceId, action: 'revoke', grantId };
      else {
        const url = new URL(site.trim());
        if (url.href !== url.origin + '/' || url.username || url.password)
          throw Error('请填写完整的站点地址和端口，不含路径或密码。');
        body = {
          workspaceId,
          deviceId,
          persistLogin: true,
          profile: {
            version: 1,
            ...(browserPrivateSiteAddress(url.hostname)
              ? { network: 'local_sites' }
              : {}),
            origins: [url.origin],
            allowHumanCredentials: true,
            allowDownloads: true,
            allowUploads: false,
          },
        };
      }
      const response = await fetch('/api/v1/admin/local-browser', {
        method: grantId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok)
        throw Error(
          '未保存。请确认电脑已连接，地址为公网 HTTPS 或内网 IPv4；内网站点还需要新版 Bridge。',
        );
      await refresh();
      setSite('');
      setMessage(
        grantId
          ? '已移除站点，正在使用它的浏览器将结束。'
          : '已添加站点。这台电脑会为它使用独立登录环境，首次登录需要你接管填写。',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '设置未保存，请重试。');
    } finally {
      setBusy(false);
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
              <strong>保留浏览器登录</strong>
              <p>将登录保存在这台电脑的专用浏览器中，供后续任务使用。</p>
            </div>
            <Switch
              label="保留浏览器登录"
              checked={grant.persistLogin}
              disabled={busy}
              onChange={(value) => void save(value)}
            />
          </div>
          <div className={styles.computerClearRow}>
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              onClick={() => void save(grant.persistLogin, true)}
            >
              清除浏览器登录
            </Button>
          </div>
        </>
      )}
      <div className={styles.capabilitySetting}>
        <div>
          <strong>业务站点</strong>
          <p>
            为你指定的公网 HTTPS 站点或内网 IPv4
            地址和端口单独保存登录环境。仅这台电脑可使用，不开放本机服务。
          </p>
          <label>
            业务站点地址
            <Input
              aria-label="业务站点地址"
              value={site}
              onChange={(event) => setSite(event.target.value)}
              placeholder="http://192.168.1.10:8080"
              disabled={busy}
            />
          </label>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !site.trim()}
            onClick={() => void manageSite()}
          >
            添加站点
          </Button>
          {siteGrants.map((item) => (
            <div key={item.grantId}>
              <span>{item.profile.origins.join('、')}</span>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void manageSite(item.grantId)}
              >
                移除站点
              </Button>
            </div>
          ))}
        </div>
      </div>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
