'use client';

import { useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';

import styles from './history-refresh-notice.module.css';

/** The newest read of the conversation failed; read it again on request. */
export function HistoryRefreshNotice({
  onRefresh,
}: {
  onRefresh: () => Promise<unknown>;
}) {
  const [state, setState] = useState<'idle' | 'refreshing' | 'failed'>('idle');
  return (
    <div className={styles.notice} role="status">
      <span>
        {state === 'failed'
          ? '刷新未完成，请检查网络后再试'
          : '对话内容可能不是最新的'}
      </span>
      <Button
        size="sm"
        variant="ghost"
        disabled={state === 'refreshing'}
        onClick={() => {
          setState('refreshing');
          onRefresh().then(
            () => setState('idle'),
            () => setState('failed'),
          );
        }}
      >
        {state === 'refreshing' ? '正在刷新…' : '刷新'}
      </Button>
    </div>
  );
}
