'use client';
import { useEffect, useState } from 'react';
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  BridgeSandboxNetworkSettingsSchema,
  UpdateBridgeSandboxNetworkSchema,
} from '@allrice/contracts';
import type { z } from 'zod';
import styles from './sidebar-settings.module.css';

type Settings = z.infer<typeof BridgeSandboxNetworkSettingsSchema>;
export function SandboxNetworkSettings({
  workspaceId,
  deviceId,
  active,
}: {
  workspaceId: string;
  deviceId: string;
  active: boolean;
}) {
  const [settings, setSettings] = useState<Settings | null>(null),
    [enabled, setEnabled] = useState(false),
    [origins, setOrigins] = useState(''),
    [transfer, setTransfer] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const url = `/api/v1/bridge/devices/${deviceId}/sandbox-network?workspaceId=${workspaceId}`;
  useEffect(() => {
    setSettings(null);
    setError('');
    if (!active) return;
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(url, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (response.status === 404) return;
      if (!response.ok) throw Error('暂时无法读取沙箱联网设置。');
      const value = BridgeSandboxNetworkSettingsSchema.parse(
        await response.json(),
      );
      if (controller.signal.aborted) return;
      setSettings(value);
      setEnabled(value.enabled);
      setTransfer(value.profile?.allowInputTransfer ?? false);
      setOrigins(value.profile?.origins.join('\n') ?? '');
    })().catch(() => {
      if (!controller.signal.aborted)
        setError('暂时无法读取沙箱联网设置，请重新打开设置后重试。');
    });
    return () => controller.abort();
  }, [active, url]);
  async function save() {
    if (busy || !settings) return;
    const input = UpdateBridgeSandboxNetworkSchema.safeParse({
      expectedVersion: settings.version,
      enabled,
      profile: {
        version: 1,
        mode: 'controlled_https',
        origins: origins.split(/\s+/).filter(Boolean),
        allowInputTransfer: transfer,
      },
    });
    if (!input.success) {
      setError(
        '请填写 1–32 个完整 HTTPS 地址，每行一个，例如 https://pypi.org，不含路径或通配符。',
      );
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch(url, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input.data),
        }),
        value = await response.json();
      if (!response.ok)
        throw Error(value.error?.message ?? '设置未保存，请重试。');
      setSettings(BridgeSandboxNetworkSettingsSchema.parse(value));
    } catch (e) {
      setError(e instanceof Error ? e.message : '设置未保存，请重试。');
    } finally {
      setBusy(false);
    }
  }
  if (!settings) return error ? <p role="alert">{error}</p> : null;
  return (
    <details className={styles.sandboxNetwork}>
      <summary>
        <span>沙箱联网</span>
        <small>{settings.enabled ? '已开启' : '未开启'}</small>
        <IconChevronDownOutlineRegular size={14} />
      </summary>
      <p>
        允许这台电脑的沙箱访问指定网站，用于下载依赖或调用服务。文件夹和浏览器授权不会自动开启此权限。
      </p>
      <fieldset disabled={busy}>
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          允许访问指定网站
        </label>
        <label>
          允许的 HTTPS 地址
          <textarea
            rows={4}
            value={origins}
            onChange={(e) => setOrigins(e.target.value)}
            placeholder={'https://pypi.org\nhttps://files.pythonhosted.org'}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={transfer}
            onChange={(e) => setTransfer(e.target.checked)}
          />
          允许任务输入文件的内容发送到这些网站
        </label>
        <small>
          保存变更后，旧授权下的联网操作会停止。需要支持沙箱联网的新版 Bridge。
        </small>
        <button type="button" onClick={() => void save()}>
          {busy ? '正在保存…' : '保存联网设置'}
        </button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
