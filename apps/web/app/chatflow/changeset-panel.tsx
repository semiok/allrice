'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChangesetRunsResponseSchema,
  type ChangesetRunView,
  type WorkbenchArtifact,
} from '@allrice/contracts';
import { fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives';
import { inputRetry } from '../../lib/chatflow/input-retry';
import {
  changesetApproveLabel,
  changesetFileLabel,
  changesetFileNote,
  changesetTaskLabel,
  changesetTitle,
  fileChangeLabel,
} from '../../lib/chatflow/changeset-presenter';
import { TechnicalDetails } from './technical-details';
import styles from './local-command-panel.module.css';

/** Identities, checksums and codes kept for troubleshooting only. */
function technicalRows(item: ChangesetRunView): [string, string][] {
  return [
    ['任务编号', item.runId],
    ['状态记录', item.snapshot?.status ?? item.runState],
    ...(item.payload
      ? [['成果校验值', item.payload.arguments.checksum] as [string, string]]
      : []),
    ...(item.payload?.arguments.files ?? []).map((f): [string, string] => [
      f.path,
      'organization' in f
        ? f.organization.source.checksum
        : `${f.before?.checksum ?? '新建'} → ${f.after?.checksum ?? '删除'}`,
    ]),
    ...(item.evidence.result?.files ?? []).map((f): [string, string] => [
      `${f.path} 的结果`,
      [f.status, f.organization?.stage, f.errorCode]
        .filter(Boolean)
        .join(' · '),
    ]),
  ];
}
export function ChangesetPanel({
  artifact,
  organizationPlan = false,
  sessionId,
  workspaceId,
  headers,
  disabled,
  onContinued,
}: {
  artifact: WorkbenchArtifact;
  organizationPlan?: boolean;
  sessionId: string;
  workspaceId: string;
  headers: Record<string, string>;
  disabled: boolean;
  onContinued?: (runId: string) => void;
}) {
  const proposalCopy = artifact.execution?.workCopy.kind === 'local_copy';
  const [records, setRecords] = useState<ChangesetRunView[] | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const responses = useRef(new Map<string, unknown>()),
    generation = useRef(0);
  const api = `/api/v1/sessions/${sessionId}/artifacts/${artifact.id}/executions?workspaceId=${workspaceId}`;
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const g = ++generation.current;
      try {
        const r = await fetch(api, { headers, cache: 'no-store', signal });
        if (r.status === 404) {
          if (!signal?.aborted && g === generation.current) setRecords(null);
          return;
        }
        if (!r.ok) throw Error('changeset_status_unavailable');
        const parsed = ChangesetRunsResponseSchema.parse(await r.json());
        if (!signal?.aborted && g === generation.current)
          setRecords(parsed.executions);
      } catch (e) {
        if (!signal?.aborted && g === generation.current) {
          console.error('changeset status read failed', e);
          setRecords(null);
          setError('暂时读不到文件的处理状态，请稍后刷新查看。');
        }
      }
    },
    [api, headers],
  );
  useEffect(() => {
    if (proposalCopy) return;
    const a = new AbortController();
    void reload(a.signal);
    const t = setInterval(() => void reload(a.signal), 1500);
    return () => {
      generation.current++;
      a.abort();
      clearInterval(t);
    };
  }, [reload, proposalCopy]);
  async function requestExecution(restoreOf: string | null) {
    if (busy || disabled || proposalCopy) return;
    setBusy(true);
    setError('');
    const body = {
      text: restoreOf ? '请求恢复已确认落盘的文件' : '请求应用审查的文件变更',
      deliveryMode: 'follow_up',
      changesetAction: {
        artifactId: artifact.id,
        checksum: artifact.object.checksum,
        restoreOf,
      },
    };
    try {
      const { id: clientMessageId } = await inputRetry(
        `${workspaceId}/${sessionId}`,
        body,
      );
      const r = await fetch(
        `/api/v1/sessions/${sessionId}/messages?workspaceId=${workspaceId}`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, clientMessageId }),
        },
      );
      if (!r.ok) throw Error('changeset_request_unconfirmed');
      const data = await r.json();
      onContinued?.(data.run.id);
      await reload();
    } catch {
      setError(
        '申请可能没有送达。请刷新查看是否已经提交，再决定是否重新申请。',
      );
    } finally {
      setBusy(false);
    }
  }
  async function act(
    item: ChangesetRunView,
    decision: 'approved' | 'rejected' | 'cancel',
  ) {
    if (busy || (disabled && decision !== 'cancel')) return;
    const request = item.approval?.request;
    if (decision !== 'cancel' && !request) return;
    setBusy(true);
    setError('');
    try {
      let body: unknown = { runId: item.runId };
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
      const r = await fetch(
        decision === 'cancel'
          ? api
          : `/api/v1/runtime/approvals/${request!.approvalId}`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'x-allrice-workspace-id': workspaceId,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      if (!r.ok) throw Error('changeset_decision_unconfirmed');
      await reload();
    } catch {
      setError(
        '你的选择可能没有送达：授权可能已过期，或已在别的页面处理。请刷新查看当前状态。',
      );
    } finally {
      setBusy(false);
    }
  }
  if (proposalCopy)
    return (
      <section className={styles.root} aria-label="隔离副本修改提案">
        <h4>隔离副本中的修改提案 · 还没保存到电脑</h4>
        <p>这份修改来自隔离副本，不能直接保存到原来的文件夹。</p>
      </section>
    );
  if (records === null && !error) return null;
  return (
    <section className={styles.root} aria-label="把修改保存到电脑">
      <h4>
        {organizationPlan ? '整理你电脑上的文件' : '把修改保存到你的电脑'}
      </h4>
      <p>
        只会改动这份提案里的文件，不会运行任何程序。允许后会逐个文件检查并保存；如果中途停下，可能只改了一部分。处理期间请先别用其他程序修改这些文件。
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {records && !records.some((r) => !r.restoreOf) ? (
        <button
          type="button"
          disabled={busy || disabled || artifact.stale}
          onClick={() => void requestExecution(null)}
        >
          {organizationPlan ? '申请整理这些文件' : '申请保存到电脑'}
        </button>
      ) : null}
      {records?.map((item) => {
        const pending =
          item.snapshot?.status === 'waiting_user' &&
          item.approval &&
          !item.approval.response &&
          !item.approval.revokedAt &&
          Date.parse(item.approval.request.expiresAt) > Date.now();
        const stopped = ['succeeded', 'failed', 'canceled'].includes(
          item.runState,
        );
        return (
          <article
            key={item.runId}
            id={
              item.snapshot
                ? `operation-${item.snapshot.binding.attempt.operationId}`
                : undefined
            }
          >
            <strong>
              {changesetTitle(!!item.restoreOf, organizationPlan)} ·{' '}
              {changesetTaskLabel(item.snapshot?.status ?? item.runState)}
            </strong>
            {item.payload ? (
              <details>
                <summary>
                  本次会处理 {item.payload.arguments.files.length} 个文件
                </summary>
                <small>下面是每个文件的改动；恢复时会反过来操作。</small>
                <ul>
                  {item.payload.arguments.files.map((f) => (
                    <li key={f.path}>
                      <code>{f.path}</code>
                      {'organization' in f ? (
                        <small>
                          {
                            { copy: '复制', move: '移动', rename: '重命名' }[
                              f.organization.operation
                            ]
                          }{' '}
                          → <code>{f.organization.target}</code>
                          <br />
                          {fileSizeText(f.organization.source.sizeBytes)}
                          ，目标位置必须是空的
                        </small>
                      ) : (
                        <>
                          <small>{fileChangeLabel(f)}</small>
                          <details>
                            <summary>查看 {f.path} 改动前后的内容</summary>
                            <strong>改动前</strong>
                            <pre>{f.before?.text ?? '文件不存在'}</pre>
                            <strong>改动后</strong>
                            <pre>{f.after?.text ?? '删除这个文件'}</pre>
                          </details>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {pending ? (
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={busy || disabled}
                  onClick={() => void act(item, 'approved')}
                >
                  {changesetApproveLabel(!!item.restoreOf, organizationPlan)}
                </button>
                <button
                  type="button"
                  disabled={busy || disabled}
                  onClick={() => void act(item, 'rejected')}
                >
                  拒绝
                </button>
                <small>
                  只允许这一版修改；文件、文件夹或授权有变化时需要重新确认。
                </small>
              </div>
            ) : null}
            {!stopped ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(item, 'cancel')}
              >
                停止剩余文件
              </button>
            ) : null}
            {item.evidence.result ? (
              <ul aria-label="逐文件执行结果">
                {item.evidence.result.files.map((f) => (
                  <li key={f.path}>
                    <code>{f.path}</code> · {changesetFileLabel(f.status)}
                    {changesetFileNote(f.status, f.errorCode) ? (
                      <small>{changesetFileNote(f.status, f.errorCode)}</small>
                    ) : null}
                    {f.organization ? (
                      <small>
                        目标：<code>{f.organization.target}</code>
                        {f.organization.recovery ? (
                          <>
                            <br />
                            核对位置：
                            <code>{f.organization.recovery.path}</code>
                          </>
                        ) : null}
                        {f.organization.sourceRecovery ? (
                          <>
                            <br />
                            源文件核对位置：
                            <code>{f.organization.sourceRecovery.path}</code>
                          </>
                        ) : null}
                      </small>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p>还没有收到电脑的处理结果，文件可能还没有改动。</p>
            )}
            {stopped &&
            !item.restoreOf &&
            !records.some((r) => r.restoreOf === item.runId) &&
            item.evidence.result?.files.some(
              (f) =>
                f.status === 'applied' &&
                (!f.organization ||
                  (f.organization.operation !== 'copy' &&
                    f.organization.sourceRemoved &&
                    f.organization.file)),
            ) ? (
              <button
                type="button"
                disabled={busy || disabled}
                onClick={() => void requestExecution(item.runId)}
              >
                恢复成改动前的样子
              </button>
            ) : null}
            <TechnicalDetails rows={technicalRows(item)} />
          </article>
        );
      })}
      <p>
        {organizationPlan
          ? '恢复只处理确认已移动或重命名的文件，复制出的文件会保留。'
          : '恢复只处理确认已保存到电脑的文件。'}
        恢复前会先检查文件现在的内容，你之后做的修改不会被旧版本覆盖。结果待确认的文件不会恢复，需要你自己检查。
      </p>
    </section>
  );
}
