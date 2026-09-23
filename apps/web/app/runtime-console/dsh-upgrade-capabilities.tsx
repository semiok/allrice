'use client';

import catalog from '../../../../packages/dsh-runtime-diff/capabilities.json';
import upstream from '../../../worker/dsh/upstream.json';
import styles from './runtime-console.module.css';

export function DshUpgradeCapabilities(props: { onOpenEmployees: () => void }) {
  return (
    <section className={styles.upgradeCatalog} aria-label="DSH 升级能力">
      <header>
        <div>
          <span>当前构建 · DSH {upstream.version}</span>
          <h2>升级能力与试用入口</h2>
          <p>已接入的能力与上游可复用能力默认展示，按任务选择需要的能力。</p>
          {catalog.reviewedVersion !== upstream.version ? (
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
          <p>{group.description}</p>
          <div className={styles.upgradeCards}>
            {group.items.map((item) => (
              <article key={item.id}>
                <span>{item.status}</span>
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
