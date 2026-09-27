import type { TenantRunInspection } from '@allrice/contracts';

const reasons: Record<string, string> = {
  worker_capacity: '等待任务调度',
  sandbox_capacity: '等待计算资源',
  memory_pressure: '执行节点内存紧张',
  fair_queue: '等待其他租户领取后轮转',
  model_response: '等待模型响应',
  none: '无资源等待',
};
const stages: Record<string, string> = {
  queued: '进入队列',
  waiting: '等待资源',
  acquired: '已领取资源',
  executing: '正在执行',
  completed: '执行完成',
  failed: '执行失败',
  canceled: '已取消',
  unknown: '结果待核对',
  cleaned: '已清理',
};
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;
export function ExecutionDiagnostics({
  data,
}: {
  data: NonNullable<TenantRunInspection['executionDiagnostics']>;
}) {
  return (
    <section aria-label="执行排队与阻塞诊断">
      <h5>排队与执行诊断</h5>
      <p>
        任务调度等待：{seconds(data.queueMs)} · 当前：
        {data.currentWait
          ? (reasons[data.currentWait] ?? data.currentWait)
          : data.jobState}
      </p>
      <p>
        最近工作进展：
        {data.recentProgressAt
          ? new Date(data.recentProgressAt).toLocaleString()
          : '尚无完成步骤'}{' '}
        · Worker：{data.workerId ?? '未占用'}
      </p>
      {data.resources.map((r) => (
        <article key={r.id}>
          <strong>{stages[r.state] ?? r.state}</strong> ·{' '}
          {reasons[r.reason] ?? r.reason}
          <p>
            资源等待 {seconds(r.waitMs)} · 执行 {seconds(r.executionMs)} ·
            节点容量 {r.capacity ?? '尚未探测'}
          </p>
          <small>
            执行 {r.id} · 工具调用 {r.callId}
            {r.errorCode ? ` · ${r.errorCode}` : ''}
          </small>
        </article>
      ))}
      <details>
        <summary>诊断日志 · {data.events.length}</summary>
        {data.events.map((e, i) => (
          <p key={i}>
            {new Date(e.at).toLocaleString()} · {stages[e.stage] ?? e.stage}
            {e.reason && e.reason !== 'none'
              ? ` · ${reasons[e.reason] ?? e.reason}`
              : ''}
            {e.errorCode ? ` · ${e.errorCode}` : ''}{' '}
            <small>{e.attemptId}</small>
          </p>
        ))}
        {!data.events.length ? (
          <p>暂无资源调度日志；模型与工具步骤可查看运行摘要。</p>
        ) : null}
        {data.truncated ? (
          <p>这里展示最近的日志，完整记录保留在后台审计数据中。</p>
        ) : null}
      </details>
    </section>
  );
}
