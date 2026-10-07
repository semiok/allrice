'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RepositoryReviewPanelSchema,
  RepositoryReviewViewSchema,
  RepositoryReviewRequestSchema,
} from '@allrice/database/technical-contracts';
import { AdminButton, AdminStatus } from '../../components/admin/admin-ui';
import css from './technical-assistant.module.css';
const endpoint = '/api/v1/admin/technical-assistant/repository-reviews';
const labels = {
  not_started: '尚未独立审查',
  pending: '独立审查中',
  unknown: '审查尚无法确认',
  revise: '需要修改候选',
  stale: '版本已变化，需重新审查',
  accepted: '独立审查已接受',
};
const reasons = {
  repository_authorization_required: '请先配置当前管理员的仓库授权。',
  current_ci_required: '请先核对远端和四项原始 CI，确认当前版本通过。',
  subject_changed: '候选或 CI 身份已变化，旧意见仅供查看。',
  independent_review_required: '需要全新的独立助手审查这份准确候选。',
  revision_required: '同一份代码已有拒绝意见；请修改候选，不能换审查员覆盖。',
  review_not_complete: '审查及成果封存尚未完成。',
  authority_revoked: '本次权限已失效。',
  canceled: '审查已停止。',
  material_unavailable: '当前材料尚不可用。',
};
export function PlatformRepositoryReviews({
  publicationId,
  credentialRevision,
  readOnly = false,
}: {
  publicationId: string;
  credentialRevision: number | null;
  readOnly?: boolean;
}) {
  const [panel, setPanel] = useState<ReturnType<
      typeof RepositoryReviewPanelSchema.parse
    > | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [pending, setPending] = useState<ReturnType<
    typeof RepositoryReviewRequestSchema.parse
  > | null>(null);
  const mounted = useRef(false),
    sequence = useRef(0),
    mutating = useRef(false);
  const key = `allrice.repository.review.pending:${publicationId}`;
  const remember = (value: typeof pending) => {
    setPending(value);
    try {
      if (value) sessionStorage.setItem(key, JSON.stringify(value));
      else sessionStorage.removeItem(key);
    } catch {
      /* A blocked browser store does not authorize a new request. */
    }
  };
  const read = useCallback(async () => {
    const epoch = ++sequence.current;
    const r = await fetch(
      endpoint + '?publicationId=' + encodeURIComponent(publicationId),
      { cache: 'no-store' },
    );
    if (!r.ok) throw Error('review_unavailable');
    const value = RepositoryReviewPanelSchema.parse(await r.json());
    if (value.publicationId !== publicationId) throw Error('review_mismatch');
    if (mounted.current && epoch === sequence.current) setPanel(value);
    return value;
  }, [publicationId]);
  useEffect(() => {
    mounted.current = true;
    try {
      const saved = sessionStorage.getItem(key);
      if (saved) {
        const p = RepositoryReviewRequestSchema.safeParse(JSON.parse(saved));
        if (p.success && p.data.publicationId === publicationId)
          setPending(p.data);
      }
    } catch {
      /* Leave saved data untouched until a valid readback. */
    }
    void read().catch(() => {
      if (mounted.current) setNotice('审查记录暂不可读，请刷新核对。');
    });
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, [key, publicationId, read]);
  const active = panel?.reviews.find((r) =>
    ['queued', 'running'].includes(r.status),
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void read().catch(() => {
        if (mounted.current)
          setNotice('读取状态失败，保留原任务，请刷新核对。');
      });
    }, 4000);
    return () => clearInterval(timer);
  }, [active?.id, read]);
  const checkPending = async () => {
    if (!pending || mutating.current) return;
    mutating.current = true;
    setBusy(true);
    try {
      const r = await fetch(
        endpoint + '?requestId=' + encodeURIComponent(pending.requestId),
        { cache: 'no-store' },
      );
      if (!r.ok) throw Error('review_unavailable');
      const value = await r.json();
      const review = RepositoryReviewViewSchema.nullable().parse(value.review);
      if (!mounted.current) return;
      if (review) {
        remember(null);
        await read();
        setNotice('已找到原请求；没有重新调用模型。');
      } else
        setNotice('尚未找到原请求，结果仍需核对。请稍后再次核对，未重复提交。');
    } catch {
      if (mounted.current) setNotice('原请求暂无法确认，未重新提交。');
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const start = async () => {
    if (
      readOnly ||
      mutating.current ||
      pending ||
      !panel?.canStart ||
      !panel.subjectDigest ||
      !credentialRevision
    )
      return;
    const request = RepositoryReviewRequestSchema.parse({
      requestId: crypto.randomUUID(),
      publicationId,
      expectedSubjectDigest: panel.subjectDigest,
      credentialRevision,
    });
    mutating.current = true;
    setBusy(true);
    remember(request);
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!r.ok) {
        if (
          [400, 401, 403, 404, 409, 413, 422].includes(r.status) &&
          mounted.current
        ) {
          remember(null);
          setNotice('审查未被接纳，请刷新并核对权限、版本与 CI。');
          await read();
          return;
        }
        throw Error('review_unknown');
      }
      RepositoryReviewViewSchema.parse(await r.json());
      if (mounted.current) {
        remember(null);
        await read();
        setNotice('已安排一个新的独立审查助手。');
      }
    } catch {
      if (mounted.current)
        setNotice('提交结果尚无法确认，请核对原请求；不要重复创建审查。');
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const stop = async () => {
    if (readOnly || !active || mutating.current) return;
    mutating.current = true;
    setBusy(true);
    try {
      const r = await fetch(endpoint + '/' + active.id, { method: 'DELETE' });
      if (!r.ok) throw Error('stop_unknown');
      RepositoryReviewViewSchema.parse(await r.json());
      if (mounted.current) {
        await read();
        setNotice('已请求停止，等待实际任务回收。');
      }
    } catch {
      if (mounted.current) setNotice('停止结果暂无法确认，请刷新原任务核对。');
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section aria-label="仓库候选独立审查">
      <h4>独立审查</h4>
      <p className={css.meta}>
        审查助手只阅读这份候选和准确 CI 证据。意见会保存为交付成果；合并 main 与
        Dev 验收另行执行。
      </p>
      <div className={css.controls}>
        <AdminButton
          disabled={
            readOnly ||
            busy ||
            !!pending ||
            !panel?.canStart ||
            !credentialRevision
          }
          onClick={() => void start()}
        >
          开始独立审查
        </AdminButton>
        <AdminButton
          disabled={busy}
          onClick={() =>
            void read().catch(() => setNotice('审查记录暂不可读。'))
          }
        >
          刷新审查状态
        </AdminButton>
        {pending && (
          <AdminButton disabled={busy} onClick={() => void checkPending()}>
            核对原审查请求
          </AdminButton>
        )}
        {active && (
          <AdminButton disabled={readOnly || busy} onClick={() => void stop()}>
            停止审查
          </AdminButton>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      {panel && (
        <>
          <p>
            <AdminStatus
              tone={
                panel.readiness.state === 'accepted'
                  ? 'success'
                  : panel.readiness.state === 'revise'
                    ? 'danger'
                    : 'muted'
              }
            >
              {labels[panel.readiness.state]}
            </AdminStatus>
          </p>
          {panel.readiness.reasons.map((reason) => (
            <p key={reason}>{reasons[reason]}</p>
          ))}
          {panel.reviews.map((review) => (
            <details key={review.id}>
              <summary>
                {review.verdict === 'accept'
                  ? '接受意见'
                  : review.verdict === 'revise'
                    ? '修改意见'
                    : '审查记录'}{' '}
                · {new Date(review.createdAt).toLocaleString()}{' '}
                {review.subjectDigest !== panel.subjectDigest
                  ? '· 历史版本'
                  : ''}
              </summary>
              <p className={css.meta}>
                Run {review.runId} · 独立助手{' '}
                {review.reviewerRunId ?? '尚未安排'} · {review.status}
                {review.errorCode ? ' · ' + review.errorCode : ''}
              </p>
              {review.summary && <pre>{review.summary}</pre>}
              {review.reviewArtifactId && (
                <p>
                  <a
                    href={`${endpoint}/${review.id}/artifacts/${review.reviewArtifactId}`}
                  >
                    下载审查意见
                  </a>
                </p>
              )}
              {review.deliveryArtifactId && (
                <p>
                  <a
                    href={`${endpoint}/${review.id}/artifacts/${review.deliveryArtifactId}`}
                  >
                    下载审查交付记录
                  </a>
                </p>
              )}
            </details>
          ))}
        </>
      )}
    </section>
  );
}
