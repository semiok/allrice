'use client';

import { useCallback, useEffect, useState } from 'react';
import { McpConnectionSchema, type McpConnection } from '@allrice/contracts';
import styles from './connected-apps.module.css';

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
      setLoading(false);
    },
    [workspaceId],
  );
  useEffect(() => {
    const abort = new AbortController();
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
        }),
      });
      const body = await response.json();
      if (!response.ok) throw Error(body.error?.message ?? '连接操作未完成');
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
    (c) => (!c.removed && (c.enabled || !c.shared)) || c.id === connectionId,
  );
  return (
    <section className={styles.apps} aria-label="已连接应用">
      <p>
        让员工连接你需要的应用，在这里查看和管理。断开共享应用只影响你自己。
      </p>
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
        <p>还没有连接应用。告诉员工你想使用哪个服务，或提供服务地址即可。</p>
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
            <span>
              {c.disconnected || !c.enabled
                ? '已断开'
                : c.discoveryState === 'ready'
                  ? '已连接'
                  : c.discoveryCode === 'MCP_AUTH_REQUIRED'
                    ? '需要登录'
                    : ['queued', 'running'].includes(c.discoveryState)
                      ? '正在连接'
                      : '连接未完成'}
            </span>
          </div>
          <p>
            {new URL(c.endpoint).hostname} ·{' '}
            {c.shared ? '工作区共享' : '个人连接'}
          </p>
          <div className={styles.actions}>
            {c.managed &&
              !c.disconnected &&
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
            ) : (
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
        </article>
      ))}
    </section>
  );
}
