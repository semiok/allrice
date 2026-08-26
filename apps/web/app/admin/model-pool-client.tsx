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
  fallbackTargets: Array<{
    connectionId: string;
    modelCatalogEntryId: string;
    reasoningEffort: ReasoningEffort;
  }>;
  fallbackOn: Array<
    'provider_unavailable' | 'rate_limited' | 'timeout' | 'transient_error'
  >;
  runLimits: {
    timeoutMs: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxTotalTokens: number;
    maxCostCents: number | null;
  };
  revision?: number;
}

interface CodexAuthorization {
  id: string;
  state:
    | 'pending'
    | 'running'
    | 'awaiting_user'
    | 'connected'
    | 'failed'
    | 'expired'
    | 'canceled';
  verificationUri: string | null;
  userCode: string | null;
  detailCode: string | null;
  expiresAt: string;
}

interface OrganizationModelQuota {
  organizationId: string;
  monthlyRunLimit: number;
  monthlyTokenLimit: number;
  monthlyCostLimitCents: number;
  usedRuns: number;
  usedTokens: number;
  usedCostCents: number;
  periodStart: string;
}

interface ProviderGovernance {
  connectionId: string;
  killSwitch: boolean;
  circuitState: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  openedUntil: string | null;
  lastErrorCode: string | null;
  updatedAt: string | null;
}

interface GovernancePayload {
  quota: OrganizationModelQuota;
  providers: ProviderGovernance[];
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
  const [codexAuthorization, setCodexAuthorization] =
    useState<CodexAuthorization | null>(null);
  const [governance, setGovernance] = useState<GovernancePayload | null>(null);

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
          capabilities: { roles: string[] };
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
        const isPlatformAdmin =
          capabilityResponse.capabilities.roles.includes('platform_admin');
        setPlatformAdmin(isPlatformAdmin);
        if (isPlatformAdmin) {
          void fetch('/api/v1/admin/providers/codex')
            .then((response) =>
              json<{
                provider: {
                  status: string;
                  cliVersion: string | null;
                  checkedAt: string | null;
                };
                authorization: CodexAuthorization | null;
              }>(response),
            )
            .then((response) => {
              setCodexStatus(response.provider);
              setCodexAuthorization(response.authorization);
            });
          void loadGovernance();
        }
      })
      .catch((error: unknown) =>
        setNotice(error instanceof Error ? error.message : '模型池加载失败'),
      );
  }, []);

  async function loadGovernance() {
    const response = await json<{ governance: GovernancePayload }>(
      await fetch('/api/v1/admin/model-governance', { cache: 'no-store' }),
    );
    setGovernance(response.governance);
  }

  async function saveQuota() {
    if (!governance) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await json<{ quota: OrganizationModelQuota }>(
        await fetch('/api/v1/admin/model-governance', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            monthlyRunLimit: governance.quota.monthlyRunLimit,
            monthlyTokenLimit: governance.quota.monthlyTokenLimit,
            monthlyCostLimitCents: governance.quota.monthlyCostLimitCents,
          }),
        }),
      );
      setGovernance({ ...governance, quota: response.quota });
      setNotice('本月租户额度已更新。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '额度更新失败');
    } finally {
      setBusy(false);
    }
  }

  async function updateProviderSafety(
    connectionId: string,
    update: { killSwitch?: boolean; resetCircuit?: boolean },
  ) {
    if (!governance) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await json<{ provider: ProviderGovernance }>(
        await fetch(
          `/api/v1/admin/model-connections/${connectionId}/governance`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(update),
          },
        ),
      );
      setGovernance({
        ...governance,
        providers: governance.providers.map((item) =>
          item.connectionId === connectionId ? response.provider : item,
        ),
      });
      setNotice('Provider 运行治理已更新，并写入审计记录。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '运行治理更新失败');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (
      !platformAdmin ||
      !codexAuthorization ||
      !['pending', 'running', 'awaiting_user'].includes(
        codexAuthorization.state,
      )
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void fetch(
        `/api/v1/admin/providers/codex/authorize?flowId=${codexAuthorization.id}`,
        { cache: 'no-store' },
      )
        .then((response) =>
          json<{ authorization: CodexAuthorization | null }>(response),
        )
        .then((response) => {
          if (response.authorization) {
            setCodexAuthorization(response.authorization);
          }
        });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [codexAuthorization, platformAdmin]);

  async function startCodexAuthorization() {
    setBusy(true);
    setNotice('');
    try {
      const response = await json<{
        authorization: CodexAuthorization;
      }>(
        await fetch('/api/v1/admin/providers/codex/authorize', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
      );
      setCodexAuthorization(response.authorization);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '授权启动失败');
    } finally {
      setBusy(false);
    }
  }

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
      fallbackTargets: [],
      fallbackOn: policy?.fallbackOn ?? [
        'provider_unavailable',
        'rate_limited',
        'timeout',
        'transient_error',
      ],
      runLimits: policy?.runLimits ?? {
        timeoutMs: 300_000,
        maxInputTokens: 120_000,
        maxOutputTokens: 16_000,
        maxTotalTokens: 136_000,
        maxCostCents: null,
      },
    });
  }

  function selectFallbackConnection(connectionId: string) {
    if (!connectionId) {
      setPolicy({
        ...policy!,
        fallbackPolicy: 'disabled',
        fallbackTargets: [],
      });
      return;
    }
    const nextConnection = connections.find((item) => item.id === connectionId);
    const nextModel = models.find(
      (item) => item.providerId === nextConnection?.providerId,
    );
    if (!policy || !nextConnection || !nextModel) return;
    setPolicy({
      ...policy,
      fallbackPolicy: 'explicit',
      fallbackTargets: [
        {
          connectionId: nextConnection.id,
          modelCatalogEntryId: nextModel.id,
          reasoningEffort: nextModel.defaultReasoningEffort,
        },
      ],
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
              fallbackPolicy: policy.fallbackPolicy,
              fallbackTargets: policy.fallbackTargets,
              fallbackOn: policy.fallbackOn,
              runLimits: policy.runLimits,
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
            <label>
              <span>显式降级连接</span>
              <select
                value={policy.fallbackTargets[0]?.connectionId ?? ''}
                onChange={(event) =>
                  selectFallbackConnection(event.target.value)
                }
              >
                <option value="">不自动降级</option>
                {connections
                  .filter(
                    (item) =>
                      item.status === 'ready' &&
                      item.id !== policy.connectionId,
                  )
                  .map((item) => {
                    const provider = providers.find(
                      (candidate) => candidate.id === item.providerId,
                    );
                    return (
                      <option value={item.id} key={item.id}>
                        {provider?.name} · {item.name}
                      </option>
                    );
                  })}
              </select>
            </label>
            <label>
              <span>单次运行超时（秒）</span>
              <input
                min={1}
                max={3600}
                type="number"
                value={Math.round(policy.runLimits.timeoutMs / 1000)}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    runLimits: {
                      ...policy.runLimits,
                      timeoutMs: Number(event.target.value) * 1000,
                    },
                  })
                }
              />
            </label>
            <label>
              <span>最大输入 Token</span>
              <input
                min={1000}
                max={2_000_000}
                type="number"
                value={policy.runLimits.maxInputTokens}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    runLimits: {
                      ...policy.runLimits,
                      maxInputTokens: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
            <label>
              <span>最大输出 Token</span>
              <input
                min={1}
                max={200_000}
                type="number"
                value={policy.runLimits.maxOutputTokens}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    runLimits: {
                      ...policy.runLimits,
                      maxOutputTokens: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
            <label>
              <span>最大总 Token</span>
              <input
                min={1000}
                max={2_000_000}
                type="number"
                value={policy.runLimits.maxTotalTokens}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    runLimits: {
                      ...policy.runLimits,
                      maxTotalTokens: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
            <label>
              <span>成本上限（分，留空不限）</span>
              <input
                min={0}
                max={1_000_000}
                type="number"
                value={policy.runLimits.maxCostCents ?? ''}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    runLimits: {
                      ...policy.runLimits,
                      maxCostCents:
                        event.target.value === ''
                          ? null
                          : Number(event.target.value),
                    },
                  })
                }
              />
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
            <strong>
              创建时冻结；
              {policy.fallbackPolicy === 'explicit'
                ? '按白名单降级'
                : '不自动降级'}
            </strong>
            <span>运行边界</span>
            <strong>
              {Math.round(policy.runLimits.timeoutMs / 1000)} 秒 · 输入{' '}
              {policy.runLimits.maxInputTokens.toLocaleString()} · 输出{' '}
              {policy.runLimits.maxOutputTokens.toLocaleString()} Token
            </strong>
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
                  const providerGovernance = governance?.providers.find(
                    (candidate) => candidate.connectionId === item.id,
                  );
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
                      {provider?.key === 'codex' ? (
                        <div className="provider-auth-actions">
                          {codexAuthorization?.state === 'awaiting_user' &&
                          codexAuthorization.verificationUri &&
                          codexAuthorization.userCode ? (
                            <>
                              <code>{codexAuthorization.userCode}</code>
                              <button
                                onClick={() => {
                                  void navigator.clipboard.writeText(
                                    codexAuthorization.userCode!,
                                  );
                                  window.open(
                                    codexAuthorization.verificationUri!,
                                    '_blank',
                                    'noopener,noreferrer',
                                  );
                                }}
                                type="button"
                              >
                                打开授权页并复制代码
                              </button>
                            </>
                          ) : (
                            <button
                              disabled={
                                busy ||
                                ['pending', 'running'].includes(
                                  codexAuthorization?.state ?? '',
                                )
                              }
                              onClick={() => void startCodexAuthorization()}
                              type="button"
                            >
                              {['pending', 'running'].includes(
                                codexAuthorization?.state ?? '',
                              )
                                ? '正在生成授权码…'
                                : codexAuthorization?.state === 'connected' ||
                                    codexStatus?.status === 'connected'
                                  ? '重新授权 Codex 订阅'
                                  : '授权 Codex 订阅'}
                            </button>
                          )}
                          {codexAuthorization ? (
                            <small>授权流程：{codexAuthorization.state}</small>
                          ) : null}
                        </div>
                      ) : null}
                      {providerGovernance ? (
                        <div className="provider-governance-actions">
                          <small>
                            熔断：{providerGovernance.circuitState} · 连续失败{' '}
                            {providerGovernance.consecutiveFailures}
                          </small>
                          <button
                            className={
                              providerGovernance.killSwitch
                                ? 'provider-kill-switch-active'
                                : ''
                            }
                            disabled={busy}
                            onClick={() =>
                              void updateProviderSafety(item.id, {
                                killSwitch: !providerGovernance.killSwitch,
                              })
                            }
                            type="button"
                          >
                            {providerGovernance.killSwitch
                              ? '解除紧急停用'
                              : '紧急停用'}
                          </button>
                          {providerGovernance.circuitState !== 'closed' ? (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void updateProviderSafety(item.id, {
                                  resetCircuit: true,
                                })
                              }
                              type="button"
                            >
                              重置熔断
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
            </div>
            {governance ? (
              <div className="platform-quota-console">
                <div>
                  <span className="v2-section-label">租户月度额度</span>
                  <h3>用量与硬上限</h3>
                  <p>
                    已运行 {governance.quota.usedRuns.toLocaleString()} 次 ·
                    已用 {governance.quota.usedTokens.toLocaleString()} Token ·
                    成本 {governance.quota.usedCostCents.toFixed(2)} 分
                  </p>
                </div>
                <label>
                  运行次数
                  <input
                    min={1}
                    type="number"
                    value={governance.quota.monthlyRunLimit}
                    onChange={(event) =>
                      setGovernance({
                        ...governance,
                        quota: {
                          ...governance.quota,
                          monthlyRunLimit: Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  Token
                  <input
                    min={1}
                    type="number"
                    value={governance.quota.monthlyTokenLimit}
                    onChange={(event) =>
                      setGovernance({
                        ...governance,
                        quota: {
                          ...governance.quota,
                          monthlyTokenLimit: Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  成本（分）
                  <input
                    min={0}
                    type="number"
                    value={governance.quota.monthlyCostLimitCents}
                    onChange={(event) =>
                      setGovernance({
                        ...governance,
                        quota: {
                          ...governance.quota,
                          monthlyCostLimitCents: Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
                <button disabled={busy} onClick={() => void saveQuota()}>
                  保存额度
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </section>
  );
}
