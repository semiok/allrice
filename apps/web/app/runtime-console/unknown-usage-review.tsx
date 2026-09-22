'use client';
import { useState } from 'react';

export interface UnknownUsageReview {
  decisionId: string;
  organizationId?: string;
  organizationName?: string;
  runId: string;
  provider: string;
  model: string;
  occurredAt: string;
  knownTokens: number;
  reservedTokens: number | null;
  approved: boolean;
  tokenObservationOnly?: boolean;
  eligible: boolean;
  reason: string | null;
  reviewedAt: string | null;
}
export function UnknownUsageReviewCard({
  entry,
  busy,
  onReview,
}: {
  entry: UnknownUsageReview;
  busy: boolean;
  onReview: (review: {
    decisionId: string;
    reservedTokens: number;
    reason: string;
    acceptUnknownUsage: true;
  }) => Promise<void>;
}) {
  const [tokens, setTokens] = useState('1000000');
  const [reason, setReason] = useState('');
  const [accepted, setAccepted] = useState(false);
  const amount = Number(tokens);
  return (
    <article>
      <h3>
        {entry.organizationName ? `${entry.organizationName} · ` : ''}Run{' '}
        {entry.runId.slice(0, 8)} · 用量待核对
      </h3>
      <p>
        {entry.model} · {entry.occurredAt} · 已知小计{' '}
        {entry.knownTokens.toLocaleString()} Token
      </p>
      {entry.tokenObservationOnly ? (
        <p>
          Codex
          订阅仅记录用量。缺少回执不会阻断后续聊天，无需填写预留预算；原始未知记录保留，不按
          0 处理。
          {entry.approved
            ? ` 历史人工预留 ${entry.reservedTokens?.toLocaleString()} Token 仅留档，不作为实际用量。`
            : ''}
        </p>
      ) : entry.approved ? (
        <p>
          已批准额外预留 {entry.reservedTokens?.toLocaleString()} Token
          组织月度预算；实际用量仍未知。{entry.reason}
        </p>
      ) : entry.eligible ? (
        <>
          <p>
            仅放行后续新请求，不重跑原任务。预算预留不代表实际用量、不是扣费，也不是供应商保证的用量上界；原始记录不变。
          </p>
          <label>
            额外预留的组织月度 Token 预算
            <input
              type="number"
              min="1"
              max="10000000000"
              value={tokens}
              onChange={(e) => setTokens(e.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            处理依据（至少 10 字）
            <textarea
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              disabled={busy}
            />
            我确认接受此任务用量仍未知的风险，并保留原记录
          </label>
          <button
            disabled={
              busy ||
              !accepted ||
              reason.trim().length < 10 ||
              !Number.isSafeInteger(amount) ||
              amount <= 0 ||
              amount > 10_000_000_000
            }
            onClick={() =>
              void onReview({
                decisionId: entry.decisionId,
                reservedTokens: amount,
                reason,
                acceptUnknownUsage: true,
              })
            }
          >
            批准预算预留
          </button>
        </>
      ) : (
        <p>
          不可直接放行：请核对原始回执、活动任务或已变化的审批记录。助手悬挂用量和
          API 用量不适用此入口。
        </p>
      )}
    </article>
  );
}
