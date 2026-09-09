'use client';
import { useCallback, useEffect, useState } from 'react';
import type { BrowserControlManagement } from '@allrice/database';
import styles from './settings.module.css';
export function BrowserControlSettings({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const [data, setData] = useState<BrowserControlManagement | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    const r = await fetch(
      `/api/v1/admin/browser-control?workspaceId=${workspaceId}`,
      { cache: 'no-store' },
    );
    if (!r.ok) throw Error('无法读取当前云端浏览器授权');
    setData(await r.json());
  }, [workspaceId]);
  useEffect(() => {
    void reload().catch(() => setError('无法读取当前云端浏览器授权'));
  }, [reload]);
  async function mutate(body: unknown) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch(
        `/api/v1/runtime/browser-workspaces?workspaceId=${workspaceId}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-allrice-workspace-id': workspaceId,
          },
          body: JSON.stringify(body),
        },
      );
      if (!r.ok) throw Error('授权未确认，请刷新核实；未自动重复提交。');
      await r.json();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未确认');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.root} aria-label="云端浏览器授权管理">
      <p>
        每个 Run 使用独立临时浏览器，结束后清理。授权仅允许精确站点，不继承个人
        Cookie；文件上传、下载与敏感登录分别选择。登记授权不会启动浏览器，也不会授予员工工具能力。
      </p>
      {error && <p role="alert">{error}</p>}
      <button
        disabled={busy}
        onClick={() => void reload().catch(() => setError('读取失败'))}
      >
        刷新授权
      </button>
      {data && !data.enabled && (
        <p role="status">新浏览器执行尚未启用；历史授权可查看和撤销。</p>
      )}
      {data && (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void mutate({
                kind: 'grant',
                targetId: form.get('target'),
                ownerId: form.get('owner'),
                enabled: true,
                profile: {
                  version: 1,
                  origins: String(form.get('origins'))
                    .split(/\r?\n/)
                    .map((x) => x.trim())
                    .filter(Boolean),
                  allowUploads: form.has('uploads'),
                  allowDownloads: form.has('downloads'),
                  allowHumanCredentials: form.has('credentials'),
                  lifetimeMs: 300000,
                  maximumFileBytes: 1000000,
                },
              });
            }}
          >
            <p>
              <label>
                执行目标
                <select
                  name="target"
                  aria-label="执行目标"
                  required
                  disabled={busy || !data.enabled}
                >
                  {data.targets.map((t) => (
                    <option
                      key={t.id}
                      value={t.id}
                      disabled={t.state !== 'online'}
                    >
                      {t.label} · {t.state}
                    </option>
                  ))}
                </select>
              </label>
            </p>
            <p>
              <label>
                授权使用者
                <select
                  name="owner"
                  aria-label="授权使用者"
                  required
                  disabled={busy || !data.enabled}
                >
                  {data.members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            </p>
            <p>
              <label>
                允许站点（每行一个精确 HTTPS origin）
                <textarea
                  name="origins"
                  required
                  placeholder="https://app.example.com"
                  rows={4}
                  disabled={busy || !data.enabled}
                  style={{
                    display: 'block',
                    width: '100%',
                    boxSizing: 'border-box',
                  }}
                />
              </label>
            </p>
            <p>
              <label>
                <input
                  name="uploads"
                  type="checkbox"
                  disabled={busy || !data.enabled}
                />
                允许上传文件（每次仍须审批）
              </label>
            </p>
            <p>
              <label>
                <input
                  name="downloads"
                  type="checkbox"
                  disabled={busy || !data.enabled}
                />
                允许下载工件
              </label>
            </p>
            <p>
              <label>
                <input
                  name="credentials"
                  type="checkbox"
                  disabled={
                    busy || !data.enabled || !data.humanCredentialsConfigured
                  }
                />
                允许人工敏感登录（短期加密输入）
              </label>
            </p>
            {!data.humanCredentialsConfigured && (
              <p>管理员尚未配置专用敏感输入加密密钥，此能力不可用。</p>
            )}
            <button
              type="submit"
              disabled={
                busy ||
                !data.enabled ||
                !data.targets.some((t) => t.state === 'online')
              }
            >
              创建精确站点授权
            </button>
          </form>
          {data.grants.map((g) => (
            <article key={g.id} aria-label="云端浏览器授权记录">
              <h2>
                {data.members.find((m) => m.id === g.ownerId)?.name ??
                  g.ownerId}
              </h2>
              <p>{g.profile.origins.join('、')}</p>
              <p>
                {g.revokedAt
                  ? '授权已撤销'
                  : g.enabled
                    ? '已登记 · 执行仍受员工/Run/逐次审批约束'
                    : '未启用'}
              </p>
              <p>
                上传：{g.profile.allowUploads ? '允许' : '禁止'} · 下载：
                {g.profile.allowDownloads ? '允许' : '禁止'} · 敏感登录：
                {g.profile.allowHumanCredentials ? '允许' : '禁止'}
              </p>
              <button
                disabled={busy || !!g.revokedAt}
                onClick={() => void mutate({ kind: 'revoke_grant', id: g.id })}
              >
                撤销授权
              </button>
              <p>撤销立即阻止新动作；已开始的 I/O 必须等待实际停止回执。</p>
            </article>
          ))}
        </>
      )}
    </section>
  );
}
