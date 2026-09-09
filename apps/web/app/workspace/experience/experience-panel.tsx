'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ExperienceCandidateSchema,
  type ExperienceCandidate,
} from '@allrice/contracts';
import styles from './experience.module.css';

type Source = {
  runId: string;
  messageId: string;
  role: string;
  text: string;
  completedAt: string;
};
const scopeNames = {
  private: '仅我自己',
  workspace: '当前租户工作区',
  platform: '平台 Skill 人工转交（不发布）',
};
const errors: Record<string, string> = {
  conflict: '候选版本已改变或已处理，请刷新后重新核对。',
  source_changed: '原始消息已改变，本次审核未生效；请重新选取来源。',
  identity_denied: '当前身份没有此范围的审核权限。',
  invalid_source: '请选择已结束任务中的原始对话片段。',
  platform_publication_required:
    '租户审核不能发布平台 Skill，请走来源、许可证、测试和发布流程。',
};
async function response(request: Promise<Response>) {
  const r = await request;
  const v = await r.json().catch(() => ({}));
  if (!r.ok)
    throw Error(errors[v.code] ?? '操作未完成，请检查权限和输入后重试。');
  return v;
}
export function ExperienceReviewCard({
  candidate,
  onReview,
}: {
  candidate: ExperienceCandidate;
  onReview: (decision: 'approve' | 'reject', reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  const review = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    setError('');
    try {
      await onReview(decision, reason);
    } catch (e) {
      setError(e instanceof Error ? e.message : '审核失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={styles.card} data-candidate-id={candidate.id}>
      <div className={styles.heading}>
        <strong>{scopeNames[candidate.scope]}</strong>
        <span>
          {candidate.archived && candidate.status !== 'rejected'
            ? '已归档 · 不再召回'
            : candidate.scope === 'platform' && candidate.status === 'pending'
              ? '待人工转交 · 未发布'
              : candidate.status === 'pending'
                ? '待明确审核'
                : candidate.status === 'approved'
                  ? '已确认长期记忆'
                  : '已拒绝'}{' '}
          · v{candidate.revision}
        </span>
      </div>
      <p className={styles.rule}>{candidate.content}</p>
      {candidate.source ? (
        <details>
          <summary>查看私密来源</summary>
          <p className={styles.rule}>{candidate.source.excerpt}</p>
          <small>
            Run {candidate.source.runId} · 消息 {candidate.source.messageId}
          </small>
        </details>
      ) : (
        <p>来源已核验；原始私密对话未共享给审核人。</p>
      )}
      {candidate.scope === 'platform' ? (
        <p>
          这只是你私密保存的脱敏建议，不会进入任何
          Run，也未传给平台。平台维护者须核对来源许可，并通过现有 Skill
          版本、编译、试用和发布门禁。
          <br />
          <Link href="/runtime-console">
            查看现有发布工作台（仍需相应权限）
          </Link>{' '}
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(candidate.content);
                setCopied(true);
              } catch {
                setError('复制失败，请手动复制已脱敏的规则。');
              }
            }}
          >
            {copied ? '已复制' : '复制脱敏建议'}
          </button>
        </p>
      ) : null}
      {candidate.status === 'approved' && !candidate.archived ? (
        <p>
          后续相关新任务可召回 v{candidate.revision}
          ；已排队或正在运行的快照不会改写。不保证每个无关任务都采用。
        </p>
      ) : null}
      {candidate.reviewReason ? (
        <p>审核说明：{candidate.reviewReason}</p>
      ) : null}
      {candidate.status === 'pending' &&
      !candidate.archived &&
      (candidate.canReview || candidate.ownedByMe) ? (
        <div className={styles.actions}>
          <label>
            审核或撤回说明
            <textarea
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {candidate.canReview ? (
            <button
              type="button"
              disabled={busy || !reason.trim()}
              onClick={() => void review('approve')}
            >
              明确批准为
              {candidate.scope === 'private'
                ? '我的长期记忆'
                : '工作区长期记忆'}
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy || !reason.trim()}
            onClick={() => void review('reject')}
          >
            {candidate.ownedByMe ? '拒绝／撤回候选' : '拒绝候选'}
          </button>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </article>
  );
}
export function ExperiencePanel({
  workspaceId,
  sessionId,
}: {
  workspaceId: string;
  sessionId?: string;
}) {
  const [sources, setSources] = useState<Source[]>([]),
    [candidates, setCandidates] = useState<ExperienceCandidate[]>([]),
    [selected, setSelected] = useState(''),
    [excerpt, setExcerpt] = useState(''),
    [content, setContent] = useState(''),
    [scope, setScope] = useState<'private' | 'workspace' | 'platform'>(
      'private',
    ),
    [ack, setAck] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const attempt = useRef<{ payload: string; id: string } | null>(null);
  const suffix = `?workspaceId=${encodeURIComponent(workspaceId)}`;
  const reload = useCallback(async () => {
    const result = await response(
      fetch(`/api/v1/experiences${suffix}`, { cache: 'no-store' }),
    );
    setCandidates(ExperienceCandidateSchema.array().parse(result.candidates));
  }, [suffix]);
  useEffect(() => {
    let active = true;
    void reload().catch((e) => {
      if (active) setError(e.message);
    });
    if (sessionId)
      void response(
        fetch(
          `/api/v1/experiences/sources${suffix}&sessionId=${encodeURIComponent(sessionId)}`,
          { cache: 'no-store' },
        ),
      )
        .then((result) => {
          if (active) setSources(result.sources);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [reload, sessionId, suffix]);
  const submit = async () => {
    const origin = sources.find((s) => s.messageId === selected);
    if (!origin) return;
    setBusy(true);
    setError('');
    setNotice('');
    const input = {
      runId: origin.runId,
      messageId: origin.messageId,
      sourceExcerpt: excerpt,
      content,
      memoryClass: 'work_note',
      scope,
      shareAcknowledged: ack,
    };
    const payload = JSON.stringify(input);
    if (attempt.current?.payload !== payload)
      attempt.current = { payload, id: crypto.randomUUID() };
    try {
      await response(
        fetch(`/api/v1/experiences${suffix}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...input,
            clientRequestId: attempt.current.id,
          }),
        }),
      );
      await reload();
      setContent('');
      setNotice('候选已保存，尚未批准或发布。');
      attempt.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className={styles.page}>
      <Link href="/chatflow">← 返回工作台</Link>
      <h1>经验候选与审核</h1>
      <p>
        从已结束任务人工选取、改写纠偏或规则。普通聊天、Ask User
        回答或计划认可都不代表批准；这里的明确审核才会生成长期记忆新版本。
      </p>
      {sessionId ? (
        <section className={styles.card}>
          <fieldset disabled={busy}>
            <h2>从当前会话沉淀经验</h2>
            <p>
              列出最近 100
              条已结束任务的消息；只选取对话正文，不含隐藏推理和工具日志。
            </p>
            <label>
              已结束任务的对话
              <select
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setExcerpt('');
                }}
              >
                <option value="">请选择来源消息</option>
                {sources.map((s) => (
                  <option key={s.messageId} value={s.messageId}>
                    {s.role === 'user' ? '你' : 'Rice'} · {s.text.slice(0, 75)}
                  </option>
                ))}
              </select>
            </label>
            {selected ? (
              <>
                <pre className={styles.source}>
                  {sources.find((s) => s.messageId === selected)?.text}
                </pre>
                <label>
                  粘贴要引用的原文片段（仅你可见）
                  <textarea
                    value={excerpt}
                    maxLength={4000}
                    onChange={(e) => setExcerpt(e.target.value)}
                  />
                </label>
              </>
            ) : null}
            <label>
              改写后的经验规则
              <textarea
                value={content}
                maxLength={4000}
                onChange={(e) => setContent(e.target.value)}
                placeholder="去除姓名、客户数据、密钥等无关信息，只保留可复用规则。"
              />
            </label>
            <label>
              目标范围
              <select
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value as typeof scope);
                  setAck(false);
                }}
              >
                {Object.entries(scopeNames).map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            {scope !== 'private' ? (
              <label className={styles.consent}>
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />
                {scope === 'workspace'
                  ? '我确认以上改写规则可以交给当前工作区管理员审核并供本工作区使用；原始对话不共享。'
                  : '我确认以上建议已去敏；目前只私密保存，复制和人工转交不等于平台发布。'}
              </label>
            ) : null}
            <button
              type="button"
              disabled={
                busy ||
                !selected ||
                !excerpt.trim() ||
                !content.trim() ||
                (scope !== 'private' && !ack)
              }
              onClick={() => void submit()}
            >
              {busy ? '正在保存…' : '保存待审核候选'}
            </button>
            {!sources.length ? (
              <p>尚无可选的已结束任务消息；运行中的任务不能作为已完成来源。</p>
            ) : null}
          </fieldset>
        </section>
      ) : (
        <p>从聊天页的“经验沉淀”入口选择来源；这里也可处理现有候选。</p>
      )}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <div className={styles.heading}>
        <h2>候选与审核记录（最多 100 条，待审核优先）</h2>
        <button
          type="button"
          onClick={() => void reload().catch((e) => setError(e.message))}
        >
          刷新
        </button>
      </div>
      {candidates.map((c) => (
        <ExperienceReviewCard
          key={`${c.id}:${c.revision}`}
          candidate={c}
          onReview={async (decision, reason) => {
            await response(
              fetch(`/api/v1/experiences/${c.id}/review${suffix}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  decision,
                  reason,
                  expectedRevision: c.revision,
                  expectedDigest: c.digest,
                }),
              }),
            );
            await reload();
          }}
        />
      ))}
      {!candidates.length ? <p>暂无你可以查看的经验候选。</p> : null}
    </main>
  );
}
