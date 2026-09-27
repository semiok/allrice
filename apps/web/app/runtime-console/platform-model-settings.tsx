'use client';

import { useEffect, useState } from 'react';
import {
  PLATFORM_WORK_MODELS,
  type PlatformModelSettings,
} from '@allrice/contracts';
import styles from './governance-console.module.css';

export function PlatformModelSettingsPanel() {
  const [settings, setSettings] = useState<PlatformModelSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  async function load() {
    const response = await fetch('/api/v1/admin/platform-model-settings', {
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('暂时无法读取平台模型配置');
    setSettings((await response.json()).settings);
  }
  useEffect(() => {
    void load().catch((error) => setNotice(error.message));
  }, []);
  async function save() {
    if (!settings || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch('/api/v1/admin/platform-model-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: settings.revision,
          configuration: settings.configuration,
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error?.message ?? '保存失败，请重试');
      setSettings(body.settings);
      setNotice('已保存，下一次任务开始生效。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  const configuration = settings?.configuration;
  return (
    <section className={styles.quota} aria-label="平台模型配置">
      <h2>平台模型配置</h2>
      <p>所有员工共用下方 Codex 订阅授权，自动使用这里的模型。</p>
      {settings && configuration ? (
        <div className={styles.quotaForm}>
          <label>
            对话与理解
            <select
              aria-label="对话与理解模型"
              value={configuration.workModel}
              disabled={busy}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  configuration: {
                    ...configuration,
                    workModel: event.target
                      .value as typeof configuration.workModel,
                  },
                })
              }
            >
              {PLATFORM_WORK_MODELS.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <label>
            推理强度
            <select
              aria-label="推理强度"
              value={configuration.reasoningEffort}
              disabled={busy}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  configuration: {
                    ...configuration,
                    reasoningEffort: event.target
                      .value as typeof configuration.reasoningEffort,
                  },
                })
              }
            >
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
              <option value="xhigh">超高</option>
            </select>
          </label>
          <label>
            图片生成与编辑
            <select
              aria-label="图片模型"
              value={
                configuration.imagesEnabled ? configuration.imageModel : ''
              }
              disabled={busy}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  configuration: {
                    ...configuration,
                    imagesEnabled: Boolean(event.target.value),
                  },
                })
              }
            >
              <option value="">暂不开启</option>
              <option value="gpt-image-2.5-flare">GPT Image 2.5 Flare</option>
            </select>
          </label>
          <button type="button" disabled={busy} onClick={() => void save()}>
            {busy ? '保存中…' : '保存配置'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void load().catch((error) => setNotice(error.message))
            }
          >
            刷新配置
          </button>
        </div>
      ) : (
        <p>正在读取配置…</p>
      )}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
}
