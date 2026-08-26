'use client';

import { useEffect, useMemo, useState } from 'react';

type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

interface ModelProvider {
  id: string;
  key: string;
  name: string;
}

interface ModelConnection {
  id: string;
  providerId: string;
  name: string;
  scope: 'platform' | 'organization';
  status: 'ready' | 'degraded' | 'disabled';
  stability: 'production' | 'experimental';
}

interface ModelEntry {
  id: string;
  providerId: string;
  model: string;
  displayName: string;
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
  stability: 'production' | 'experimental';
}

interface Employee {
  id: string;
  employeeId: string;
  currentVersion: {
    manifest: { name: string; description: string };
  };
}

interface WorkspacePayload {
  workspaceId: string;
  employees: Employee[];
}

interface ModelPolicy {
  connectionId: string;
  modelCatalogEntryId: string;
  reasoningEffort: ReasoningEffort;
  fallbackPolicy: 'disabled' | 'explicit';
  revision?: number;
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(body.error?.message ?? '请求失败');
  }
  return body;
}

export function ModelPoolClient() {
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(null);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [policy, setPolicy] = useState<ModelPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [codexStatus, setCodexStatus] = useState<{
    status: string;
    cliVersion: string | null;
    checkedAt: string | null;
  } | null>(null);

  useEffect(() => {
    void Promise.all([
      fetch('/api/v1/workspace').then((response) =>
        json<{ workspace: WorkspacePayload }>(response),
      ),
      fetch('/api/v1/model-pool').then((response) =>
        json<{
          modelPool: {
            providers: ModelProvider[];
            connections: ModelConnection[];
            models: ModelEntry[];
            defaultSelection: ModelPolicy;
          };
        }>(response),
      ),
      fetch('/api/v1/saas/capabilities').then((response) =>
        json<{
          capabilities: { platformAdmin: boolean };
        }>(response),
      ),
    ])
      .then(([workspaceResponse, poolResponse, capabilityResponse]) => {
        setWorkspace(workspaceResponse.workspace);
        setProviders(poolResponse.modelPool.providers);
        setConnections(poolResponse.modelPool.connections);
        setModels(poolResponse.modelPool.models);
        setEmployeeId(
          workspaceResponse.workspace.employees[0]?.employeeId ?? '',
        );
        setPolicy(poolResponse.modelPool.defaultSelection);
        setPlatformAdmin(capabilityResponse.capabilities.platformAdmin);
        if (capabilityResponse.capabilities.platformAdmin) {
          void fetch('/api/v1/admin/providers/codex')
            .then((response) =>
              json<{
                provider: {
                  status: string;
                  cliVersion: string | null;
                  checkedAt: string | null;
                };
              }>(response),
            )
            .then((response) => setCodexStatus(response.provider));
        }
      })
      .catch((error: unknown) =>
        setNotice(error instanceof Error ? error.message : '模型池加载失败'),
      );
  }, []);

  useEffect(() => {
    if (!workspace || !employeeId) return;
    void fetch(
      `/api/v1/employees/${employeeId}/model-policy?workspaceId=${workspace.workspaceId}`,
    )
      .then((response) => json<{ policy: ModelPolicy | null }>(response))
      .then((response) => {
        if (response.policy) setPolicy(response.policy);
      })
      .catch((error: unknown) =>
        setNotice(
          error instanceof Error ? error.message : '员工模型配置加载失败',
        ),
      );
  }, [employeeId, workspace]);

  const connection = connections.find(
    (candidate) => candidate.id === policy?.connectionId,
  );
  const availableModels = useMemo(
    () =>
      models.filter(
        (model) => !connection || model.providerId === connection.providerId,
      ),
    [connection, models],
  );
  const selectedModel = models.find(
    (model) => model.id === policy?.modelCatalogEntryId,
  );

  function selectConnection(connectionId: string) {
    const nextConnection = connections.find((item) => item.id === connectionId);
    const nextModel = models.find(
      (item) => item.providerId === nextConnection?.providerId,
    );
    if (!nextConnection || !nextModel) return;
    setPolicy({
      connectionId: nextConnection.id,
      modelCatalogEntryId: nextModel.id,
      reasoningEffort: nextModel.defaultReasoningEffort,
      fallbackPolicy: 'disabled',
    });
  }

  async function save() {
    if (!workspace || !employeeId || !policy) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await json<{ policy: ModelPolicy }>(
        await fetch(
          `/api/v1/employees/${employeeId}/model-policy?workspaceId=${workspace.workspaceId}`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              connectionId: policy.connectionId,
              modelCatalogEntryId: policy.modelCatalogEntryId,
              reasoningEffort: policy.reasoningEffort,
              fallbackPolicy: 'disabled',
              fallbackTargets: [],
            }),
          },
        ),
      );
      setPolicy(response.policy);
      setNotice('已保存。新会话将使用此配置，已有会话继续使用冻结快照。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  if (!workspace || !policy) {
    return <div className="saas-loading">{notice || '正在加载模型池…'}</div>;
  }

  return (
    <section className="model-pool-page">
      <header className="v2-page-header">
        <div>
          <span className="v2-kicker">MODEL CONTROL</span>
          <h1>模型与运行</h1>
          <p>平台统一托管连接，租户管理员只为员工选择允许使用的模型。</p>
        </div>
        <button className="v2-primary-button" disabled={busy} onClick={save}>
          {busy ? '保存中…' : '保存配置'}
        </button>
      </header>

      <div className="model-pool-layout">
        <aside className="model-employee-list">
          <span className="v2-section-label">AI 员工</span>
          {workspace.employees.map((employee) => (
            <button
              key={employee.employeeId}
              className={employee.employeeId === employeeId ? 'selected' : ''}
              onClick={() => setEmployeeId(employee.employeeId)}
            >
              <span className="model-employee-avatar">
                {employee.currentVersion.manifest.name.slice(0, 1)}
              </span>
              <span>
                <strong>{employee.currentVersion.manifest.name}</strong>
                <small>{employee.currentVersion.manifest.description}</small>
              </span>
            </button>
          ))}
        </aside>

        <div className="model-policy-editor">
          <div className="model-policy-heading">
            <div>
              <span className="v2-section-label">员工运行策略</span>
              <h2>
                {
                  workspace.employees.find(
                    (employee) => employee.employeeId === employeeId,
                  )?.currentVersion.manifest.name
                }
              </h2>
            </div>
            {policy.revision ? (
              <span>修订 {policy.revision}</span>
            ) : (
              <span>默认</span>
            )}
          </div>

          <div className="model-form-grid">
            <label>
              <span>平台连接</span>
              <select
                value={policy.connectionId}
                onChange={(event) => selectConnection(event.target.value)}
              >
                {connections.map((item) => {
                  const provider = providers.find(
                    (candidate) => candidate.id === item.providerId,
                  );
                  return (
                    <option
                      disabled={item.status !== 'ready'}
                      value={item.id}
                      key={item.id}
                    >
                      {provider?.name} · {item.name}
                      {item.status !== 'ready' ? `（${item.status}）` : ''}
                    </option>
                  );
                })}
              </select>
            </label>
            <label>
              <span>模型</span>
              <select
                value={policy.modelCatalogEntryId}
                onChange={(event) => {
                  const model = models.find(
                    (item) => item.id === event.target.value,
                  );
                  if (!model) return;
                  setPolicy((current) =>
                    current
                      ? {
                          ...current,
                          modelCatalogEntryId: model.id,
                          reasoningEffort: model.defaultReasoningEffort,
                        }
                      : current,
                  );
                }}
              >
                {availableModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>推理强度</span>
              <select
                value={policy.reasoningEffort}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    reasoningEffort: event.target.value as ReasoningEffort,
                  })
                }
              >
                {selectedModel?.reasoningEfforts.map((effort) => (
                  <option value={effort} key={effort}>
                    {effort === 'xhigh' ? '极高' : effort}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="model-runtime-summary">
            <span>运行模型</span>
            <strong>
              {providers.find(
                (provider) => provider.id === connection?.providerId,
              )?.name ?? '平台托管'}{' '}
              · {selectedModel?.displayName}
            </strong>
            <span>会话策略</span>
            <strong>创建时冻结；显式切换后新会话生效</strong>
            <span>凭据</span>
            <strong>由 AllRice 平台托管，浏览器不可见</strong>
          </div>
          {notice ? <p className="model-policy-notice">{notice}</p> : null}
        </div>

        {platformAdmin ? (
          <section className="platform-provider-console">
            <div>
              <span className="v2-section-label">平台管理员</span>
              <h2>托管连接</h2>
              <p>
                这里管理平台级
                Provider。租户只能选择已发布连接，无法查看或替换凭据。
              </p>
            </div>
            <div className="platform-provider-list">
              {connections
                .filter((item) => item.scope === 'platform')
                .map((item) => {
                  const provider = providers.find(
                    (candidate) => candidate.id === item.providerId,
                  );
                  const status =
                    provider?.key === 'codex'
                      ? (codexStatus?.status ?? item.status)
                      : item.status;
                  return (
                    <article key={item.id}>
                      <span
                        className={`provider-status provider-status-${status}`}
                      />
                      <div>
                        <strong>{provider?.name ?? item.name}</strong>
                        <small>
                          {provider?.key === 'codex'
                            ? `订阅授权 · ${codexStatus?.cliVersion ?? '等待 Worker 探测'}`
                            : `${item.name} · API 由平台托管`}
                        </small>
                      </div>
                      <em>{status}</em>
                    </article>
                  );
                })}
            </div>
          </section>
        ) : null}
      </div>
    </section>
  );
}
