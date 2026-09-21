'use client';

import { useEffect, useRef, useState } from 'react';
import {
  RuntimeLocalCommandResultSchema,
  projectDiagnosticLabels,
  type RuntimeActionApprovalSnapshot,
  type RuntimeLocalCommand,
  type RuntimeOperationSnapshot,
} from '@allrice/contracts';
import styles from './local-command-panel.module.css';
import { LocalServiceCard, type LocalServiceView } from './local-service-card';
import { CommandCandidatePreview } from './command-candidate-preview';

interface Operation {
  snapshot: RuntimeOperationSnapshot;
  command: RuntimeLocalCommand['arguments'];
  approval: RuntimeActionApprovalSnapshot | null;
  output: { sequence: number; stream: 'stdout' | 'stderr'; content: string }[];
  evidence: { summary: string; output?: unknown } | null;
  service?: LocalServiceView | null;
  candidateState?: 'current' | 'stale' | 'unavailable' | null;
}
const statusLabels: Record<string, string> = {
  planned: '正在准备',
  waiting_user: '等待操作授权',
  ready: '等待 Bridge',
  dispatched: '已派发，尚未确认执行',
  running: '正在本地执行',
  cancel_requested: '正在停止，尚未确认',
  canceled: '已确认停止',
  succeeded: '命令执行成功',
  failed: '命令未成功',
  unknown: '执行结果待核实',
  partial: '部分完成',
};

export function LocalCommandPanel({
  runId,
  workspaceId,
  tenantHeaders,
  runActive,
  onServiceChanged,
}: {
  runId: string;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  runActive: boolean;
  onServiceChanged?: () => void;
}) {
  const [operations, setOperations] = useState<Operation[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const responses = useRef(new Map<string, unknown>());
  const api = `/api/v1/runtime/local-commands?workspaceId=${encodeURIComponent(workspaceId)}&runId=${encodeURIComponent(runId)}`;
  const headerKey = JSON.stringify(tenantHeaders);
  const active =
    runActive ||
    operations.some(
      (o) =>
        !['succeeded', 'failed', 'canceled', 'partial'].includes(
          o.snapshot.status,
        ),
    );
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch(api, {
          cache: 'no-store',
          headers: JSON.parse(headerKey) as Record<string, string>,
          signal: abort.signal,
        });
        if (response.status === 404) return; // Feature is off, not an empty execution result.
        if (!response.ok) throw Error('本地命令状态读取失败，请刷新重试');
        const data = (await response.json()) as { operations: Operation[] };
        if (!abort.signal.aborted) {
          setOperations(data.operations);
          setError('');
        }
      } catch (e) {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : '读取失败');
      }
      if (active && !abort.signal.aborted)
        timer = setTimeout(() => void load(), 1500);
    };
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, headerKey, active, revision]);

  async function act(
    op: Operation,
    decision: 'approved' | 'rejected' | 'cancel',
  ) {
    const request = op.approval?.request;
    if (busy || (decision !== 'cancel' && !request)) return;
    if (
      decision === 'approved' &&
      op.command.candidate &&
      op.candidateState !== 'current'
    )
      return;
    const id = op.snapshot.binding.attempt.operationId;
    setBusy(id);
    setError('');
    try {
      let body: unknown;
      if (request && decision !== 'cancel') {
        const key = `${request.approvalId}:${decision}`;
        if (!responses.current.has(key))
          responses.current.set(key, {
            contractVersion: 1,
            direction: 'response',
            kind: 'action_approval',
            requestId: request.requestId,
            version: request.version,
            requestDigest: request.requestDigest,
            task: request.task,
            responseId: crypto.randomUUID(),
            respondedBy: request.respondentId,
            respondedAt: new Date().toISOString(),
            approvalId: request.approvalId,
            decision,
          });
        body = responses.current.get(key);
      }
      const result = await fetch(
        decision === 'cancel'
          ? api
          : `/api/v1/runtime/approvals/${request!.approvalId}`,
        {
          method: 'POST',
          headers: {
            ...tenantHeaders,
            'x-allrice-workspace-id': workspaceId,
            'content-type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
      if (!result.ok)
        throw Error(
          '操作未确认：授权可能已过期或已在其他页面处理，请刷新状态后重试。',
        );
      setRevision((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '请求失败');
    } finally {
      setBusy(null);
    }
  }
  if (!operations.length && !error) return null;
  return (
    <section className={styles.root} aria-label="本地命令审批与执行">
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRevision((v) => v + 1)}>
            重试
          </button>
        </p>
      )}
      {operations.map((op) => {
        const id = op.snapshot.binding.attempt.operationId,
          request = op.approval?.request;
        const pending =
          request &&
          !op.approval?.response &&
          !op.approval?.revokedAt &&
          Date.parse(request.expiresAt) > Date.now() &&
          op.snapshot.status === 'waiting_user';
        const result = RuntimeLocalCommandResultSchema.safeParse(
          op.evidence?.output,
        );
        return (
          <article
            key={id}
            id={`operation-${id}`}
            data-status={op.snapshot.status}
          >
            <header>
              <strong>
                {op.command.diagnostics
                  ? '项目环境诊断 · 操作授权'
                  : op.command.dependencies
                    ? '依赖准备与验证 · 操作授权'
                    : '本地命令 · 操作授权'}
              </strong>
              <span>
                {statusLabels[op.snapshot.status] ?? op.snapshot.status}
              </span>
            </header>
            <p>
              在你的电脑的 Linux
              隔离副本中执行；项目进程无网络，不会写回原工作区。
            </p>
            {op.command.background && (
              <LocalServiceCard
                config={op.command.background}
                service={op.service}
                runId={runId}
                workspaceId={workspaceId}
                tenantHeaders={tenantHeaders}
                onChanged={() => {
                  setRevision((v) => v + 1);
                  onServiceChanged?.();
                }}
              />
            )}
            {op.command.dependencies && (
              <section aria-label="依赖安装授权范围">
                <p>
                  先运行 npm
                  ci，再执行下方验证命令；安装位置为本次临时隔离副本，结束后销毁，不安装到本机全局或原工作区。
                </p>
                <p>
                  安装生命周期脚本：
                  {op.command.dependencies.scripts === 'disabled'
                    ? '禁止（--ignore-scripts）'
                    : '明确允许在隔离副本执行；仍无网络和主机权限'}
                  。最多 8 个锁定包，归档合计不超过 128 KiB。
                </p>
                <ul>
                  {op.command.dependencies.packages.map((p) => (
                    <li key={`${p.name}@${p.version}`}>
                      <code>
                        {p.name}@{p.version}
                      </code>
                      <small>
                        {p.archivePath
                          ? `使用已授权归档：${p.archivePath}`
                          : '由 Bridge 从 registry.npmjs.org 下载；不传送源码或凭证'}
                      </small>
                      <small>{p.integrity}</small>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {op.command.candidate && (
              <CommandCandidatePreview
                key={op.command.candidate.checksum}
                candidate={op.command.candidate}
                state={op.candidateState}
              />
            )}
            <pre aria-label="待执行命令">
              {op.command.executable}
              {op.command.args.map((arg) => ` ${JSON.stringify(arg)}`).join('')}
            </pre>
            <p>
              工作目录：<code>{op.command.path}</code> · 时限{' '}
              {op.command.background
                ? `服务硬期限 ${op.command.background.durationMs / 1000}`
                : op.command.limits.timeoutMs / 1000}{' '}
              秒 · 内存 {op.command.limits.memoryMiB} MiB · 最多{' '}
              {op.command.limits.pids} 个进程
            </p>
            <details>
              <summary>
                查看 {op.command.files.length} 个输入文件及精确版本
              </summary>
              <ul>
                {op.command.files.map((f) => (
                  <li key={f.path}>
                    <code>{f.path}</code>
                    <small>{f.sha256}</small>
                  </li>
                ))}
              </ul>
              <small>工具链 {op.command.imageDigest}</small>
            </details>
            {pending && (
              <div className={styles.actions}>
                <button
                  disabled={
                    busy !== null ||
                    (!!op.command.candidate && op.candidateState !== 'current')
                  }
                  type="button"
                  onClick={() => void act(op, 'approved')}
                >
                  批准这一次执行
                </button>
                <button
                  disabled={busy !== null}
                  type="button"
                  onClick={() => void act(op, 'rejected')}
                >
                  拒绝
                </button>
                <small>此授权仅适用于上面的命令、参数、文件版本和环境。</small>
              </div>
            )}
            {op.approval?.response && (
              <p>
                你的决定：
                {op.approval.response.decision === 'approved'
                  ? '已批准这一次执行（不等于已完成）'
                  : '已拒绝'}
              </p>
            )}
            {!pending &&
              ['running', 'dispatched', 'ready', 'waiting_user'].includes(
                op.snapshot.status,
              ) && (
                <button
                  disabled={busy !== null}
                  type="button"
                  onClick={() => void act(op, 'cancel')}
                >
                  停止本轮本地命令
                </button>
              )}
            {op.evidence && <p>{op.evidence.summary}</p>}
            {result.success && result.data.candidate && (
              <p>
                已运行的候选版本：
                <code>{result.data.candidate.artifactId}</code> · 输入摘要{' '}
                <code>{result.data.candidate.inputDigest}</code>
                。此回执只说明指定命令的结果，不代表测试覆盖充分或已完成代码审查。
              </p>
            )}
            {result.success && result.data.dependencies && (
              <p role="status">
                依赖准备：
                {result.data.dependencies.status ===
                'installed_and_verification_succeeded'
                  ? '安装及指定验证命令成功'
                  : '安装或指定验证命令未成功'}
                ；临时环境已停止，原工作区未修改。
              </p>
            )}
            {result.success && result.data.diagnostics && (
              <section aria-label="项目环境诊断结果">
                <p>
                  实际目标：本机 Linux 隔离副本 ·{' '}
                  {result.data.diagnostics.architecture} ·{' '}
                  {result.data.diagnostics.directory}
                </p>
                <p>
                  Node {result.data.diagnostics.node.version}：
                  {projectDiagnosticLabels[result.data.diagnostics.node.status]}
                  ；npm {result.data.diagnostics.npm.version ?? '未知'}：
                  {projectDiagnosticLabels[result.data.diagnostics.npm.status]}
                </p>
                <p>
                  项目：
                  {projectDiagnosticLabels[result.data.diagnostics.project]}
                  ；包管理器：{result.data.diagnostics.packageManager}；锁文件：
                  {projectDiagnosticLabels[result.data.diagnostics.lockfile] ??
                    result.data.diagnostics.lockfile}
                </p>
                <p>
                  依赖：
                  {
                    projectDiagnosticLabels[
                      result.data.diagnostics.dependencies
                    ]
                  }
                  。未检查主机工具链，未安装或修复任何内容。
                </p>
                {result.data.diagnostics.engineStatus === 'requires_review' && (
                  <p>
                    项目 Node engines 声明：
                    {result.data.diagnostics.nodeEngine ?? '无法安全展示'}
                    （声明尚需核对，不代表版本已满足）
                  </p>
                )}
              </section>
            )}
            {(op.output.length > 0 || result.success) && (
              <details open={op.snapshot.status === 'running'}>
                <summary>
                  stdout / stderr
                  {result.success
                    ? ` · 退出码 ${result.data.exitCode}${result.data.truncated ? ' · 输出已截断' : ''}`
                    : ''}
                </summary>
                {result.success ? (
                  <>
                    <pre aria-label="stdout">{result.data.stdout}</pre>
                    <pre aria-label="stderr" className={styles.stderr}>
                      {result.data.stderr}
                    </pre>
                  </>
                ) : (
                  <pre>
                    {op.output.map((chunk) => (
                      <span
                        key={chunk.sequence}
                        className={
                          chunk.stream === 'stderr' ? styles.stderr : undefined
                        }
                      >
                        {chunk.content}
                      </span>
                    ))}
                  </pre>
                )}
              </details>
            )}
            {op.snapshot.status === 'unknown' && (
              <p role="status">
                尚未取得可信完成回执，不会自动重跑；请恢复 Bridge 连接后核实。
              </p>
            )}
          </article>
        );
      })}
    </section>
  );
}
