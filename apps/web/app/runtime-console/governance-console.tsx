'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import type {
  SaasCapabilityManifest,
  CodexSubscriptionQuotaSnapshot,
} from '@allrice/contracts';
import { CodexSubscriptionQuota } from './codex-subscription-quota';
import {
  UnknownUsageReviewCard,
  type UnknownUsageReview,
} from './unknown-usage-review';

import styles from './governance-console.module.css';

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
  runtimeSupported?: boolean;
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
  costCents: number | null;
  unknownCostRuns: number;
  subscriptionRuns?: number;
  usageComplete: boolean;
}

interface Quota {
  monthlyRunLimit: number;
  monthlyTokenLimit: number;
  monthlyCostLimitCents: number;
  usedRuns: number;
  usedTokens: number;
  usedCostCents: number | null;
  unknownCostRuns: number;
  subscriptionRuns?: number;
  usageComplete: boolean;
  reservedTokenBudget?: number;
  subscriptionBudgetAdmissionComplete?: boolean;
}

export function GovernanceUsageSummary({
  quota,
}: {
  quota: Pick<
    Quota,
    | 'usedRuns'
    | 'usedTokens'
    | 'usedCostCents'
    | 'unknownCostRuns'
    | 'usageComplete'
    | 'subscriptionRuns'
    | 'reservedTokenBudget'
  >;
}) {
  const subscriptionOnly =
    quota.usedRuns > 0 &&
    quota.subscriptionRuns === quota.usedRuns &&
    quota.unknownCostRuns === 0;
  return (
    <div className={styles.usage}>
      <strong>{quota.usedRuns.toLocaleString()}</strong>
      <span>次运行</span>
      <strong>{quota.usedTokens.toLocaleString()}</strong>
      <span>{quota.usageComplete ? 'Token' : 'Token（部分用量待核对）'}</span>
      {(quota.reservedTokenBudget ?? 0) > 0 ? (
        <>
          <strong>{quota.reservedTokenBudget!.toLocaleString()}</strong>
          <span>额外预留的组织月度预算（非实际用量、非扣费）</span>
        </>
      ) : null}
      <strong>
        {subscriptionOnly
          ? '订阅用量'
          : quota.usedCostCents === null
            ? '费用待核对'
            : quota.usedCostCents.toFixed(2)}
      </strong>
      <span>
        {subscriptionOnly
          ? '不适用按次 API 费用；订阅额度另行展示'
          : quota.usedCostCents === null
            ? `${quota.unknownCostRuns} 次运行缺少可用费用估算；不会按 0 计入额度`
            : (quota.subscriptionRuns ?? 0) > 0
              ? '分（API 估算，不含订阅运行）'
              : '分（估算）'}
      </span>
    </div>
  );
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    window.location.assign('/login?next=/runtime-console?view=governance');
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

export function GovernanceConsole() {
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
  const [tokenPolicy, setTokenPolicy] = useState<'observe' | 'enforce'>(
    'enforce',
  );
  const [unknownUsage, setUnknownUsage] = useState<UnknownUsageReview[]>([]);
  const [authorization, setAuthorization] = useState<Authorization | null>(
    null,
  );
  const [codexStatus, setCodexStatus] = useState('unknown');
  const [codexQuota, setCodexQuota] =
    useState<CodexSubscriptionQuotaSnapshot | null>(null);
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
          codexTokenPolicy?: 'observe' | 'enforce';
          providers: ProviderGovernance[];
          operations: ProviderOperation[];
          unknownUsage: UnknownUsageReview[];
        };
      }>(await fetch('/api/v1/admin/model-governance', { cache: 'no-store' })),
      readJson<{
        provider: {
          status: string;
          quota?: CodexSubscriptionQuotaSnapshot | null;
        };
        authorization: Authorization | null;
      }>(await fetch('/api/v1/admin/providers/codex', { cache: 'no-store' })),
    ]);
    setConnections(poolResult.modelPool.connections);
    setProviders(poolResult.modelPool.providers);
    setQuota(governanceResult.governance.quota);
    setTokenPolicy(governanceResult.governance.codexTokenPolicy ?? 'enforce');
    setUnknownUsage(governanceResult.governance.unknownUsage ?? []);
    setProviderStates(governanceResult.governance.providers);
    setProviderOperations(governanceResult.governance.operations);
    setAuthorization(codexResult.authorization);
    setCodexStatus(codexResult.provider.status);
    setCodexQuota(codexResult.provider.quota ?? null);
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

  async function reviewUnknownUsage(review: {
    decisionId: string;
    reservedTokens: number;
    reason: string;
    acceptUnknownUsage: true;
  }) {
    setBusy(true);
    try {
      await readJson(
        await fetch('/api/v1/admin/model-governance/usage-review', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(review),
        }),
      );
      await load();
      setNotice(
        '预算预留已审计；原始用量仍未知。若仍有其他异常或额度限制，后续请求仍会被拦截。',
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : '预算预留失败，请刷新核对结果后再操作',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!manifest)
    return <div className={styles.embeddedLoading}>正在加载平台控制台…</div>;
  if (!manifest.roles.includes('platform_admin')) {
    return (
      <div className={styles.embeddedDenied}>
        <h1>平台管理员专用</h1>
        <p>租户管理员可以配置员工，但不能查看平台 Provider 或授权状态。</p>
        <Link href="/chatflow">返回 ChatFlow</Link>
      </div>
    );
  }

  return (
    <div className={styles.embedded}>
      <header className={styles.header}>
        <div>
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
                provider?.runtimeSupported === false
                  ? '授权方式未支持'
                  : provider?.key === 'codex'
                    ? codexStatus
                    : connection.status;
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
                      <CodexSubscriptionQuota quota={codexQuota} />
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
              <h2>平台用量统计与资源限制</h2>
            </div>
            <span>用量在每次 RouteDecision 完成后写入不可重复账本</span>
          </div>
          <GovernanceUsageSummary quota={quota} />
          {tokenPolicy === 'observe' ? (
            <p>
              Codex 订阅 Token 仅统计，不受内部任务/月度 Token
              上限及未知用量阻断，无需人工预算预留。Token 限额配置仅用于按量
              API；并发、运行超时、调用次数和权限审批继续生效。
            </p>
          ) : null}
          {unknownUsage.length > 0 ? (
            <div>
              <h2>各租户异常用量处理</h2>
              {unknownUsage.map((entry) => (
                <UnknownUsageReviewCard
                  key={entry.decisionId}
                  entry={entry}
                  busy={busy}
                  onReview={reviewUnknownUsage}
                />
              ))}
            </div>
          ) : null}
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
              API 成本上限（分，订阅不适用）
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
    </div>
  );
}
