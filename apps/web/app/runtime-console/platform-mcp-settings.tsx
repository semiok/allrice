'use client';
import { AdminButton } from '../../components/admin/admin-ui';
import { useEffect, useState } from 'react';
import {
  GITHUB_MCP_CALLBACK_PATH,
  type GithubMcpSettings,
} from '@allrice/contracts';
import panelStyles from './platform-mcp-settings.module.css';

export function PlatformMcpSettingsPanel() {
  const [settings, setSettings] = useState<GithubMcpSettings | null>(null);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [callback, setCallback] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void fetch('/api/v1/admin/mcp-apps', {
      cache: 'no-store',
      signal: abort.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw Error('暂时无法读取应用授权配置');
        const { settings: value } = (await response.json()) as {
          settings: GithubMcpSettings;
        };
        setSettings(value);
        setClientId(value.clientId);
        setCallback(
          value.callbackUrl ||
            new URL(GITHUB_MCP_CALLBACK_PATH, window.location.origin).href,
        );
      })
      .catch((error: Error) => {
        if (!abort.signal.aborted) setNotice(error.message);
      });
    return () => abort.abort();
  }, []);
  async function save() {
    if (!settings || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch('/api/v1/admin/mcp-apps', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: settings.revision,
          clientId,
          callbackUrl: callback,
          ...(secret ? { clientSecret: secret } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw Error(
          body.error?.message ?? '保存失败，请检查 Client ID 和 Client Secret',
        );
      setSettings(body.settings);
      setSecret('');
      setNotice('已保存。成员现在可以在“已连接应用”中登录自己的 GitHub 账号。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className={panelStyles.panel}
      aria-label="应用授权配置"
      id="mcp-apps"
    >
      <h1>应用连接</h1>
      <p>
        GitHub 和 Linear 已内置。每位成员连接自己的账号，连接默认仅本人可用。
      </p>
      <section className={panelStyles.app} aria-label="Linear 授权配置">
        <h3>Linear</h3>
        <p>无需平台配置，成员可直接在“已连接应用”中登录授权。</p>
      </section>
      <section className={panelStyles.app} aria-label="GitHub 授权配置">
        <h3>GitHub</h3>
        <p>
          {settings?.ready
            ? '账号登录已配置'
            : '账号登录待配置，可先使用个人访问令牌连接。'}
        </p>
        <details open={!settings?.ready}>
          <summary>创建 AllRice GitHub OAuth App</summary>
          <ol>
            <li>
              打开{' '}
              <a
                href="https://github.com/settings/applications/new"
                target="_blank"
                rel="noreferrer"
              >
                GitHub 创建 OAuth App
              </a>
              ，名称填写 AllRice（Dev）。
            </li>
            <li>Homepage URL 填写当前 AllRice 管理后台地址。</li>
            <li>
              Authorization callback URL
              填写下方回调地址。所有租户共用此地址，无需逐租户登记。
            </li>
            <li>
              注册后复制 Client ID，点击 Generate a new client
              secret，并在下方保存。Dev 和生产环境请分别创建应用。
            </li>
          </ol>
          <p>
            成员授权时申请仓库访问及组织信息读取权限（repo、read:org）。组织可要求管理员批准该应用。
          </p>
        </details>
        {settings && (
          <form
            className={panelStyles.form}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className={panelStyles.callback}>
              <label>
                回调地址
                <input aria-label="GitHub 回调地址" value={callback} readOnly />
              </label>
              <AdminButton
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(callback)
                    .then(() => setNotice('回调地址已复制。'))
                    .catch(() => setNotice('请选中上方回调地址并复制。'));
                }}
              >
                复制回调地址
              </AdminButton>
            </div>
            <label>
              Client ID
              <input
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                autoComplete="off"
                required
                minLength={8}
                maxLength={200}
              />
            </label>
            <label>
              Client Secret
              <input
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="new-password"
                required={
                  !settings.secretConfigured || clientId !== settings.clientId
                }
                minLength={8}
                maxLength={4096}
                placeholder={
                  settings.secretConfigured
                    ? '已保存，留空保留现有密钥'
                    : '填写新生成的密钥'
                }
              />
            </label>
            <p>密钥加密保存，不会显示给成员或发送到聊天。</p>
            <AdminButton type="submit" variant="primary" disabled={busy}>
              {busy ? '正在保存…' : '保存 GitHub 授权配置'}
            </AdminButton>
          </form>
        )}
      </section>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
