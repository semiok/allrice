'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RepositoryMergeRequestSchema,
  RepositoryMergePanelSchema,
  RepositoryMergeViewSchema,
} from '@allrice/database/technical-contracts';
import { AdminButton, AdminStatus } from '../../components/admin/admin-ui';
import css from './technical-assistant.module.css';
const endpoint = '/api/v1/admin/technical-assistant/repository-merges';
const reasons = {
  repository_authorization_required: '请先配置当前管理员的仓库授权。',
  completed_review_required: '需要准确、完整的独立审查和交付成果。',
  merge_active: '合并操作正在执行。',
  merge_started_reconcile_only: '已发出合并，请核对原结果，不能重新合并。',
  started_review_fixed:
    '已发出候选就绪操作，继续核对原审查结果；不能更换审查依据。',
  merged: '候选已合入 main，Dev 发布另行执行。',
  review_invalid: '审查材料已变化、撤销或不完整，请核对原记录。',
};
const errors: Record<string, string> = {
  REPOSITORY_BASE_PROTECTION_REQUIRED:
    '仓库需要启用严格的分支保护并约束管理员，才能安全自动合并。',
  REPOSITORY_MERGE_STALE: '远端版本已变化，原候选未继续合并。',
  REPOSITORY_MERGE_CURRENT_CI_REQUIRED: '当前原始 CI 与审查版本不一致。',
  REPOSITORY_MERGE_RESULT_UNKNOWN: '合并结果尚无法确认，请核对原结果。',
  REPOSITORY_READY_RESULT_UNKNOWN: '候选就绪状态尚无法确认，请核对原结果。',
  PLATFORM_TECHNICAL_AUTH_REVOKED: '当前账号、授权或审查依据已失效。',
};
type RequestData = ReturnType<typeof RepositoryMergeRequestSchema.parse>;
type Panel = ReturnType<typeof RepositoryMergePanelSchema.parse>;
export function PlatformRepositoryMerges({
  publicationId,
  credentialRevision,
}: {
  publicationId: string;
  credentialRevision: number | null;
}) {
  const [panel, setPanel] = useState<Panel | null>(null),
    [pending, setPending] = useState<RequestData | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [absent, setAbsent] = useState(false);
  const mounted = useRef(false),
    seq = useRef(0),
    mutating = useRef(false),
    key = `allrice.repository.merge.pending:${publicationId}`;
  const remember = (value: RequestData | null) => {
    setPending(value);
    try {
      if (value) sessionStorage.setItem(key, JSON.stringify(value));
      else sessionStorage.removeItem(key);
    } catch {
      /* Retain the in-memory request when browser storage is unavailable. */
    }
  };
  const read = useCallback(async () => {
    const epoch = ++seq.current,
      r = await fetch(
        endpoint + '?publicationId=' + encodeURIComponent(publicationId),
        { cache: 'no-store' },
      );
    if (!r.ok) throw Error('merge_unavailable');
    const value = RepositoryMergePanelSchema.parse(await r.json());
    if (value.publicationId !== publicationId) throw Error('merge_mismatch');
    if (mounted.current && epoch === seq.current) setPanel(value);
    return value;
  }, [publicationId]);
  useEffect(() => {
    mounted.current = true;
    try {
      const stored = sessionStorage.getItem(key);
      if (stored) {
        const p = RepositoryMergeRequestSchema.safeParse(JSON.parse(stored));
        if (
          p.success &&
          (p.data.action === 'reconcile' ||
            p.data.publicationId === publicationId)
        )
          setPending(p.data);
      }
    } catch {
      /* Invalid saved requests never trigger a write. */
    }
    void read().catch(() => {
      if (mounted.current) setNotice('合并记录暂不可读，请刷新核对。');
    });
    return () => {
      mounted.current = false;
      seq.current++;
    };
  }, [key, publicationId, read]);
  const operation =
      panel?.merges.find((m) =>
        m.actions.some((a) => ['queued', 'running'].includes(a.status)),
      ) ??
      panel?.merges.find(
        (m) => m.receipt || m.mergeStarted || m.readyStarted,
      ) ??
      panel?.merges[0],
    active = operation?.actions.find((a) =>
      ['queued', 'running'].includes(a.status),
    );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void read().catch(() => {
        if (mounted.current) setNotice('状态暂不可读，保留原操作。');
      });
    }, 4000);
    return () => clearInterval(timer);
  }, [active?.id, read]);
  const send = async (request: RequestData) => {
    if (mutating.current) return;
    setAbsent(false);
    mutating.current = true;
    setBusy(true);
    remember(request);
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!r.ok) throw Error('merge_unknown');
      const value = RepositoryMergeViewSchema.parse(await r.json());
      if (
        value.publicationId !== publicationId ||
        !value.actions.some((a) => a.requestId === request.requestId)
      )
        throw Error('merge_mismatch');
      if (mounted.current) {
        remember(null);
        await read();
        setNotice(
          request.action === 'merge'
            ? '已提交固定候选合并。'
            : '已提交原结果核对；不会再次发出合并。',
        );
      }
    } catch {
      if (mounted.current)
        setNotice('提交结果尚无法确认。请核对原请求，避免重复操作。');
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const submit = async (action: 'merge' | 'reconcile') => {
    if (mutating.current || pending || !credentialRevision || !panel) return;
    if (
      action === 'merge' &&
      (!panel.canStart || !panel.reviewSubjectId || !panel.subjectDigest)
    )
      return;
    if (action === 'reconcile' && !operation) return;
    const request = RepositoryMergeRequestSchema.parse(
      action === 'merge'
        ? {
            action,
            requestId: crypto.randomUUID(),
            publicationId,
            reviewSubjectId: panel.reviewSubjectId,
            expectedSubjectDigest: panel.subjectDigest,
            credentialRevision,
          }
        : {
            action,
            requestId: crypto.randomUUID(),
            mergeId: operation!.id,
            credentialRevision,
          },
    );
    await send(request);
  };
  const retryPending = async () => {
    if (pending && absent) await send(pending);
  };
  const checkPending = async () => {
    if (!pending || mutating.current) return;
    mutating.current = true;
    setBusy(true);
    try {
      const r = await fetch(
        endpoint + '?requestId=' + encodeURIComponent(pending.requestId),
        { cache: 'no-store' },
      );
      if (!r.ok) throw Error('merge_unknown');
      const value = RepositoryMergeViewSchema.nullable().parse(
        (await r.json()).merge,
      );
      if (
        value &&
        (value.publicationId !== publicationId ||
          !value.actions.some((a) => a.requestId === pending.requestId))
      )
        throw Error('merge_mismatch');
      if (mounted.current) {
        if (value) {
          remember(null);
          await read();
          setNotice('已找到原请求；没有重复合并。');
        } else {
          setAbsent(true);
          setNotice(
            '尚未找到原请求。可继续核对，或使用相同编号重试；不会创建第二次合并。',
          );
        }
      }
    } catch {
      if (mounted.current) setNotice('原请求暂不可读，请稍后核对。');
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const stop = async () => {
    if (!operation || !active || mutating.current) return;
    mutating.current = true;
    setBusy(true);
    try {
      const r = await fetch(
        endpoint + '/' + operation.id + '?actionId=' + active.id,
        { method: 'DELETE' },
      );
      if (!r.ok) throw Error('stop_unknown');
      RepositoryMergeViewSchema.parse(await r.json());
      if (mounted.current) {
        await read();
        setNotice('已请求停止。已发生的仓库写入仍需核对。');
      }
    } catch {
      if (mounted.current) setNotice('停止结果暂无法确认，请刷新原操作。');
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section aria-label="候选合并 main">
      <h4>合并 main</h4>
      <p className={css.meta}>
        合并前核对当前授权、远端版本、原始 CI 和完整审查成果。合并 main 与部署
        Dev 分别记录。
      </p>
      <div className={css.controls}>
        <AdminButton
          disabled={
            busy || !!pending || !panel?.canStart || !credentialRevision
          }
          onClick={() => void submit('merge')}
        >
          合并已审查候选
        </AdminButton>
        <AdminButton
          disabled={busy}
          onClick={() =>
            void read().catch(() => setNotice('合并记录暂不可读。'))
          }
        >
          刷新合并状态
        </AdminButton>
        {pending && (
          <AdminButton disabled={busy} onClick={() => void checkPending()}>
            核对原合并请求
          </AdminButton>
        )}
        {pending && absent && (
          <AdminButton disabled={busy} onClick={() => void retryPending()}>
            重试原合并请求
          </AdminButton>
        )}
        {operation && !active && (
          <AdminButton
            disabled={busy || !!pending || !credentialRevision}
            onClick={() => void submit('reconcile')}
          >
            核对原合并结果
          </AdminButton>
        )}
        {active && (
          <AdminButton disabled={busy} onClick={() => void stop()}>
            停止合并操作
          </AdminButton>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      {panel?.reason && <p>{reasons[panel.reason]}</p>}
      {operation && (
        <details>
          <summary>
            <AdminStatus tone={operation.receipt ? 'success' : 'muted'}>
              {operation.receipt ? '已合入 main' : '合并记录'}
            </AdminStatus>
          </summary>
          {operation.receipt && (
            <>
              <p>
                main 合并版本：<code>{operation.receipt.mergeSha}</code>
              </p>
              <p>Dev 尚未由此操作发布。</p>
            </>
          )}
          {operation.mergeStarted && !operation.receipt && (
            <p>已发出一次合并，结果仍待核对。</p>
          )}
          {operation.actions.map((a) => (
            <p key={a.id}>
              {a.action === 'merge' ? '固定候选合并' : '只读核对'} · {a.status}
              {a.errorCode && ' · ' + (errors[a.errorCode] ?? a.errorCode)}
            </p>
          ))}
        </details>
      )}
      {panel?.merges
        .filter((m) => m.id !== operation?.id)
        .map((m) => (
          <details key={m.id}>
            <summary>历史合并请求 · {m.createdAt}</summary>
            <p>审查编号：{m.reviewSubjectId}</p>
            {m.actions.map((a) => (
              <p key={a.id}>
                {a.action === 'merge' ? '固定候选合并' : '只读核对'} ·{' '}
                {a.status}
                {a.errorCode && ' · ' + (errors[a.errorCode] ?? a.errorCode)}
              </p>
            ))}
          </details>
        ))}
    </section>
  );
}
