'use client';

import { useEffect, useState } from 'react';
import type { McpConnection, McpEmployeeTarget } from '@allrice/contracts';

import styles from './mcp-settings.module.css';

const endpoint = '/api/v1/admin/mcp';
type Risk = McpConnection['tools'][number]['risk'];
export function McpSettings({ workspaceId }: { workspaceId: string }) {
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [employees, setEmployees] = useState<McpEmployeeTarget[]>([]);
  const [selectedEmployees, setSelectedEmployees] = useState<
    Record<string, string>
  >({});
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
    setEmployees([]);
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
          setEmployees(body.employees ?? []);
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
        2025-11-25。连接成功不会授予工具权限；每个工具须单独授权。暂不支持
        OAuth。 本地 stdio 在独立的本地 MCP 区域登记与授权。
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
            仅已发布且明确许可 cloud.mcp.call、Service 身份以及
            secret:use/network:outbound 的员工可绑定。
            不符合资格时须由平台保存新草稿、试用并发布；这里不会修改员工策略或解除禁止权限。
          </p>
          <section aria-label={`员工版本授权 ${connection.name}`}>
            <h4>员工版本授权</h4>
            <p>
              仅限此连接与确切员工版本。新增授权只影响新
              Run；每次调用仍须审批。撤销会阻止旧 Run
              后续派发，已发送的远端操作不保证立即停止。
            </p>
            <label>
              选择员工版本
              <select
                aria-label={`选择员工版本 ${connection.name}`}
                value={selectedEmployees[connection.id] ?? ''}
                onChange={(event) =>
                  setSelectedEmployees((previous) => ({
                    ...previous,
                    [connection.id]: event.target.value,
                  }))
                }
              >
                <option value="">请选择已获许可的版本</option>
                {employees.map((employee) => (
                  <option
                    key={employee.employeeVersionId}
                    value={employee.employeeVersionId}
                    disabled={!employee.eligible}
                  >
                    {employee.name} · v{employee.version}
                    {employee.eligible
                      ? ''
                      : `（${employee.reasons.join('；')}）`}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={
                !enabled ||
                busy ||
                !connection.enabled ||
                !selectedEmployees[connection.id]
              }
              onClick={() => {
                const employee = employees.find(
                  (e) =>
                    e.employeeVersionId === selectedEmployees[connection.id],
                );
                if (!employee?.eligible) return;
                const binding = employee.bindings.find(
                  (b) => b.connectionId === connection.id,
                );
                void mutate('PATCH', {
                  action: 'employee_binding',
                  connectionId: connection.id,
                  employeeId: employee.employeeId,
                  employeeVersionId: employee.employeeVersionId,
                  expectedRevision: binding?.revision ?? 0,
                  enabled: true,
                });
              }}
            >
              绑定此连接
            </button>
            {!employees.some((employee) => employee.eligible) ? (
              <p role="status">
                当前没有可绑定的员工版本。需先发布具备上述 MCP
                策略的员工，不会自动扩展现有员工权限。
              </p>
            ) : null}
            {employees
              .filter((e) => !e.eligible)
              .map((e) => (
                <p key={e.employeeVersionId}>
                  {e.name} · v{e.version}：{e.reasons.join('；')}
                </p>
              ))}
            {employees.flatMap((employee) =>
              employee.bindings
                .filter((b) => b.connectionId === connection.id)
                .map((binding) => (
                  <div key={binding.id}>
                    <span>
                      {employee.name} · v{employee.version} ·{' '}
                      {binding.enabled ? '已绑定' : '已撤销'} · 授权版本{' '}
                      {binding.revision}
                    </span>
                    {binding.enabled ? (
                      <button
                        type="button"
                        disabled={!enabled || busy}
                        onClick={() =>
                          void mutate('PATCH', {
                            action: 'employee_binding',
                            connectionId: connection.id,
                            employeeId: employee.employeeId,
                            employeeVersionId: employee.employeeVersionId,
                            expectedRevision: binding.revision,
                            enabled: false,
                          })
                        }
                      >
                        撤销员工绑定
                      </button>
                    ) : null}
                  </div>
                )),
            )}
          </section>
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
