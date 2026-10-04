'use client';
import { AdminButton } from '../../components/admin/admin-ui';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import type { SaasCapabilityManifest } from '@allrice/contracts';
import type { CodexAuthorization } from './codex-authorization';
import {
  CodexSubscriptionsPanel,
  type CodexSubscriptionAccount,
} from './codex-subscriptions';
import {
  UnknownUsageReviewCard,
  type UnknownUsageReview,
} from './unknown-usage-review';

import styles from './governance-console.module.css';
import { PlatformModelSettingsPanel } from './platform-model-settings';

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

type Authorization = CodexAuthorization;

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
  const [subscriptions, setSubscriptions] = useState<
    CodexSubscriptionAccount[]
  >([]);
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
          codexTokenPolicy?: 'observe' | 'enforce';
          providers: ProviderGovernance[];
          operations: ProviderOperation[];
          unknownUsage: UnknownUsageReview[];
        };
      }>(await fetch('/api/v1/admin/model-governance', { cache: 'no-store' })),
      readJson<{
        provider: {
          status: string;
        };
        subscriptions: CodexSubscriptionAccount[];
      }>(await fetch('/api/v1/admin/providers/codex', { cache: 'no-store' })),
    ]);
    setConnections(poolResult.modelPool.connections);
    setProviders(poolResult.modelPool.providers);
    setQuota(governanceResult.governance.quota);
    setTokenPolicy(governanceResult.governance.codexTokenPolicy ?? 'enforce');
    setUnknownUsage(governanceResult.governance.unknownUsage ?? []);
    setProviderStates(governanceResult.governance.providers);
    setProviderOperations(governanceResult.governance.operations);
    setSubscriptions(codexResult.subscriptions);
    setCodexStatus(codexResult.provider.status);
  }, []);

  useEffect(() => {
    void load().catch((error: unknown) =>
      setNotice(error instanceof Error ? error.message : '平台控制台加载失败'),
    );
  }, [load]);

  useEffect(() => {
    if (
      !subscriptions.some(
        (a) =>
          a.authorization &&
          ['pending', 'running', 'awaiting_user'].includes(
            a.authorization.state,
          ),
      )
    )
      return;
    const timer = window.setInterval(
      () =>
        void load().catch((error) =>
          setNotice(
            error instanceof Error ? error.message : '授权状态暂不可用',
          ),
        ),
      2000,
    );
    return () => window.clearInterval(timer);
  }, [subscriptions, load]);

  async function selectSubscription(enabledSlot: 1 | 2 | null) {
    setBusy(true);
    try {
      await readJson(
        await fetch('/api/v1/admin/providers/codex', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            enabledSlot,
            expectedEnabledSlot:
              subscriptions.find((a) => a.enabled)?.slot ?? null,
          }),
        }),
      );
      setNotice(
        enabledSlot === null
          ? '两个账号均已停用，授权仍保留。'
          : `已启用 ${enabledSlot} 号账号，另一个账号已停用。`,
      );
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '切换失败');
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  async function startCodexAuthorization(subscriptionSlot: 1 | 2) {
    setBusy(true);
    try {
      const result = await readJson<{ authorization: Authorization }>(
        await fetch('/api/v1/admin/providers/codex/authorize', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subscriptionSlot }),
        }),
      );
      setSubscriptions((old) =>
        old.map((a) =>
          a.slot === subscriptionSlot
            ? { ...a, authorization: result.authorization }
            : a,
        ),
      );
      setNotice('正在准备授权码，请在下方完成授权。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '授权启动失败');
    } finally {
      setBusy(false);
    }
  }

  async function cancelAuthorization(flowId: string) {
    setBusy(true);
    try {
      const result = await readJson<{ authorization: Authorization }>(
        await fetch(
          `/api/v1/admin/providers/codex/authorize?flowId=${encodeURIComponent(flowId)}`,
          { method: 'DELETE' },
        ),
      );
      setSubscriptions((old) =>
        old.map((a) =>
          a.authorization?.id === flowId
            ? { ...a, authorization: result.authorization }
            : a,
        ),
      );
      setNotice('已取消本次授权流程。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '暂时无法取消授权');
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
        <p>员工配置与平台 Provider 由平台管理员统一管理。</p>
        <Link href="/chatflow">返回 ChatFlow</Link>
      </div>
    );
  }

  return (
    <div className={styles.embedded}>
      <header className={styles.header}>
        <div>
          <h1>模型与用量</h1>
          <span>平台统一托管凭据、Provider 可用性、租户额度和生产熔断。</span>
        </div>
      </header>

      <PlatformModelSettingsPanel />
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
                      <CodexSubscriptionsPanel
                        accounts={subscriptions}
                        busy={busy}
                        onSelect={(slot) => void selectSubscription(slot)}
                        onAuthorize={(slot) =>
                          void startCodexAuthorization(slot)
                        }
                        onCancel={(id) => void cancelAuthorization(id)}
                      />
                    </div>
                  ) : null}
                  {governance &&
                  (provider?.key !== 'codex' ||
                    governance.circuitState !== 'closed') ? (
                    <footer>
                      {provider?.key !== 'codex' && (
                        <AdminButton
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
                        </AdminButton>
                      )}
                      {governance.circuitState !== 'closed' ? (
                        <AdminButton
                          disabled={busy}
                          onClick={() =>
                            void updateProvider(connection.id, {
                              resetCircuit: true,
                            })
                          }
                        >
                          重置熔断
                        </AdminButton>
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
              所有模型的
              Token、模型和工具调用次数、费用仅统计，历史用量上限不再中断执行。任务默认
              1 小时，无进展保护与实际资源并发限制继续生效。
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
              历史 Token 上限（不执行）
              <input
                min={1}
                type="number"
                value={quota.monthlyTokenLimit}
                readOnly={tokenPolicy === 'observe'}
                onChange={(event) =>
                  setQuota({
                    ...quota,
                    monthlyTokenLimit: Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              历史费用上限（分，不执行）
              <input
                min={0}
                type="number"
                value={quota.monthlyCostLimitCents}
                readOnly={tokenPolicy === 'observe'}
                onChange={(event) =>
                  setQuota({
                    ...quota,
                    monthlyCostLimitCents: Number(event.target.value),
                  })
                }
              />
            </label>
            <div className={styles.formActions}>
              <AdminButton
                variant="primary"
                disabled={busy}
                onClick={() => void saveQuota()}
              >
                保存额度
              </AdminButton>
            </div>
          </div>
        </section>
      ) : null}
      {notice ? <div className={styles.notice}>{notice}</div> : null}
    </div>
  );
}
