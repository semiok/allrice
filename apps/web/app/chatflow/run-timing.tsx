import { useEffect, useRef, useState } from 'react';
import type { TaskRuntimeTiming } from '@allrice/contracts';
import { LIVE_RUN_CLOCK_INTERVAL_MS } from './dsh-upstream/feedback/message-chrome';

export function formatRunDuration(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (ms > 0 && seconds === 0) return '不到 1 秒';
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/** DSH's one-second display cadence, anchored to Allrice's server clock.
 * This projection never changes task deadlines, active time or billing.
 */
export function RunElapsedTime({
  timing,
  running,
}: {
  timing: TaskRuntimeTiming;
  running: boolean;
}) {
  const ticking =
    running && (timing.phase === 'active' || timing.phase === 'waiting');
  const [displayMs, setDisplayMs] = useState(timing.wallMs);
  const anchor = useRef({ wallMs: timing.wallMs, at: 0, ticking: false });

  useEffect(() => {
    const now = performance.now();
    // Network receipts can arrive just behind the locally displayed second.
    // Keep the live clock monotonic; terminal receipts remain authoritative.
    const wallMs =
      ticking && anchor.current.ticking
        ? Math.max(
            timing.wallMs,
            anchor.current.wallMs + Math.max(0, now - anchor.current.at),
          )
        : timing.wallMs;
    anchor.current = { wallMs, at: now, ticking };
    setDisplayMs(wallMs);
  }, [timing.wallMs, ticking]);

  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => {
      setDisplayMs(
        anchor.current.wallMs +
          Math.max(0, performance.now() - anchor.current.at),
      );
    }, LIVE_RUN_CLOCK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [ticking]);

  return formatRunDuration(
    ticking ? Math.max(timing.wallMs, displayMs) : timing.wallMs,
  );
}
