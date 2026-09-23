'use client';

import type { AssistantTreeView } from '@allrice/database';
import {
  assistantMessageLabel,
  assistantStateLabel,
  presentAssistantTree,
} from '../../lib/chatflow/assistant-tree-presenter';
import ui from './assistant-workbench.module.css';

export function AssistantTreeCard({
  tree,
  detailed,
  busy,
  error,
  onExpand,
  onStopChild,
  onCancelRoot,
  onArtifact,
}: {
  tree: AssistantTreeView;
  detailed: boolean;
  busy: boolean;
  error: string;
  onExpand: (expanded: boolean) => void;
  onStopChild: (id: string) => void;
  onCancelRoot: () => void;
  onArtifact: (id: string) => void;
}) {
  const state = presentAssistantTree(tree);
  return (
    <section
      className={ui.panel}
      aria-label="助手任务"
      id={`assistants-${tree.rootRunId}`}
    >
      <div className={ui.header}>
        <strong>{state.label}</strong>
        <span className={ui.meta}>本任务模式：日常</span>
      </div>
      <p className={ui.meta}>{state.summary}</p>
      {tree.timing ? (
        <p className={ui.meta}>
          活跃 {Math.floor(tree.timing.activeMs / 60000)} 分钟 · 等待{' '}
          {Math.floor(tree.timing.waitingMs / 60000)} 分钟 · 总历时{' '}
          {Math.floor(tree.timing.wallMs / 60000)} 分钟
          {' · '}任务时限{' '}
          {tree.timing.timeoutMs === 0
            ? '不限制'
            : `${tree.timing.timeoutMs / 60000} 分钟`}
          {tree.timing.phase === 'waiting'
            ? '（整项任务等待中，活跃计时暂停）'
            : ''}
          {tree.timing.calls
            ? ` · 原生模型请求尝试 ${tree.timing.calls.modelRequests} 次 / 工具 ${tree.timing.calls.toolCalls} 次（仅统计）`
            : ''}
          {tree.timing.sources.length
            ? ` · 策略来源：${tree.timing.sources.map((s) => `${({ tenant: '租户', user: '用户', employee: '员工', provider: '模型连接' } as Record<string, string>)[s.scope] ?? s.scope} ${s.timeoutMs === 0 ? '不限制' : `${s.timeoutMs / 60000} 分钟`}`).join('、')}`
            : ' · 来源：平台默认'}
        </p>
      ) : null}
      {error ? (
        <p className={ui.alert} role="alert">
          {error}
        </p>
      ) : null}
      {state.attention.length ? (
        <p className={ui.alert} role="status">
          {state.attention
            .map((item) => `${item.label}：${assistantStateLabel[item.status]}`)
            .join('；')}
          。 等待审批的动作需在对应审批卡片处理，聊天回复不等于授权。
        </p>
      ) : null}
      {state.unconfirmedStops.length ? (
        <p className={ui.alert} role="status">
          已请求停止不代表进程已退出；等待执行端确认。已经发生的外部动作不一定能撤回。
        </p>
      ) : null}
      <div className={ui.actions}>
        <button
          type="button"
          disabled={busy || tree.cancelRequested || !state.hasLiveWork}
          onClick={onCancelRoot}
        >
          取消整项任务（含所有助手）
        </button>
        <small className={ui.meta}>Run {tree.rootRunId.slice(0, 8)}</small>
      </div>
      <details
        onToggle={(event) => {
          if (event.target === event.currentTarget)
            onExpand(event.currentTarget.open);
        }}
      >
        <summary>分工、结果与消耗</summary>
        {!detailed ? <p className={ui.meta}>正在读取权威明细…</p> : null}
        <ul className={ui.tree}>
          {state.children.map((child) => {
            const results = tree.results.filter(
              (result) => result.runId === child.runId,
            );
            const messages = tree.messages.filter(
              (message) => message.childRunId === child.runId,
            );
            return (
              <li
                key={child.runId}
                className={ui.child}
                style={{
                  marginInlineStart: `${Math.min(child.depth - 1, 2) * 12}px`,
                }}
              >
                <div className={ui.header}>
                  <strong>{child.label}</strong>
                  <span>
                    {assistantStateLabel[child.status] ?? '状态待核实'}
                  </span>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !!child.cancelRequestedAt ||
                      !!child.stoppedAt ||
                      ['completed', 'partial', 'failed', 'canceled'].includes(
                        child.status,
                      )
                    }
                    onClick={() => onStopChild(child.runId)}
                  >
                    停止这个助手
                  </button>
                </div>
                <p className={ui.meta}>
                  独立任务 {child.runId.slice(0, 8)} · 第 {child.depth} 层
                  {child.parentRunId !== tree.rootRunId
                    ? ` · 上级 ${child.parentRunId?.slice(0, 8)}`
                    : ' · 由 Rice 统筹'}
                  {child.stoppedAt ? ' · 执行端已确认停止' : ''}
                </p>
                {results.map((result) => (
                  <div key={result.deliveryId}>
                    <strong>
                      结果：{assistantStateLabel[result.status] ?? '待核实'}
                    </strong>
                    <p className={ui.result}>{result.summary}</p>
                    {result.incomplete.length ? (
                      <p className={ui.alert}>
                        未完成：{result.incomplete.join('；')}
                      </p>
                    ) : null}
                    <p className={ui.meta}>
                      {result.parentAdoptedSeq === null
                        ? '已收到汇报；主 Rice 尚未确认采用'
                        : `主 Rice 已采用 · 原生记录 #${result.parentAdoptedSeq}`}
                      {result.usageComplete
                        ? ''
                        : ' · 消耗尚未结清，不能视作零消耗'}
                    </p>
                    {result.evidence.length ? (
                      <ul aria-label="结果关联工件">
                        {result.evidence.map((evidence) => (
                          <li key={`${evidence.id}/${evidence.digest}`}>
                            <button
                              type="button"
                              onClick={() => onArtifact(evidence.id)}
                            >
                              查看关联工件
                            </button>{' '}
                            <small className={ui.meta} title={evidence.digest}>
                              版本 {evidence.digest.slice(7, 19)}
                            </small>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className={ui.meta}>
                        此汇报未附可追溯工件，不应视为已完成证据。
                      </p>
                    )}
                    {result.evidence.length ? (
                      <p className={ui.meta}>
                        工件可追溯不代表内容已独立核实；请查看来源标注与具体内容。
                      </p>
                    ) : null}
                  </div>
                ))}
                {detailed && !results.length ? (
                  <p className={ui.meta}>尚无已持久化的结果汇报。</p>
                ) : null}
                {messages.length ? (
                  <details>
                    <summary>消息交付记录 · {messages.length}</summary>
                    <ul>
                      {messages.map((message) => (
                        <li key={message.inputId}>
                          {assistantMessageLabel[message.status] ??
                            '状态待核实'}
                          <small className={ui.meta}>
                            {' '}
                            · {message.inputId.slice(0, 8)}
                          </small>
                          <p className={ui.result}>{message.text}</p>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className={ui.budget} aria-label="根任务共享预算">
          {tree.budgets.map((budget) => (
            <span key={budget.metric}>
              {(
                {
                  model_calls: '模型调用',
                  tool_calls: '工具调用',
                  input_tokens: '输入 Token',
                  output_tokens: '输出 Token',
                  wall_time: '运行时间',
                  cost: '费用',
                } as Record<string, string>
              )[budget.metric] ?? budget.metric}
              ：已记录 {budget.spent}{' '}
              {budget.enforced === false
                ? ' · 仅统计'
                : `/ 上限 ${budget.capacity}`}{' '}
              {budget.unit}
              {budget.reserved
                ? ` · ${budget.enforced === false ? '待核对估算' : '在途预留'} ${budget.reserved}`
                : ''}
              {budget.usageComplete ? '' : ' · 总用量尚未结清'}
            </span>
          ))}
        </div>
        <p className={ui.meta}>
          所有助手共用根任务预算；独立上下文不代表额外工具授权或操作系统隔离。
          消息与结果各展示最近 64 条；消息正文为最多 2000
          字符的预览，不是全量审计日志。
        </p>
      </details>
    </section>
  );
}
