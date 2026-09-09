'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  canonicalRuntimeBridgeJson,
  type LocalMcpConnection,
  type McpEmployeeTarget,
  type BridgeDevice,
  type BridgeFolderGrant,
} from '@allrice/contracts';
import styles from './mcp-settings.module.css';
type Device = BridgeDevice & { folderGrants: BridgeFolderGrant[] };
const endpoint = '/api/v1/admin/local-mcp';
export function LocalMcpSettings({ workspaceId }: { workspaceId: string }) {
  const [connections, setConnections] = useState<LocalMcpConnection[]>([]),
    [employees, setEmployees] = useState<McpEmployeeTarget[]>([]),
    [devices, setDevices] = useState<Device[]>([]),
    [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [refresh, setRefresh] = useState(0);
  const [name, setName] = useState(''),
    [deviceId, setDeviceId] = useState(''),
    [grantId, setGrantId] = useState(''),
    [path, setPath] = useState('.'),
    [source, setSource] = useState(
      '{"name":"example-mcp","version":"1.0.0","entrypoint":"server.cjs","files":[{"path":"server.cjs","sha256":"sha256:替换为实际文件校验和"}]}',
    ),
    [credentialId, setCredentialId] = useState(''),
    [credentialRevision, setCredentialRevision] = useState('1'),
    [edit, setEdit] = useState<LocalMcpConnection | null>(null),
    [selected, setSelected] = useState<Record<string, string>>({});
  useEffect(() => {
    const abort = new AbortController();
    setError('');
    setConnections([]);
    setEmployees([]);
    setDevices([]);
    setEnabled(false);
    fetch(`${endpoint}?workspaceId=${encodeURIComponent(workspaceId)}`, {
      cache: 'no-store',
      signal: abort.signal,
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw Error(body.error?.message ?? '本地 MCP 配置读取失败');
        if (!abort.signal.aborted) {
          setConnections(body.connections);
          setEmployees(body.employees);
          setDevices(body.devices);
          setEnabled(body.enabled);
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : '读取失败');
      });
    return () => abort.abort();
  }, [workspaceId, refresh]);
  async function mutate(
    method: 'POST' | 'PATCH',
    payload: Record<string, unknown>,
  ) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, ...payload }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error?.message ?? '配置未保存');
      setRefresh((n) => n + 1);
      setNotice('配置已保存；不代表已经启动或获准执行');
      setEdit(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    try {
      const raw = JSON.parse(source) as Record<string, unknown>;
      delete raw.digest;
      const digest = `sha256:${Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(canonicalRuntimeBridgeJson(raw)),
          ),
        ),
      )
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')}`;
      const configuration = {
        path,
        source: { ...raw, digest },
        credential: credentialId
          ? { id: credentialId, revision: Number(credentialRevision) }
          : null,
      };
      await mutate(
        edit ? 'PATCH' : 'POST',
        edit
          ? {
              action: 'replace',
              connectionId: edit.id,
              expectedRevision: edit.revision,
              configuration,
            }
          : { name, deviceId, folderGrantId: grantId, configuration },
      );
    } catch {
      setError('来源清单不是有效 JSON，或校验和计算失败。');
    }
  }
  function editConnection(c: LocalMcpConnection) {
    setEdit(c);
    setName(c.name);
    setDeviceId(c.deviceId);
    setGrantId(c.folderGrantId);
    setPath(c.configuration.path);
    setSource(JSON.stringify(c.configuration.source, null, 2));
    setCredentialId(c.configuration.credential?.id ?? '');
    setCredentialRevision(String(c.configuration.credential?.revision ?? 1));
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice('已复制');
    } catch {
      setError('复制失败，请手动选择文字复制');
    }
  }
  return (
    <section className={styles.panel} aria-label="本地 MCP 连接">
      <div className={styles.header}>
        <h3>本地 MCP · Bridge 隔离进程</h3>
        <button disabled={busy} onClick={() => setRefresh((n) => n + 1)}>
          刷新
        </button>
      </div>
      <p>
        只在你绑定的设备与授权目录副本中运行 Node stdio
        服务。首版无网络、不运行宿主
        Shell、不自动安装包；每次发现或调用均须单独批准。云端 MCP
        在上方单独管理。
      </p>
      <p>
        源码和数据仅来自完整校验和清单（最多 64 文件 / 256
        KiB）。本地凭证只保存在设备；这里登记的是引用，不证明密钥已配置。发现结果、工具输出会回传
        SaaS 并用于模型上下文，请勿包含未授权私密资料。
      </p>
      {!enabled && (
        <p role="status">此环境未启用本地 MCP。仍可查看或撤销已有授权。</p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          连接名称
          <input
            aria-label="连接名称"
            required
            value={name}
            disabled={Boolean(edit)}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          执行设备
          <select
            aria-label="执行设备"
            required
            value={deviceId}
            disabled={Boolean(edit)}
            onChange={(e) => {
              setDeviceId(e.target.value);
              setGrantId('');
            }}
          >
            <option value="">选择自己的 Bridge</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · {d.status === 'online' ? '在线' : '离线'}
              </option>
            ))}
          </select>
        </label>
        <label>
          授权目录
          <select
            aria-label="授权目录"
            required
            value={grantId}
            disabled={Boolean(edit)}
            onChange={(e) => setGrantId(e.target.value)}
          >
            <option value="">选择已授权目录</option>
            {devices
              .find((d) => d.id === deviceId)
              ?.folderGrants.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
          </select>
        </label>
        <label>
          目录内相对路径
          <input
            aria-label="目录内相对路径"
            required
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
        </label>
        <label className={styles.wide}>
          固定来源与完整文件校验和 JSON
          <textarea
            aria-label="固定来源与完整文件校验和 JSON"
            required
            rows={8}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label>
          本地凭证引用 UUID（可空）
          <input
            aria-label="本地凭证引用 UUID（可空）"
            value={credentialId}
            onChange={(e) => setCredentialId(e.target.value)}
            autoComplete="off"
            placeholder="不是 API Key"
          />
        </label>
        <label>
          凭证引用版本
          <input
            aria-label="凭证引用版本"
            type="number"
            min={1}
            value={credentialRevision}
            onChange={(e) => setCredentialRevision(e.target.value)}
          />
        </label>
        <button disabled={!enabled || busy} type="submit">
          {edit ? '保存新版本并撤销旧工具授权' : '登记本地连接'}
        </button>
        {edit && (
          <button type="button" onClick={() => setEdit(null)}>
            取消编辑
          </button>
        )}
      </form>
      {connections.map((c) => {
        const selectedEmployee = employees.find(
          (e) => e.employeeVersionId === selected[c.id],
        );
        return (
          <article className={styles.connection} key={c.id}>
            <div className={styles.header}>
              <strong>
                {c.name} · r{c.revision}
              </strong>
              <span>{c.enabled ? '已登记' : '已撤销'}</span>
            </div>
            <p>
              {c.deviceName} · {c.configuration.source.name}@
              {c.configuration.source.version} · {c.configuration.path}/
              {c.configuration.source.entrypoint}
            </p>
            <small>{c.configuration.source.digest}</small>
            <p>
              发现状态：
              {c.discoveryState === 'ready'
                ? '已发现；仍需授权工具'
                : c.discoveryState === 'idle'
                  ? '尚未发现'
                  : c.discoveryState}{' '}
              · 凭证：
              {c.configuration.credential
                ? '仅登记本地引用，需在设备配置'
                : '此连接不使用凭证'}
            </p>
            <div className={styles.actions}>
              <button
                disabled={!enabled || busy || !c.enabled}
                onClick={() => editConnection(c)}
              >
                修改来源 / 凭证版本
              </button>
              <button
                disabled={busy || !c.enabled}
                onClick={() =>
                  void mutate('PATCH', {
                    action: 'revoke',
                    connectionId: c.id,
                    expectedRevision: c.revision,
                  })
                }
              >
                撤销连接
              </button>
              <button
                onClick={() =>
                  void copy(
                    `请通过 local.mcp.discover 发现已绑定的本地 MCP 连接 ${c.id} 的工具；不要安装其他软件或调用工具。`,
                  )
                }
              >
                复制发现请求
              </button>
              <Link href="/chatflow">进入工作台</Link>
            </div>
            <p>
              先为下面的员工版本绑定连接，再进入该员工的聊天发送发现请求并批准一次启动。发现成功后在此刷新并授权工具；下一条新任务才采用新工具，当前任务不扩权。
            </p>
            {c.configuration.credential && (
              <details>
                <summary>设备凭证设置 / 撤销命令（不含密钥）</summary>
                <p>
                  先退出 Bridge；此显式模式使用 0700/0600 私有文件，未加密、不是
                  Keychain。set
                  仅从标准输入接收密钥，不把密钥放进命令参数。撤销云连接和删除本地凭证是两个操作。
                </p>
                <pre>{`RiceBridge local-mcp credential set ${c.id} ${c.configuration.source.digest} ${c.configuration.credential.id} ${c.configuration.credential.revision} --private-file-unencrypted`}</pre>
                <pre>{`RiceBridge local-mcp credential revoke ${c.id} ${c.configuration.source.digest} ${c.configuration.credential.id} ${c.configuration.credential.revision} --private-file-unencrypted`}</pre>
              </details>
            )}
            <label>
              绑定员工版本
              <select
                aria-label={`绑定员工版本 ${c.name}`}
                value={selected[c.id] ?? ''}
                onChange={(e) =>
                  setSelected((s) => ({ ...s, [c.id]: e.target.value }))
                }
              >
                <option value="">选择已发布且具备本地 MCP 策略的版本</option>
                {employees.map((e) => (
                  <option
                    key={e.employeeVersionId}
                    value={e.employeeVersionId}
                    disabled={!e.eligible}
                  >
                    {e.name} v{e.version}
                    {e.eligible ? '' : ` · ${e.reasons.join('；')}`}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={
                !enabled || busy || !c.enabled || !selectedEmployee?.eligible
              }
              onClick={() => {
                if (!selectedEmployee) return;
                const old = selectedEmployee.bindings.find(
                  (b) => b.connectionId === c.id,
                );
                void mutate('PATCH', {
                  action: 'employee_binding',
                  connectionId: c.id,
                  employeeId: selectedEmployee.employeeId,
                  employeeVersionId: selectedEmployee.employeeVersionId,
                  expectedRevision: old?.revision ?? 0,
                  enabled: true,
                });
              }}
            >
              绑定此版本（不授予工具调用权）
            </button>
            {employees.flatMap((e) =>
              e.bindings
                .filter((b) => b.connectionId === c.id && b.enabled)
                .map((b) => (
                  <p key={b.id}>
                    {e.name} v{e.version} 已绑定{' '}
                    <button
                      disabled={busy}
                      onClick={() =>
                        void mutate('PATCH', {
                          action: 'employee_binding',
                          connectionId: c.id,
                          employeeId: e.employeeId,
                          employeeVersionId: e.employeeVersionId,
                          expectedRevision: b.revision,
                          enabled: false,
                        })
                      }
                    >
                      撤销员工绑定
                    </button>
                  </p>
                )),
            )}
            {c.tools.map((t) => (
              <div className={styles.tool} key={t.revisionId}>
                <strong>{t.name}</strong>
                <p>{t.description}</p>
                <details>
                  <summary>查看精确工具 Schema</summary>
                  <pre>{JSON.stringify(t.inputSchema, null, 2)}</pre>
                </details>
                <span>
                  {t.available
                    ? t.allowed
                      ? '已授权；每次仍须审批'
                      : '未授权'
                    : '已失效'}
                </span>
                <button
                  disabled={
                    busy ||
                    !c.enabled ||
                    !t.available ||
                    (!enabled && !t.allowed)
                  }
                  onClick={() =>
                    void mutate('PATCH', {
                      action: 'grant',
                      connectionId: c.id,
                      revisionId: t.revisionId,
                      allowed: !t.allowed,
                      risk: 'write',
                    })
                  }
                >
                  {t.allowed ? '撤销工具授权' : '授权此工具'}
                </button>
              </div>
            ))}
          </article>
        );
      })}
    </section>
  );
}
