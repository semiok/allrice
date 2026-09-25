'use client';

import { useEffect, useState } from 'react';
import styles from './dsh-saas.module.css';

export function WorkspaceStartup({ error }: { error: string }) {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setDelayed(true), 15_000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className={styles.loading}>
      <section className={styles.startup} aria-label="进入工作区">
        <p role={error ? 'alert' : 'status'}>
          {error
            ? '暂时无法进入工作区'
            : delayed
              ? '连接用时较长'
              : '正在进入 AllRice ChatFlow…'}
        </p>
        {(error || delayed) && (
          <>
            <p className={styles.startupHint}>
              {error
                ? '连接暂时不可用，请稍后重试。'
                : '你可以继续等待，或重新连接工作区。'}
            </p>
            <button type="button" onClick={() => window.location.reload()}>
              重新连接
            </button>
          </>
        )}
      </section>
    </main>
  );
}
