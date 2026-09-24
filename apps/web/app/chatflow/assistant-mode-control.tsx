'use client';

import inputUi from './dsh-upstream/InputBar.module.css';
import ui from './assistant-workbench.module.css';

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
    <select
      aria-label={isRunning ? '下一项任务模式' : '工作模式'}
      className={`${inputUi.select} ${ui.mode}`}
      disabled={busy || steering}
      value="daily"
      onChange={() => {}}
      title="日常问答与轻量任务"
    >
      <option value="daily">⚡ 日常</option>
      <option value="boost" disabled>
        🎯 深入攻关 · 规划中
      </option>
      <option value="teamwork" disabled>
        👥 团队协作 · 规划中
      </option>
    </select>
  );
}
