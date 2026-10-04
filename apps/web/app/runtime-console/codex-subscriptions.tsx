'use client';
import { AdminButton } from '../../components/admin/admin-ui';
import type { CodexProviderStatus } from '@allrice/contracts';
import {
  CodexAuthorizationPanel,
  type CodexAuthorization,
} from './codex-authorization';
import { CodexSubscriptionQuota } from './codex-subscription-quota';
import styles from './governance-console.module.css';

export interface CodexSubscriptionAccount {
  slot: 1 | 2;
  label: string;
  enabled: boolean;
  provider: CodexProviderStatus;
  authorization: CodexAuthorization | null;
}
export function CodexSubscriptionsPanel({
  accounts,
  busy,
  onSelect,
  onAuthorize,
  onCancel,
}: {
  accounts: CodexSubscriptionAccount[];
  busy: boolean;
  onSelect: (slot: 1 | 2 | null) => void;
  onAuthorize: (slot: 1 | 2) => void;
  onCancel: (flowId: string) => void;
}) {
  const selected = accounts.find((account) => account.enabled);
  return (
    <section
      aria-label="Codex 订阅账号"
      className={styles.subscriptionAccounts}
    >
      <div className={styles.subscriptionSummary}>
        <strong>
          {selected
            ? `当前启用：${selected.slot} 号 · ${selected.label}`
            : '全部停用'}
        </strong>
        <p>
          最多启用一个账号，也可以全部停用。授权单独保存，切换不会删除授权；任务执行期间暂不可切换。
        </p>
        {!selected && (
          <p role="status">Codex 任务暂不可执行，请启用一个已授权账号。</p>
        )}
      </div>
      {accounts.map((account) => (
        <section
          key={account.slot}
          className={styles.subscriptionAccount}
          aria-label={`${account.slot} 号 · ${account.label}`}
        >
          <header className={styles.subscriptionHeader}>
            <div>
              <h3>
                {account.slot} 号 · {account.label}
              </h3>
              <span>
                {account.provider.status === 'connected'
                  ? '已授权'
                  : account.provider.status === 'error'
                    ? '授权状态暂不可用'
                    : '未授权'}
              </span>
            </div>
            <strong data-enabled={account.enabled}>
              {account.enabled ? '已启用' : '已停用'}
            </strong>
          </header>
          <CodexSubscriptionQuota quota={account.provider.quota ?? null} />
          <div className={styles.authorizationActions}>
            <AdminButton
              type="button"
              disabled={
                busy ||
                (!account.enabled && account.provider.status !== 'connected')
              }
              onClick={() => onSelect(account.enabled ? null : account.slot)}
            >
              {account.enabled
                ? `停用 ${account.slot} 号`
                : `启用 ${account.slot} 号`}
            </AdminButton>
            {!account.enabled && account.provider.status !== 'connected' && (
              <span>完成授权后即可启用。</span>
            )}
          </div>
          {account.enabled ? (
            <p>正在用于对话、图片和联网搜索。需要重新授权时，请先停用。</p>
          ) : (
            <CodexAuthorizationPanel
              status={account.provider.status}
              authorization={account.authorization}
              busy={busy}
              onStart={() => onAuthorize(account.slot)}
              onCancel={() => {
                if (account.authorization) onCancel(account.authorization.id);
              }}
            />
          )}
        </section>
      ))}
      <AdminButton
        type="button"
        disabled={busy || !selected}
        onClick={() => onSelect(null)}
      >
        全部停用
      </AdminButton>
    </section>
  );
}
