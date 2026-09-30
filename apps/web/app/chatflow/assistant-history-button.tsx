'use client';

import { useRef, useState } from 'react';
import styles from './dsh-saas.module.css';

export function AssistantHistoryButton({
  onLoadMore,
}: {
  onLoadMore: () => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const pending = useRef(false);
  return (
    <div className={styles.assistantHistoryRow}>
      <button
        type="button"
        className={styles.assistantHistoryButton}
        aria-label="加载更早的助手任务记录"
        aria-busy={loading}
        disabled={loading}
        onClick={async () => {
          if (pending.current) return;
          pending.current = true;
          setLoading(true);
          try {
            await onLoadMore();
          } finally {
            pending.current = false;
            setLoading(false);
          }
        }}
      >
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7M12 7v5l3 2" />
        </svg>
        <span role="status">{loading ? '正在加载…' : '查看更早记录'}</span>
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m7 14 5-5 5 5" />
        </svg>
      </button>
    </div>
  );
}
