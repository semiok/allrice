'use client';

import { useState } from 'react';
import { AdminIcon } from '../../components/admin/admin-ui';
import {
  runtimeSkillEntries,
  runtimeTimelineStatus,
  type RuntimeTimelineItem,
} from './runtime-timeline';
import styles from './runtime-console.module.css';

export function RuntimeSkillGroup({
  item,
}: {
  item: Extract<RuntimeTimelineItem, { type: 'group' }>;
}) {
  const entries = item.events.flatMap(runtimeSkillEntries);
  const problems = entries.filter(
    (event) => runtimeTimelineStatus(event.status).tone === 'danger',
  );
  const failureKey = problems
    .map((event) => `${event.key}:${event.status}`)
    .join('|');
  const [expanded, setExpanded] = useState<{
    failures: string;
    open: boolean;
  } | null>(null);
  // Preserve the user's choice during polling, but reveal a newly arrived
  // failure even if the successful batch was previously collapsed manually.
  const open =
    expanded?.failures === failureKey ? expanded.open : problems.length > 0;
  const status = runtimeTimelineStatus(item.status);
  const failures = entries.filter((event) =>
    ['failed', 'error'].includes(event.status.toLowerCase()),
  ).length;
  return (
    <li
      className={`${styles.eventGroup} ${styles.skillGroup}`}
      data-kind={item.kind}
      data-category="prepare"
      data-event-key={item.key}
      data-skill-phase={item.skillPhase}
    >
      <i className={styles.eventNode} aria-hidden="true">
        <AdminIcon name="folder" />
      </i>
      <div className={styles.eventBody}>
        <details open={open}>
          <summary
            className={styles.eventRow}
            aria-expanded={open}
            onClick={(event) => {
              event.preventDefault();
              setExpanded({ failures: failureKey, open: !open });
            }}
          >
            <span className={styles.eventPrimary}>
              <strong>{item.title}</strong>
              <span
                className={styles.eventStatus}
                data-tone={status.tone}
                data-state={item.status}
              >
                {status.icon && <AdminIcon name={status.icon} />}
                {failures ? `${failures} 项失败` : status.label}
              </span>
            </span>
            <span className={styles.eventEnd}>
              <SkillTime value={item.occurredAt} />
              <span className={styles.eventChevron} aria-hidden="true">
                <AdminIcon name="chevron" />
              </span>
            </span>
          </summary>
          <ol className={styles.skillList} aria-label={`${item.title}明细`}>
            {entries.map((entry) => {
              const state = runtimeTimelineStatus(entry.status);
              return (
                <li key={entry.key} data-event-key={entry.key}>
                  <span className={styles.skillName}>
                    {entry.detail ?? '未记录技能名称'}
                    {state.tone !== 'success' && (
                      <span
                        className={styles.eventStatus}
                        data-tone={state.tone}
                      >
                        {state.icon && <AdminIcon name={state.icon} />}
                        {state.label}
                      </span>
                    )}
                  </span>
                  <SkillTime value={entry.occurredAt} />
                </li>
              );
            })}
          </ol>
        </details>
      </div>
    </li>
  );
}

function SkillTime({ value }: { value: string | null }) {
  return (
    <time dateTime={value ?? undefined} title={value ?? undefined}>
      {value
        ? new Intl.DateTimeFormat('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }).format(new Date(value))
        : '—'}
    </time>
  );
}
