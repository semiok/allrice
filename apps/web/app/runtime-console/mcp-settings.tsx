'use client';

import { useEffect, useState } from 'react';
import type { McpConnection } from '@allrice/contracts';

import styles from './mcp-settings.module.css';

const endpoint = '/api/v1/admin/mcp';
type Risk = McpConnection['tools'][number]['risk'];
export function McpSettings({ workspaceId }: { workspaceId: string }) {
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [rotateId, setRotateId] = useState<string | null>(null);
  const [rotation, setRotation] = useState('');
  const [risks, setRisks] = useState<Record<string, Risk>>({});
  useEffect(() => {
    const controller = new AbortController();
    setConnections([]);
    setEnabled(false);
    setError('');
    fetch(`${endpoint}?workspaceId=${encodeURIComponent(workspaceId)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error?.message ?? '无法读取 MCP 配置。');
        if (!controller.signal.aborted) {
          setConnections(body.connections);
          setEnabled(body.enabled);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : '无法读取 MCP 配置。',
          );
      });
    return () => controller.abort();
  }, [workspaceId, refresh]);
  async function mutate(
    method: 'POST' | 'PATCH',
    payload: Record<string, unknown>,
  ) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, ...payload }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? '操作失败。');
      setRefresh((value) => value + 1);
      setToken('');
      setRotation('');
      setRotateId(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作失败。');
    } finally {
      setBusy(false);
      setToken('');
      setRotation('');
    }
  }
  return (
    <section className={styles.panel} aria-label="云端 MCP 连接">
      <div className={styles.header}>
        <h3>云端 MCP</h3>
        <button
          type="button"
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          刷新
        </button>
      </div>
      <p>
        租户专用服务凭证 · Streamable HTTP
        2025-11-25。连接成功不会授予工具权限；每个工具须单独授权。暂不支持 OAuth
        和本地 stdio。
      </p>
      {!enabled ? (
        <p role="status">此环境尚未启用云端 MCP，不能创建或执行连接。</p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void mutate('POST', { name, endpoint: url, bearerToken: token });
        }}
        className={styles.form}
      >
        <label>
          连接名称
          <input
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          HTTPS MCP 地址
          <input
            required
            type="url"
            value={url}
            placeholder="https://mcp.example.com/mcp"
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <label>
          租户 Bearer Token
          <input
            required
            type="password"
            autoComplete="new-password"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={4096}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <button disabled={!enabled || busy} type="submit">
          保存连接
        </button>
      </form>
      {connections.map((connection) => (
        <article key={connection.id} className={styles.connection}>
          <div className={styles.header}>
            <strong>{connection.name}</strong>
            <span>
              {connection.enabled ? '已配置' : '已撤销'} ·{' '}
              {connection.discoveryState}
            </span>
          </div>
          <p>{connection.endpoint}</p>
          <p>
            员工连接引用：<code>{`mcp.${connection.id}`}</code>
          </p>
          <p>
            另需员工版本显式绑定该连接并授权 cloud.mcp.call；只影响新
            Run，不扩大已运行会话的权限。
          </p>
          <p>凭证已加密保存，不回显。{connection.discoveryCode ?? ''}</p>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={!enabled || busy || !connection.enabled}
              onClick={() =>
                void mutate('PATCH', {
                  action: 'discover',
                  connectionId: connection.id,
                })
              }
            >
              发现 / 刷新工具
            </button>
            <button
              type="button"
              disabled={!enabled || busy || !connection.enabled}
              onClick={() => setRotateId(connection.id)}
            >
              替换凭证
            </button>
            <button
              type="button"
              disabled={!enabled || busy || !connection.enabled}
              onClick={() =>
                void mutate('PATCH', {
                  action: 'revoke',
                  connectionId: connection.id,
                })
              }
            >
              撤销连接
            </button>
          </div>
          {rotateId === connection.id ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void mutate('PATCH', {
                  action: 'rotate',
                  connectionId: connection.id,
                  bearerToken: rotation,
                });
              }}
              className={styles.form}
            >
              <label>
                新凭证
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  value={rotation}
                  onChange={(event) => setRotation(event.target.value)}
                />
              </label>
              <button type="submit" disabled={busy}>
                替换并撤销旧工具授权
              </button>
            </form>
          ) : null}
          {connection.tools.map((tool) => (
            <div key={tool.revisionId} className={styles.tool}>
              <strong>{tool.name}</strong>
              <span>
                {tool.available
                  ? tool.allowed
                    ? '已授权'
                    : '未授权'
                  : '已不可用'}
              </span>
              <p>{tool.description}</p>
              <label>
                管理员判定风险
                <select
                  value={risks[tool.revisionId] ?? tool.risk}
                  disabled={busy}
                  onChange={(event) =>
                    setRisks((current) => ({
                      ...current,
                      [tool.revisionId]: event.target.value as Risk,
                    }))
                  }
                >
                  <option value="read_only">只读</option>
                  <option value="write">写入</option>
                  <option value="external_send">对外发送</option>
                  <option value="high_risk_data">高风险数据</option>
                </select>
              </label>
              <button
                type="button"
                disabled={
                  !enabled || busy || !connection.enabled || !tool.available
                }
                onClick={() =>
                  void mutate('PATCH', {
                    action: 'grant',
                    connectionId: connection.id,
                    revisionId: tool.revisionId,
                    allowed: !tool.allowed,
                    risk: risks[tool.revisionId] ?? tool.risk,
                  })
                }
              >
                {tool.allowed ? '撤销此工具' : '授权此工具'}
              </button>
            </div>
          ))}
        </article>
      ))}
    </section>
  );
}
