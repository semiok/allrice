'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  McpConnectionSchema,
  UuidSchema,
  MCP_APPS,
  type McpAppId,
  type McpConnection,
} from '@allrice/contracts';
import styles from './connected-apps.module.css';
import {
  connectionStatusLabel,
  visibleConnection,
} from '../../../lib/connection-status';

export function ConnectedApps({
  workspaceId,
  connectionId,
}: {
  workspaceId: string;
  connectionId?: string | undefined;
}) {
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [credentialId, setCredentialId] = useState('');
  const [credential, setCredential] = useState('');
  const [githubOAuthReady, setGithubOAuthReady] = useState(false);
  const [presetToken, setPresetToken] = useState<McpAppId | null>(null);
  const [pendingLogin, setPendingLogin] = useState<string | null>(null);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(
        `/api/v1/connections?workspaceId=${workspaceId}`,
        { cache: 'no-store', ...(signal ? { signal } : {}) },
      );
      const body = await response.json();
      if (!response.ok)
        throw Error(body.error?.message ?? '暂时无法读取应用连接');
      setConnections(McpConnectionSchema.array().parse(body.connections));
      setGithubOAuthReady(body.apps?.github?.oauthReady === true);
      setLoading(false);
    },
    [workspaceId],
  );
  useEffect(() => {
    const abort = new AbortController();
    setConnections([]);
    setLoading(true);
    setCredential('');
    setCredentialId('');
    setPresetToken(null);
    setPendingLogin(null);
    setError('');
    void refresh(abort.signal).catch((e: Error) => {
      if (!abort.signal.aborted) {
        setError(e.message);
        setLoading(false);
      }
    });
    return () => abort.abort();
  }, [refresh]);
  // Refresh only while a connection is being established. Keep existing cards
  // mounted instead of replacing the page with a flashing loading state.
  useEffect(() => {
    if (
      !connections.some(
        (c) =>
          !c.disconnected && ['queued', 'running'].includes(c.discoveryState),
      )
    )
      return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void refresh(abort.signal).catch(() => {});
    }, 1500);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [connections, refresh]);
  useEffect(() => {
    if (!pendingLogin) return;
    const connection = connections.find((c) => c.id === pendingLogin);
    if (connection?.loginState === 'redirect') {
      setPendingLogin(null);
      window.location.assign(
        `/api/v1/connections/authorize?workspaceId=${workspaceId}&connectionId=${connection.id}`,
      );
    } else if (
      connection?.loginState === 'error' ||
      connection?.discoveryState === 'error'
    ) {
      setPendingLogin(null);
    }
  }, [connections, pendingLogin, workspaceId]);
  function returnSession() {
    const id = UuidSchema.safeParse(
      new URLSearchParams(window.location.search).get('session'),
    ).data;
    return id ? { returnSessionId: id } : {};
  }
  async function connectApp(appId: McpAppId, method: 'oauth' | 'token') {
    if (busy) return;
    setBusy(appId);
    setError('');
    try {
      const response = await fetch('/api/v1/connections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          appId,
          method,
          ...(method === 'token'
            ? { bearerToken: credential }
            : returnSession()),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw Error(body.error?.message ?? '连接操作未完成');
      setCredential('');
      setPresetToken(null);
      if (method === 'oauth') setPendingLogin(body.connection.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '连接操作未完成');
    } finally {
      setBusy(null);
    }
  }
  async function mutate(
    connection: McpConnection,
    action: 'disconnect' | 'reconnect' | 'credential' | 'login' | 'delete',
  ) {
    if (busy) return;
    setBusy(connection.id);
    setError('');
    try {
      const response = await fetch('/api/v1/connections', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          workspaceId,
          connectionId: connection.id,
          ...(action === 'credential' ? { bearerToken: credential } : {}),
          ...(action === 'login' ? returnSession() : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw Error(body.error?.message ?? '连接操作未完成');
      if (action === 'login') setPendingLogin(connection.id);
      setCredential('');
      setCredentialId('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '连接操作未完成');
    } finally {
      setBusy(null);
    }
  }
  const visible = connections.filter(
    (c) => visibleConnection(c) || c.id === connectionId,
  );
  return (
    <section className={styles.apps} aria-label="已连接应用">
      <p>
        连接你的应用，让员工在你的授权范围内使用。个人连接仅你可用，断开共享应用只影响你自己。
      </p>
      {!loading && (
        <div className={styles.presets} aria-label="默认应用">
          {(
            Object.entries(MCP_APPS) as [
              McpAppId,
              (typeof MCP_APPS)[McpAppId],
            ][]
          ).map(([appId, app]) => {
            const added = connections.some(
              (c) => !c.shared && !c.removed && c.endpoint === app.endpoint,
            );
            return (
              <div className={styles.card} key={appId}>
                <h2>{app.name}</h2>
                <p>{app.description}</p>
                {added ? (
                  <p>已添加，可在下方管理连接。</p>
                ) : (
                  <>
                    <div className={styles.actions}>
                      {(appId === 'linear' || githubOAuthReady) && (
                        <button
                          disabled={!!busy}
                          onClick={() => void connectApp(appId, 'oauth')}
                        >
                          连接 {app.name}
                        </button>
                      )}
                      <button
                        disabled={!!busy}
                        onClick={() => {
                          setPresetToken(appId);
                          setCredential('');
                          setCredentialId('');
                        }}
                      >
                        {appId === 'github' && !githubOAuthReady
                          ? '使用访问令牌连接'
                          : '使用访问令牌'}
                      </button>
                    </div>
                    {appId === 'github' && !githubOAuthReady && (
                      <p>
                        GitHub
                        账号登录待平台配置。现在可使用自己的访问令牌连接。
                      </p>
                    )}
                    {presetToken === appId && (
                      <form
                        className={styles.credential}
                        onSubmit={(event) => {
                          event.preventDefault();
                          void connectApp(appId, 'token');
                        }}
                      >
                        <label>
                          {app.name} 访问令牌
                          <input
                            type="password"
                            value={credential}
                            onChange={(event) =>
                              setCredential(event.target.value)
                            }
                            minLength={8}
                            maxLength={4096}
                            autoComplete="off"
                            required
                          />
                        </label>
                        <p>
                          <a
                            href={app.tokenUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            在 {app.name} 创建访问令牌
                          </a>
                          ，选择需要访问的仓库或工作区。令牌只保存在连接凭据中，不发送到聊天。
                        </p>
                        <button disabled={!!busy || !credential}>
                          保存并连接
                        </button>
                        <button
                          type="button"
                          disabled={!!busy}
                          onClick={() => {
                            setPresetToken(null);
                            setCredential('');
                          }}
                        >
                          取消
                        </button>
                      </form>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      <button
        type="button"
        disabled={loading || refreshing || !!busy}
        onClick={async () => {
          setRefreshing(true);
          setError('');
          try {
            await refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : '暂时无法读取应用连接');
          } finally {
            setRefreshing(false);
          }
        }}
      >
        {refreshing ? '正在刷新…' : '刷新连接状态'}
      </button>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p>正在读取应用连接…</p>
      ) : !visible.length ? (
        <p>
          还没有连接应用。选择上方应用开始连接，其他服务也可以在聊天中告诉员工。
        </p>
      ) : null}
      {visible.map((c) => (
        <article
          key={c.id}
          className={styles.card}
          aria-label={
            c.id === connectionId ? '当前任务需要连接的应用' : undefined
          }
        >
          <div className={styles.heading}>
            <h2>{c.name}</h2>
            <span>{connectionStatusLabel(c)}</span>
          </div>
          <p>
            {new URL(c.endpoint).hostname} ·{' '}
            {c.shared ? '工作区共享' : '个人连接'}
          </p>
          <div className={styles.actions}>
            {c.managed &&
              !c.disconnected &&
              c.enabled &&
              (!c.credentialConfigured || c.discoveryState === 'error') &&
              (c.endpoint !== MCP_APPS.github.endpoint || githubOAuthReady) &&
              (c.loginState === 'redirect' ? (
                <a
                  href={`/api/v1/connections/authorize?workspaceId=${workspaceId}&connectionId=${c.id}`}
                >
                  继续账号登录
                </a>
              ) : (
                <button
                  disabled={
                    !!busy || ['preparing', 'exchanging'].includes(c.loginState)
                  }
                  onClick={() => void mutate(c, 'login')}
                >
                  {['preparing', 'exchanging'].includes(c.loginState)
                    ? '正在准备登录…'
                    : '使用账号登录'}
                </button>
              ))}
            {c.disconnected || !c.enabled ? (
              <button
                disabled={!!busy || !c.enabled}
                onClick={() => void mutate(c, 'reconnect')}
              >
                重新连接
              </button>
            ) : null}
          </div>
          {c.managed &&
            !c.disconnected &&
            c.endpoint === MCP_APPS.github.endpoint &&
            !githubOAuthReady &&
            !c.credentialConfigured && (
              <p>请在“管理连接”中填写 GitHub 访问令牌。</p>
            )}
          {c.loginState === 'error' && (
            <p role="status">账号登录未完成，请重试登录或使用访问令牌。</p>
          )}
          <details className={styles.manage}>
            <summary>管理连接</summary>
            <div className={styles.actions}>
              {c.managed &&
                !c.disconnected &&
                c.enabled &&
                !['preparing', 'exchanging'].includes(c.loginState) &&
                (c.endpoint !== MCP_APPS.github.endpoint ||
                  githubOAuthReady) && (
                  <button
                    disabled={!!busy}
                    onClick={() => void mutate(c, 'login')}
                  >
                    重新账号登录
                  </button>
                )}
              {!c.disconnected && c.enabled && (
                <button
                  disabled={!!busy}
                  onClick={() => void mutate(c, 'disconnect')}
                >
                  断开连接
                </button>
              )}
              {c.managed && !c.disconnected && (
                <button
                  disabled={!!busy}
                  onClick={() => {
                    setCredentialId(c.id);
                    setPresetToken(null);
                    setCredential('');
                  }}
                >
                  {c.credentialConfigured ? '更新凭据' : '填写连接凭据'}
                </button>
              )}
              {!c.removed && (
                <button
                  disabled={!!busy}
                  onClick={() => void mutate(c, 'delete')}
                >
                  删除连接
                </button>
              )}
            </div>
            {credentialId === c.id && c.managed && !c.disconnected && (
              <form
                className={styles.credential}
                onSubmit={(e) => {
                  e.preventDefault();
                  void mutate(c, 'credential');
                }}
              >
                <label>
                  应用访问令牌
                  <input
                    type="password"
                    value={credential}
                    onChange={(e) => setCredential(e.target.value)}
                    autoComplete="off"
                    minLength={8}
                    maxLength={4096}
                    required
                  />
                </label>
                <p>
                  适用于提供访问令牌的应用。只保存在连接凭据中，不发送到聊天。连接成功后员工会继续当前任务。
                </p>
                <button disabled={!!busy || !credential}>保存并连接</button>
              </form>
            )}
          </details>
        </article>
      ))}
    </section>
  );
}
