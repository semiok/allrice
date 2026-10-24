'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { BrandContentBoard } from '@allrice/contracts';
import css from './brand-content-panel.module.css';

const metricLabels = {
  views: '阅读 / 播放',
  likes: '点赞',
  comments: '评论',
  shares: '分享',
  saves: '收藏',
} as const;
const empty = {
  receiptId: '',
  title: '',
  platform: '',
  publishedUrl: '',
  publishedAt: '',
  sampledAt: '',
  sourceUrl: '',
  sourceType: 'public_page',
  evidence: '',
  limitations: '',
  views: '',
  likes: '',
  comments: '',
  shares: '',
  saves: '',
};
type Draft = typeof empty;
type Experience = NonNullable<BrandContentBoard['experiences']>[number];
type Mutate = (
  input: Record<string, unknown>,
  success: string,
) => Promise<boolean>;
function instant(s: string) {
  return new Date(s).toISOString();
}
function localTime(s: string) {
  const d = new Date(s);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}
function saved(key: string): Draft {
  try {
    return { ...empty, ...JSON.parse(sessionStorage.getItem(key) ?? '{}') };
  } catch {
    return empty;
  }
}

export function BrandFeedbackPanel({
  board,
  disabled,
  available,
  draftKey,
  onMutate,
  onStart,
  onOpenSession,
  onForget,
}: {
  board: BrandContentBoard;
  disabled: boolean;
  available: boolean;
  draftKey: string;
  onMutate: Mutate;
  onStart: (feedbackIds: string[]) => Promise<void>;
  onOpenSession: (id: string) => void;
  onForget: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>(() => saved(draftKey));
  const [selection, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(draft));
    } catch {
      /* optional persistence */
    }
  }, [draft, draftKey]);
  const feedback = board.feedback ?? [],
    experiences = board.experiences ?? [];
  const selected = selection.filter((id) =>
    feedback.some((row) => row.id === id),
  );
  const patch = (key: keyof Draft, value: string) =>
    setDraft((old) => ({ ...old, [key]: value }));
  const fields: Array<{ key: keyof Draft; label: string; type?: string }> = [
    { key: 'title', label: '发布内容标题' },
    { key: 'platform', label: '平台' },
    { key: 'publishedUrl', label: '公开发布链接', type: 'url' },
    {
      key: 'publishedAt',
      label: '实际发布时间（本地时间）',
      type: 'datetime-local',
    },
    {
      key: 'sampledAt',
      label: '指标采样时间（本地时间）',
      type: 'datetime-local',
    },
    { key: 'sourceUrl', label: '数据来源链接', type: 'url' },
  ];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      const receipt = board.receipts.find((r) => r.id === draft.receiptId);
      const plan = board.plans.find((p) => p.id === receipt?.planId);
      const article = board.articles.find((a) => a.id === plan?.articleId);
      const ok = await onMutate(
        {
          operation: 'feedback.record',
          brandId: board.brand.id,
          contextRevisionId:
            article?.contextRevisionId ?? board.brand.contextRevisionId,
          publicationKind: receipt ? 'receipt' : 'imported_publication',
          ...(receipt ? { receiptId: receipt.id } : {}),
          title: draft.title,
          platform: receipt?.platform ?? draft.platform,
          publishedUrl: receipt?.publishedUrl ?? draft.publishedUrl,
          publishedAt: receipt?.actualPublishedAt ?? instant(draft.publishedAt),
          sampledAt: instant(draft.sampledAt),
          sourceUrl: draft.sourceUrl,
          sourceType: draft.sourceType,
          evidence: draft.evidence,
          limitations: draft.limitations,
          evidenceFiles: [],
          metrics: Object.fromEntries(
            Object.keys(metricLabels).map((key) => [
              key,
              draft[key as keyof Draft].trim() === ''
                ? null
                : Number(draft[key as keyof Draft]),
            ]),
          ),
        },
        '反馈快照已保存，未知指标保持未知。',
      );
      if (ok) setDraft(empty);
    } catch {
      setError('请填写有效时间和非负整数指标；不清楚的指标留空。');
    }
  };
  const group = feedback.find((f) => f.id === selected[0]);
  return (
    <div className={css.stack}>
      <h3>发布反馈与复盘</h3>
      <p className={css.muted}>
        记录已发布内容的实际数据，再复盘可复用的经验。外部样本独立标注；留空表示未知，填
        0 表示明确观测为零。
      </p>
      {board.unavailableFeedbackSources && (
        <p role="status" className={css.notice}>
          部分历史反馈的附件已不可用，相关反馈、复盘和经验已隐藏。仍可使用其他有效资料。
        </p>
      )}
      <details className={css.details}>
        <summary>录入发布反馈</summary>
        <form onSubmit={submit} className={css.stack}>
          <label className={css.field}>
            记录来源
            <select
              aria-label="记录来源"
              value={draft.receiptId}
              disabled={disabled}
              onChange={(e) => {
                const r = board.receipts.find(
                  (row) => row.id === e.target.value,
                );
                setDraft((old) => ({
                  ...old,
                  receiptId: e.target.value,
                  ...(r
                    ? {
                        platform: r.platform,
                        publishedUrl: r.publishedUrl,
                        publishedAt: localTime(r.actualPublishedAt),
                        sourceUrl: r.publishedUrl,
                      }
                    : {}),
                }));
              }}
            >
              <option value="">外部已发布样本（不关联本系统稿件）</option>
              {board.receipts.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.platform} · {r.publishedUrl}
                </option>
              ))}
            </select>
          </label>
          {fields.map((field) => (
            <label className={css.field} key={field.key}>
              {field.label}
              <input
                aria-label={field.label}
                required
                type={field.type ?? 'text'}
                maxLength={field.type === 'url' ? 2000 : 240}
                disabled={
                  disabled ||
                  Boolean(
                    draft.receiptId &&
                    ['platform', 'publishedUrl', 'publishedAt'].includes(
                      field.key,
                    ),
                  )
                }
                value={draft[field.key]}
                onChange={(e) => patch(field.key, e.target.value)}
              />
            </label>
          ))}
          <label className={css.field}>
            指标来源
            <select
              aria-label="指标来源"
              value={draft.sourceType}
              disabled={disabled}
              onChange={(e) => patch('sourceType', e.target.value)}
            >
              <option value="public_page">公开页面</option>
              <option value="platform_export">平台导出记录</option>
              <option value="manual_report">人工提供记录</option>
            </select>
          </label>
          <div className={css.formGrid}>
            {Object.entries(metricLabels).map(([key, label]) => (
              <label className={css.field} key={key}>
                {label}
                <input
                  aria-label={label}
                  type="number"
                  min="0"
                  step="1"
                  placeholder="未知"
                  value={draft[key as keyof Draft]}
                  disabled={disabled}
                  onChange={(e) => patch(key as keyof Draft, e.target.value)}
                />
              </label>
            ))}
          </div>
          <label className={css.field}>
            来源说明与观测证据
            <textarea
              aria-label="来源说明与观测证据"
              required
              maxLength={4000}
              value={draft.evidence}
              disabled={disabled}
              onChange={(e) => patch('evidence', e.target.value)}
            />
          </label>
          <label className={css.field}>
            数据局限
            <textarea
              aria-label="数据局限"
              required
              maxLength={2000}
              placeholder="例如仅能看到公开点赞与评论，阅读量未知；不能据此判断转化。"
              value={draft.limitations}
              disabled={disabled}
              onChange={(e) => patch('limitations', e.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <button className={css.primary} type="submit" disabled={disabled}>
            保存反馈快照
          </button>
        </form>
      </details>
      {!feedback.length && (
        <p className={css.muted}>还没有发布反馈。先录入真实来源和采样时间。</p>
      )}
      {feedback.map((sample) => (
        <article key={sample.id} className={css.card}>
          <label className={css.field}>
            <input
              type="checkbox"
              aria-label={`选择复盘样本 ${sample.title}`}
              checked={selected.includes(sample.id)}
              disabled={
                disabled ||
                Boolean(
                  group &&
                  (group.contextRevisionId !== sample.contextRevisionId ||
                    group.platform !== sample.platform) &&
                  !selected.includes(sample.id),
                ) ||
                (selected.length >= 20 && !selected.includes(sample.id))
              }
              onChange={(e) =>
                setSelected(
                  e.target.checked
                    ? [...selected, sample.id]
                    : selected.filter((id) => id !== sample.id),
                )
              }
            />{' '}
            {sample.title}
          </label>
          <p>
            {sample.publicationKind === 'imported_publication'
              ? '外部已发布样本'
              : '本系统稿件发布反馈'}{' '}
            · {sample.platform} · 采样{' '}
            {new Date(sample.sampledAt).toLocaleString()}
          </p>
          <p>
            {Object.entries(metricLabels)
              .map(
                ([key, label]) =>
                  `${label}：${sample.metrics[key as keyof typeof metricLabels] ?? '未知'}`,
              )
              .join(' · ')}
          </p>
          <p>
            <a href={sample.publishedUrl} target="_blank" rel="noreferrer">
              查看发布内容
            </a>{' '}
            ·{' '}
            <a href={sample.sourceUrl} target="_blank" rel="noreferrer">
              查看数据来源
            </a>
          </p>
          <p className={css.prose}>{sample.evidence}</p>
          <p className={css.muted}>局限：{sample.limitations}</p>
        </article>
      ))}
      <button
        className={css.button}
        type="button"
        disabled={disabled || !available || !selected.length}
        onClick={() => void onStart(selected)}
      >
        复盘选中样本（{selected.length}）
      </button>
      {!available && (
        <p className={css.notice}>当前员工尚未启用发布复盘流程。</p>
      )}
      {(board.retrospectives ?? []).map((report) => {
        const experience = experiences.find(
          (row) => row.retrospectiveId === report.id,
        );
        return (
          <article className={css.card} key={report.id}>
            <h4>发布复盘 · {report.platform}</h4>
            <p className={css.prose}>{report.output.summary}</p>
            <p className={css.prose}>建议：{report.output.rule}</p>
            <p>适用范围：{report.output.applicability}</p>
            <p>局限：{report.output.limitations}</p>
            <details className={css.details}>
              <summary>本次来源（{report.feedbackIds.length}）</summary>
              {report.feedbackIds.map((id) => {
                const f = feedback.find((x) => x.id === id);
                return (
                  <p key={id}>
                    {f ? (
                      <a href={f.sourceUrl} target="_blank" rel="noreferrer">
                        {f.title}
                      </a>
                    ) : (
                      id
                    )}
                  </p>
                );
              })}
            </details>
            <button
              className={css.button}
              type="button"
              onClick={() => onOpenSession(report.sessionId)}
            >
              查看复盘会话
            </button>
            {!experience ? (
              <button
                className={css.button}
                type="button"
                disabled={disabled}
                onClick={() =>
                  void onMutate(
                    {
                      operation: 'experience.propose',
                      brandId: board.brand.id,
                      retrospectiveId: report.id,
                    },
                    '已提交经验候选，请核对后确认。',
                  )
                }
              >
                提交为经验候选
              </button>
            ) : (
              <ReviewExperience
                entry={experience}
                brandId={board.brand.id}
                disabled={disabled}
                onMutate={onMutate}
                onForget={onForget}
              />
            )}
          </article>
        );
      })}
      {!!board.experienceUses?.length && (
        <section>
          <h4>后续任务实际引用</h4>
          {board.experienceUses.map((use) => (
            <p key={`${use.entityId}/${use.memoryId}`}>
              经验 {use.memoryId.slice(0, 8)} · v{use.revision}：{use.reason}
              （业务记录 {use.entityId.slice(0, 8)}）
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
function ReviewExperience({
  entry,
  brandId,
  disabled,
  onMutate,
  onForget,
}: {
  entry: Experience;
  brandId: string;
  disabled: boolean;
  onMutate: Mutate;
  onForget: (id: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  if (entry.archived || entry.status !== 'pending')
    return (
      <p>
        {entry.status === 'rejected'
          ? '已拒绝'
          : entry.archived
            ? '已撤回，不再使用'
            : '已确认：仅供相同品牌、活动和平台后续任务使用'}{' '}
        · 经验 {entry.id.slice(0, 8)} v{entry.revision}
        {!entry.archived && entry.status === 'approved' && (
          <button
            className={css.button}
            type="button"
            disabled={disabled}
            onClick={() => void onForget(entry.id)}
          >
            撤回经验
          </button>
        )}
      </p>
    );
  return (
    <div>
      <p>待确认的经验候选。确认只影响后续任务，不改写品牌正式方法。</p>
      <label className={css.field}>
        确认 / 拒绝理由
        <input
          aria-label="确认 / 拒绝理由"
          value={reason}
          maxLength={500}
          disabled={disabled}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {(['approve', 'reject'] as const).map((decision) => (
        <button
          className={css.button}
          key={decision}
          type="button"
          disabled={disabled || !reason.trim()}
          onClick={() =>
            void onMutate(
              {
                operation: 'experience.review',
                brandId,
                memoryId: entry.id,
                decision,
                expectedRevision: entry.revision,
                expectedDigest: entry.digest,
                reason,
              },
              decision === 'approve'
                ? '经验已确认，后续匹配范围的任务可以引用。'
                : '经验已拒绝，保留来源记录。',
            )
          }
        >
          {decision === 'approve' ? '确认采用' : '拒绝'}
        </button>
      ))}
    </div>
  );
}
