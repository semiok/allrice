'use client';

import ui from './assistant-workbench.module.css';

export function AssistantModeControl({
  allowAssistants,
  eligible,
  busy,
  isRunning,
  steering,
  onChange,
}: {
  allowAssistants: boolean;
  eligible: boolean;
  busy: boolean;
  isRunning: boolean;
  steering: boolean;
  onChange: (allow: boolean) => void;
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
            ? '当前员工未开放助手能力，由 Rice 独立处理。'
            : allowAssistants
              ? 'Rice 可按任务需要安排有限助手；受既有权限与总预算约束。'
              : '本次任务只由 Rice 处理，不允许新增助手。'}
        {isRunning && !steering ? ' 不改变正在运行的任务。' : ''}
      </small>
    </fieldset>
  );
}
