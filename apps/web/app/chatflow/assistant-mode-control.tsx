'use client';

import { ComposerSelect } from './composer-select';
import styles from './dsh-saas.module.css';

export function AssistantModeControl({
  busy,
  isRunning,
  steering,
}: {
  busy: boolean;
  isRunning: boolean;
  steering: boolean;
}) {
  return (
    <ComposerSelect
      aria-label={isRunning ? '下一项任务模式' : '工作模式'}
      compact="mode"
      label="日常"
      icon={
        <svg
          className={styles.composerModeIcon}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z" />
        </svg>
      }
      disabled={busy || steering}
      value="daily"
      onChange={() => {}}
      title="日常问答与轻量任务"
    >
      <option value="daily">日常</option>
      <option value="boost" disabled>
        🎯 深入攻关 · 规划中
      </option>
      <option value="teamwork" disabled>
        👥 团队协作 · 规划中
      </option>
    </ComposerSelect>
  );
}
