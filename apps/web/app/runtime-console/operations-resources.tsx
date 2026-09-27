import type { OperationsInventory } from '@allrice/contracts';
import styles from './runtime-console.module.css';

export function operationsFacts(
  inventory: OperationsInventory | null | undefined,
) {
  const workers = inventory?.workers.filter((worker) => worker.online) ?? [];
  const nodes = new Map<
    string,
    NonNullable<(typeof workers)[number]['sandbox']>
  >();
  // Several Workers may share one Docker host. Its memory/slots count once.
  for (const worker of workers) {
    if (
      worker.sandboxStatus === 'ready' &&
      worker.sandbox &&
      !nodes.has(worker.sandbox.backendId)
    )
      nodes.set(worker.sandbox.backendId, worker.sandbox);
  }
  const pressure = workers.find((worker) => worker.pressure)?.pressure ?? null;
  return { workers, nodes: [...nodes.values()], pressure };
}

function memory(bytes: number) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
function duration(ms: number) {
  return ms < 1000
    ? '0 秒'
    : ms < 60_000
      ? `${Math.floor(ms / 1000)} 秒`
      : `${Math.floor(ms / 60_000)} 分 ${Math.floor((ms % 60_000) / 1000)} 秒`;
}
function observed(at: string) {
  return new Date(at).toLocaleString('zh-CN', { hour12: false });
}

export function OperationsSummary({
  inventory,
}: {
  inventory?: OperationsInventory | null;
}) {
  const { nodes, pressure } = operationsFacts(inventory);
  return (
    <>
      <div>
        <span>云端计算 · 使用 / 槽位</span>
        <strong>
          {nodes.length
            ? `${nodes.reduce((n, node) => n + node.running, 0)} / ${nodes.reduce((n, node) => n + node.slots, 0)}`
            : '—'}
        </strong>
      </div>
      <div>
        <span>等待计算 / 数据库阻塞</span>
        <strong>
          {pressure
            ? `${pressure.resources.waiting} / ${pressure.blocked.length}`
            : '—'}
        </strong>
      </div>
    </>
  );
}

export function OperationsResources({
  inventory,
}: {
  inventory?: OperationsInventory | null;
}) {
  const { nodes, pressure } = operationsFacts(inventory);
  return (
    <details className={styles.operations}>
      <summary>
        <strong>运维资源</strong>
        <span>
          {nodes.length
            ? nodes
                .map(
                  (node) =>
                    `${node.cpus} vCPU · ${memory(node.memoryBytes)} · ${node.slots} 个计算槽位`,
                )
                .join('；')
            : '暂无有效的云端资源报告'}
        </span>
        <small>查看详情</small>
      </summary>
      <p className={styles.operationsNote}>
        每 30 秒采样；超过 90
        秒未上报标记为离线。计算槽位由实际资源自动计算，任务等待模型时不占计算槽位。
      </p>
      <div className={styles.operationsGrid}>
        {nodes.map((node) => (
          <section key={node.backendId}>
            <h2>
              云端沙箱
              {nodes.length > 1 ? ` · ${node.backendId.slice(0, 8)}` : ''}
            </h2>
            <dl>
              <dt>CPU / 内存总量</dt>
              <dd>
                {node.cpus} vCPU / {memory(node.memoryBytes)}
              </dd>
              <dt>可用内存</dt>
              <dd>{memory(node.availableBytes)}</dd>
              <dt>系统预留 / 其他服务预算</dt>
              <dd>
                {memory(node.reservedBytes)} / {memory(node.servicesBytes)}
              </dd>
              <dt>正在计算 / 总槽位</dt>
              <dd>
                {node.running} / {node.slots}
              </dd>
              <dt>单槽位预算</dt>
              <dd>512 MiB 脚本 + 128 MiB 运行开销</dd>
            </dl>
            <p>
              其他服务预算包括文档预览等常驻容器；可用内存包含系统可回收缓存。
            </p>
          </section>
        ))}
        {inventory?.workers.map((worker) => (
          <section key={worker.workerId}>
            <h2>
              {worker.hostname}{' '}
              <span
                className={
                  worker.online
                    ? styles.operationsOnline
                    : styles.operationsOffline
                }
              >
                {worker.online ? '在线' : '离线 · 历史采样'}
              </span>
            </h2>
            <dl>
              <dt>Worker 所在系统</dt>
              <dd>
                {worker.platform} · {worker.capacity.cpus} 逻辑 CPU ·{' '}
                {memory(worker.capacity.memoryBytes)}
              </dd>
              <dt>Worker 可用内存 / 进程占用</dt>
              <dd>
                {memory(worker.availableMemoryBytes)} /{' '}
                {memory(worker.rssBytes)}
              </dd>
              <dt>任务并发上限</dt>
              <dd>
                {worker.capacity.concurrency} ·{' '}
                {worker.capacity.mode === 'auto'
                  ? '启动时自动计算'
                  : '显式配置'}
              </dd>
              <dt>云端探测</dt>
              <dd>
                {!worker.online
                  ? '报告已过期，当前状态未知'
                  : worker.sandboxStatus === 'ready'
                    ? '正常'
                    : worker.sandboxStatus === 'disabled'
                      ? '平台已停用'
                      : '暂不可用，等待下一次探测'}
              </dd>
              <dt>采样时间</dt>
              <dd>{observed(worker.observedAt)}</dd>
            </dl>
          </section>
        ))}
        <section>
          <h2>平台排队与阻塞</h2>
          {pressure ? (
            <dl>
              <dt>进行中任务 / 待领取</dt>
              <dd>
                {pressure.jobs.active} / {pressure.jobs.queued}
              </dd>
              <dt>等待云端计算 / 执行中请求</dt>
              <dd>
                {pressure.resources.waiting} / {pressure.resources.executing}
              </dd>
              <dt>最久待领取</dt>
              <dd>{duration(pressure.jobs.longest_wait_ms)}</dd>
              <dt>数据库锁等待</dt>
              <dd>
                {pressure.blocked.length}
                {pressure.blocked.length
                  ? ` · 最久 ${duration(Math.max(...pressure.blocked.map((lock) => lock.wait_ms ?? 0)))}`
                  : ''}
              </dd>
            </dl>
          ) : (
            <p>暂无有效的排队采样，当前状态未知。</p>
          )}
          <p>
            排队与阻塞来自平台全局采样，不随公司或员工筛选变化。历史变化已记录在
            Worker 运维日志中。
          </p>
        </section>
      </div>
    </details>
  );
}
