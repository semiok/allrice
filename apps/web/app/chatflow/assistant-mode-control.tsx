'use client';

import ui from './assistant-workbench.module.css';
import type { AssistantUnavailableReason } from './assistant-eligibility';
import type { WorkspaceCapability } from '@allrice/contracts';

export function AssistantModeControl({
  allowAssistants,
  eligible,
  unavailableReason,
  busy,
  isRunning,
  steering,
  onChange,
  readinessState,
  onShowCapabilities,
}: {
  allowAssistants: boolean;
  eligible: boolean;
  unavailableReason?: AssistantUnavailableReason | null;
  busy: boolean;
  isRunning: boolean;
  steering: boolean;
  onChange: (allow: boolean) => void;
  readinessState?: WorkspaceCapability['state'];
  onShowCapabilities?: () => void;
}) {
  return (
    <fieldset className={ui.mode} disabled={busy || steering}>
      <legend>{isRunning ? '下一项任务' : '工作方式'}</legend>
      <label>
        模式
        <select aria-label="下一项任务模式" value="daily" onChange={() => {}}>
          <option value="daily">日常</option>
          <option value="boost" disabled>
            深入攻关 · 尚未开放
          </option>
          <option value="teamwork" disabled>
            团队任务 · 尚未开放
          </option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={!allowAssistants || !eligible}
          disabled={!eligible || busy || steering}
          onChange={(event) => onChange(!event.target.checked)}
        />
        本次不使用助手
      </label>
      <small>
        {steering
          ? '正在补充当前回合，此处不会更改当前任务配置。'
          : !eligible
            ? readinessState === 'unknown'
              ? '助手状态待确认，由 Rice 独立处理；可刷新能力状态。'
              : readinessState === 'not_released' ||
                  unavailableReason === 'feature_disabled'
                ? '当前部署尚未开放助手，由 Rice 独立处理。'
                : readinessState && readinessState !== 'ready'
                  ? '助手条件尚未满足，由 Rice 独立处理；请查看能力与环境。'
                  : unavailableReason === 'model_unsupported'
                    ? '当前模型暂不支持助手，由 Rice 独立处理。'
                    : '当前员工未开放助手能力，由 Rice 独立处理。'
            : allowAssistants
              ? 'Rice 可按任务需要安排有限助手；受既有权限与总预算约束。'
              : '本次任务只由 Rice 处理，不允许新增助手。'}
        {isRunning && !steering ? ' 不改变正在运行的任务。' : ''}
      </small>
      {onShowCapabilities ? (
        <button type="button" onClick={onShowCapabilities}>
          查看助手条件
        </button>
      ) : null}
    </fieldset>
  );
}
