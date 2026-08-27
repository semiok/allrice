'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import type { SaasCapabilityManifest } from '@allrice/contracts';

import styles from './platform-console.module.css';

interface Connection {
  id: string;
  providerId: string;
  name: string;
  scope: 'platform' | 'organization';
  status: string;
}

interface Provider {
  id: string;
  key: string;
  name: string;
}

interface Authorization {
  id: string;
  state: string;
  verificationUri: string | null;
  userCode: string | null;
}

interface ProviderGovernance {
  connectionId: string;
  killSwitch: boolean;
  circuitState: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  lastErrorCode: string | null;
  releaseStage: 'experimental' | 'canary' | 'production' | 'disabled';
  productionApproved: boolean;
  allowlistedOrganizationIds: string[];
}

interface ProviderOperation {
  connectionId: string;
  releaseStage: 'experimental' | 'canary' | 'production' | 'disabled';
  productionApproved: boolean;
  runs: number;
  failures: number;
  fallbacks: number;
  averageLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

interface Quota {
  monthlyRunLimit: number;
  monthlyTokenLimit: number;
  monthlyCostLimitCents: number;
  usedRuns: number;
  usedTokens: number;
  usedCostCents: number;
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    window.location.assign('/login?next=/chatflow/admin');
    throw new Error('登录状态已失效');
  }
  const body = (await response.json().catch(() => null)) as
    T | { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(
      (body as { error?: { message?: string } } | null)?.error?.message ??
        `请求失败（${response.status}）`,
    );
  }
  return body as T;
}

export function PlatformConsole() {
  const [manifest, setManifest] = useState<SaasCapabilityManifest | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerStates, setProviderStates] = useState<ProviderGovernance[]>(
    [],
  );
  const [providerOperations, setProviderOperations] = useState<
    ProviderOperation[]
  >([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [authorization, setAuthorization] = useState<Authorization | null>(
    null,
  );
  const [codexStatus, setCodexStatus] = useState('unknown');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const [capabilityResult, poolResult] = await Promise.all([
      readJson<{ capabilities: SaasCapabilityManifest }>(
        await fetch('/api/v1/saas/capabilities', { cache: 'no-store' }),
      ),
      readJson<{
        modelPool: { connections: Connection[]; providers: Provider[] };
      }>(await fetch('/api/v1/model-pool', { cache: 'no-store' })),
    ]);
    setManifest(capabilityResult.capabilities);
    if (!capabilityResult.capabilities.roles.includes('platform_admin')) return;
    const [governanceResult, codexResult] = await Promise.all([
      readJson<{
        governance: {
          quota: Quota;
          providers: ProviderGovernance[];
          operations: ProviderOperation[];
        };
      }>(await fetch('/api/v1/admin/model-governance', { cache: 'no-store' })),
      readJson<{
        provider: { status: string };
        authorization: Authorization | null;
      }>(await fetch('/api/v1/admin/providers/codex', { cache: 'no-store' })),
    ]);
    setConnections(poolResult.modelPool.connections);
    setProviders(poolResult.modelPool.providers);
    setQuota(governanceResult.governance.quota);
    setProviderStates(governanceResult.governance.providers);
    setProviderOperations(governanceResult.governance.operations);
    setAuthorization(codexResult.authorization);
    setCodexStatus(codexResult.provider.status);
  }, []);

  useEffect(() => {
    void load().catch((error: unknown) =>
      setNotice(error instanceof Error ? error.message : '平台控制台加载失败'),
    );
  }, [load]);

  useEffect(() => {
    if (
      !authorization ||
      !['pending', 'running', 'awaiting_user'].includes(authorization.state)
    )
      return;
    const timer = window.setInterval(() => void load(), 1_000);
    return () => window.clearInterval(timer);
  }, [authorization, load]);

  async function startCodexAuthorization() {
    setBusy(true);
    try {
      const result = await readJson<{ authorization: Authorization }>(
        await fetch('/api/v1/admin/providers/codex/authorize', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      );
      setAuthorization(result.authorization);
      setNotice('授权流程已交给 Worker。数据库不会保存订阅令牌。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '授权启动失败');
    } finally {
      setBusy(false);
    }
  }

  async function updateProvider(
    connectionId: string,
    update: {
      killSwitch?: boolean;
      resetCircuit?: boolean;
      releaseStage?: 'experimental' | 'canary' | 'production' | 'disabled';
      productionApproved?: boolean;
    },
  ) {
    setBusy(true);
    try {
      const result = await readJson<{ provider: ProviderGovernance }>(
        await fetch(
          `/api/v1/admin/model-connections/${connectionId}/governance`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(update),
          },
        ),
      );
      setProviderStates((current) =>
        current.map((item) =>
          item.connectionId === connectionId ? result.provider : item,
        ),
      );
      setNotice('Provider 治理状态已更新并审计。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Provider 更新失败');
    } finally {
      setBusy(false);
    }
  }

  async function saveQuota() {
    if (!quota) return;
    setBusy(true);
    try {
      const result = await readJson<{ quota: Quota }>(
        await fetch('/api/v1/admin/model-governance', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            monthlyRunLimit: quota.monthlyRunLimit,
            monthlyTokenLimit: quota.monthlyTokenLimit,
            monthlyCostLimitCents: quota.monthlyCostLimitCents,
          }),
        }),
      );
      setQuota(result.quota);
      setNotice('租户月度额度已保存。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '额度保存失败');
    } finally {
      setBusy(false);
    }
  }

  if (!manifest)
    return <main className={styles.loading}>正在加载平台控制台…</main>;
  if (!manifest.roles.includes('platform_admin')) {
    return (
      <main className={styles.denied}>
        <h1>平台管理员专用</h1>
        <p>租户管理员可以配置员工，但不能查看平台 Provider 或授权状态。</p>
        <Link href="/chatflow">返回 ChatFlow</Link>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href="/chatflow">← 返回 ChatFlow</Link>
          <p>PLATFORM OPERATIONS</p>
          <h1>模型与运行治理</h1>
          <span>平台统一托管凭据、Provider 可用性、租户额度和生产熔断。</span>
        </div>
        <i>Platform admin</i>
      </header>

      <section className={styles.providers}>
        <div className={styles.sectionHeading}>
          <div>
            <p>模型连接</p>
            <h2>托管 Provider</h2>
          </div>
          <span>凭据永远不会进入浏览器</span>
        </div>
        <div className={styles.providerGrid}>
          {connections
            .filter((item) => item.scope === 'platform')
            .map((connection) => {
              const provider = providers.find(
                (item) => item.id === connection.providerId,
              );
              const governance = providerStates.find(
                (item) => item.connectionId === connection.id,
              );
              const status =
                provider?.key === 'codex' ? codexStatus : connection.status;
              const operation = providerOperations.find(
                (item) => item.connectionId === connection.id,
              );
              return (
                <article key={connection.id}>
                  <header>
                    <i
                      className={
                        status === 'connected' || status === 'ready'
                          ? styles.ready
                          : styles.warning
                      }
                    />
                    <span>
                      <strong>{provider?.name ?? connection.name}</strong>
                      <small>{connection.name}</small>
                    </span>
                    <em>{status}</em>
                  </header>
                  <dl>
                    <div>
                      <dt>熔断</dt>
                      <dd>{governance?.circuitState ?? 'closed'}</dd>
                    </div>
                    <div>
                      <dt>连续失败</dt>
                      <dd>{governance?.consecutiveFailures ?? 0}</dd>
                    </div>
                    <div>
                      <dt>发布阶段</dt>
                      <dd>
                        {operation?.releaseStage ?? 'experimental'}
                        {operation?.productionApproved ? ' · 已审批' : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>30 天运行 / 失败</dt>
                      <dd>
                        {operation?.runs ?? 0} / {operation?.failures ?? 0}
                      </dd>
                    </div>
                    <div>
                      <dt>平均延迟</dt>
                      <dd>{operation?.averageLatencyMs ?? 0} ms</dd>
                    </div>
                    <div>
                      <dt>显式降级</dt>
                      <dd>{operation?.fallbacks ?? 0}</dd>
                    </div>
                  </dl>
                  {provider?.key === 'codex' ? (
                    <div className={styles.codexAuth}>
                      {authorization?.state === 'awaiting_user' &&
                      authorization.userCode &&
                      authorization.verificationUri ? (
                        <button
                          onClick={() => {
                            void navigator.clipboard.writeText(
                              authorization.userCode!,
                            );
                            window.open(
                              authorization.verificationUri!,
                              '_blank',
                              'noopener,noreferrer',
                            );
                          }}
                        >
                          复制代码并打开授权页 · {authorization.userCode}
                        </button>
                      ) : (
                        <button
                          disabled={busy}
                          onClick={() => void startCodexAuthorization()}
                        >
                          在 DSH 中授权 Codex 订阅
                        </button>
                      )}
                    </div>
                  ) : null}
                  {governance ? (
                    <footer>
                      <button
                        className={
                          governance.killSwitch
                            ? styles.dangerActive
                            : styles.danger
                        }
                        disabled={busy}
                        onClick={() =>
                          void updateProvider(connection.id, {
                            killSwitch: !governance.killSwitch,
                          })
                        }
                      >
                        {governance.killSwitch ? '解除紧急停用' : '紧急停用'}
                      </button>
                      {governance.circuitState !== 'closed' ? (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void updateProvider(connection.id, {
                              resetCircuit: true,
                            })
                          }
                        >
                          重置熔断
                        </button>
                      ) : null}
                      {!governance.productionApproved ? (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void updateProvider(connection.id, {
                              releaseStage: 'production',
                              productionApproved: true,
                            })
                          }
                        >
                          批准进入生产
                        </button>
                      ) : null}
                    </footer>
                  ) : null}
                </article>
              );
            })}
        </div>
      </section>

      {quota ? (
        <section className={styles.quota}>
          <div className={styles.sectionHeading}>
            <div>
              <p>租户治理</p>
              <h2>本月额度</h2>
            </div>
            <span>用量在每次 RouteDecision 完成后写入不可重复账本</span>
          </div>
          <div className={styles.usage}>
            <strong>{quota.usedRuns.toLocaleString()}</strong>
            <span>次运行</span>
            <strong>{quota.usedTokens.toLocaleString()}</strong>
            <span>Token</span>
            <strong>{quota.usedCostCents.toFixed(2)}</strong>
            <span>分</span>
          </div>
          <div className={styles.quotaForm}>
            <label>
              运行上限
              <input
                min={1}
                type="number"
                value={quota.monthlyRunLimit}
                onChange={(event) =>
                  setQuota({
                    ...quota,
                    monthlyRunLimit: Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              Token 上限
              <input
                min={1}
                type="number"
                value={quota.monthlyTokenLimit}
                onChange={(event) =>
                  setQuota({
                    ...quota,
                    monthlyTokenLimit: Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              成本上限（分）
              <input
                min={0}
                type="number"
                value={quota.monthlyCostLimitCents}
                onChange={(event) =>
                  setQuota({
                    ...quota,
                    monthlyCostLimitCents: Number(event.target.value),
                  })
                }
              />
            </label>
            <button disabled={busy} onClick={() => void saveQuota()}>
              保存额度
            </button>
          </div>
        </section>
      ) : null}
      {notice ? <div className={styles.notice}>{notice}</div> : null}
    </main>
  );
}
