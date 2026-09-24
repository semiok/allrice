'use client';

import catalog from '../../../../packages/dsh-runtime-diff/capabilities.json';
import upstream from '../../../worker/dsh/upstream.json';
import styles from './runtime-console.module.css';
import {
  integratedCapabilityStatus,
  runtimeCapabilityFacts,
  type RuntimeCapabilityResponse,
} from './runtime-capability-facts';

export function DshUpgradeCapabilities(props: {
  onOpenEmployees: () => void;
  inventory: RuntimeCapabilityResponse | null;
}) {
  const facts = runtimeCapabilityFacts(props.inventory);
  return (
    <section className={styles.upgradeCatalog} aria-label="DSH 升级能力">
      <header>
        <div>
          <span>在线 Worker · DSH {facts.versions.join(' / ') || '未知'}</span>
          <h2>升级能力与试用入口</h2>
          <p>
            已接入能力显示当前配置与发布状态；上游待接入能力为版本复核说明。
          </p>
          {facts.versions.some(
            (version) => version !== catalog.reviewedVersion,
          ) ? (
            <p role="status">
              能力说明复核于 {catalog.reviewedVersion}，当前版本说明待同步。
            </p>
          ) : null}
        </div>
        <button className={styles.groupAction} onClick={props.onOpenEmployees}>
          配置 Rice 并试用
        </button>
      </header>
      {catalog.groups.map((group) => (
        <section key={group.id}>
          <h3>{group.title}</h3>
          <p>
            {group.id === 'integrated'
              ? '状态来自在线 Worker、Web 功能开关和租户员工的实际发布版本。'
              : group.description}
          </p>
          <div className={styles.upgradeCards}>
            {group.items.map((item) => (
              <article key={item.id}>
                <span>
                  {group.id === 'integrated' || group.id === 'web-ui'
                    ? integratedCapabilityStatus(item.id, props.inventory)
                    : item.status}
                </span>
                <h4>{item.name}</h4>
                <p>{item.detail}</p>
                {'action' in item && item.action === 'employees' ? (
                  <button onClick={props.onOpenEmployees}>配置并试用 →</button>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ))}
      <a
        href="https://github.com/semiok/allrice/blob/main/docs/architecture/dsh-reuse-and-replacement.md"
        target="_blank"
        rel="noreferrer"
      >
        查看复用清单与接入进度 →
      </a>
    </section>
  );
}

export function DshReleaseSummary(props: { onOpenCapabilities: () => void }) {
  return (
    <div className={styles.releaseSummary}>
      <span>当前构建 · DSH {upstream.version}</span>
      <button onClick={props.onOpenCapabilities}>查看升级能力 →</button>
    </div>
  );
}
