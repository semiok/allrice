'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import {
  allriceBrandColors,
  allriceRiceGrains,
} from '../../lib/brand/rice-star';
import styles from './workspace-startup.module.css';

// The vector master is counterclockwise; the loading highlight starts at the top.
const clockwiseGrains = [0, 7, 6, 5, 4, 3, 2, 1] as const;

export function WorkspaceStartup({ error }: { error: string }) {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setDelayed(true), 15_000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className={styles.loading}>
      <section
        className={styles.startup}
        aria-label="进入工作区"
        data-failed={Boolean(error)}
      >
        <svg
          className={styles.mark}
          viewBox="0 0 512 512"
          width="52"
          height="52"
          aria-hidden="true"
          focusable="false"
        >
          <g fill="currentColor">
            {allriceRiceGrains.map((path) => (
              <path key={path} d={path} />
            ))}
          </g>
          <g fill={allriceBrandColors.gold}>
            {clockwiseGrains.map((sourceIndex, index) => (
              <path
                key={sourceIndex}
                d={allriceRiceGrains[sourceIndex]}
                className={styles.grain}
                data-grain={sourceIndex}
                style={{ '--grain-phase': (index - 8) / 8 } as CSSProperties}
              />
            ))}
          </g>
        </svg>
        <div className={styles.wordmark}>AllRice</div>
        <p className={styles.tagline} lang="en">
          Do it right. Make it nice.
        </p>
        <p className={styles.status} role={error ? 'alert' : 'status'}>
          {error
            ? '暂时无法进入工作区'
            : delayed
              ? '连接用时较长'
              : '正在进入工作台'}
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
