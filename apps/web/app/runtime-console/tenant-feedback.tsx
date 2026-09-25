'use client';
import { useEffect, useState } from 'react';
import { FeedbackCategorySchema } from '@allrice/contracts';
import type { getTenantFeedback, listTenantFeedback } from '@allrice/database';
import { feedbackTranslate as t } from '../chatflow/feedback-labels';
import css from './tenant-feedback.module.css';

type Inbox = Awaited<ReturnType<typeof listTenantFeedback>>;
type Detail = Awaited<ReturnType<typeof getTenantFeedback>>;
const statuses: Record<string, string> = {
  new: '待处理',
  reviewing: '处理中',
  resolved: '已解决',
};
const time = (value: string | Date) =>
  new Date(value).toLocaleString('zh-CN', { hour12: false });
async function json<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...options });
  if (!response.ok)
    throw Error(
      response.status === 409
        ? '反馈已被更新，请刷新后再处理。'
        : '反馈读取或保存失败，请重试。',
    );
  return response.json();
}

export function TenantFeedback() {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1),
    [revision, setRevision] = useState(0);
  const [inbox, setInbox] = useState<Inbox | null>(null),
    [error, setError] = useState('');
  const [loading, setLoading] = useState(false),
    [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null),
    [detailError, setDetailError] = useState('');
  const [status, setStatus] = useState('new'),
    [note, setNote] = useState(''),
    [saving, setSaving] = useState(false);
  const query = new URLSearchParams({
    ...filters,
    page: String(page),
  }).toString();
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError('');
    void json<Inbox>(`/api/v1/admin/tenant-feedback?${query}`, {
      signal: abort.signal,
    })
      .then((value) => {
        if (!abort.signal.aborted) setInbox(value);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [query, revision]);
  useEffect(() => {
    setDetail(null);
    setDetailError('');
    if (!selected) return;
    const abort = new AbortController();
    void json<{ feedback: Detail }>(
      `/api/v1/admin/tenant-feedback/${selected}`,
      { signal: abort.signal },
    )
      .then(({ feedback }) => {
        if (!abort.signal.aborted) {
          setDetail(feedback);
          setNote(feedback.review_note);
          setStatus(feedback.review_status);
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setDetailError(e.message);
      });
    return () => abort.abort();
  }, [selected, revision]);
  const changeFilter = (key: string, value: string) => {
    setFilters((current) => {
      const next = { ...current };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
    setPage(1);
  };
  async function save() {
    if (!detail || saving) return;
    setSaving(true);
    setDetailError('');
    try {
      await json(`/api/v1/admin/tenant-feedback/${detail.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ifVersion: detail.version, status, note }),
      });
      setRevision((value) => value + 1);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className={css.root} aria-label="租户反馈">
      <header className={css.heading}>
        <div>
          <h1>租户反馈</h1>
          <p>查看真实使用意见，关联问答并跟进改进。</p>
        </div>
        <button
          onClick={() => setRevision((n) => n + 1)}
          disabled={loading || saving}
        >
          刷新反馈
        </button>
      </header>
      <div className={css.filters}>
        <label>
          租户
          <select
            aria-label="筛选租户"
            value={filters.organizationId ?? ''}
            onChange={(e) => changeFilter('organizationId', e.target.value)}
          >
            <option value="">全部租户</option>
            {inbox?.organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          员工
          <select
            aria-label="筛选员工"
            value={filters.employeeId ?? ''}
            onChange={(e) => changeFilter('employeeId', e.target.value)}
          >
            <option value="">全部员工</option>
            {inbox?.employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          评价
          <select
            aria-label="筛选评价"
            value={filters.rating ?? ''}
            onChange={(e) => changeFilter('rating', e.target.value)}
          >
            <option value="">全部评价</option>
            <option value="positive">好的回答</option>
            <option value="negative">有问题的回答</option>
          </select>
        </label>
        <label>
          分类
          <select
            aria-label="筛选反馈分类"
            value={filters.category ?? ''}
            onChange={(e) => changeFilter('category', e.target.value)}
          >
            <option value="">全部分类</option>
            {FeedbackCategorySchema.options.map((c) => (
              <option key={c} value={c}>
                {t(`category.${c}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          处理状态
          <select
            aria-label="筛选处理状态"
            value={filters.status ?? ''}
            onChange={(e) => changeFilter('status', e.target.value)}
          >
            <option value="">全部状态</option>
            {Object.entries(statuses).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className={css.summary} aria-live="polite">
        {loading
          ? '正在读取反馈…'
          : `共 ${inbox?.total ?? 0} 条 · ${inbox?.pending ?? 0} 条待处理`}
      </p>
      {error && <p role="alert">{error}</p>}
      <div className={css.layout}>
        <div className={css.list}>
          {!loading && !inbox?.items.length && (
            <p className={css.empty}>
              暂无符合条件的反馈。租户提交赞或踩后，会自动出现在这里。
            </p>
          )}
          {inbox?.items.map((row) => (
            <button
              className={css.card}
              key={row.id}
              data-selected={selected === row.id || undefined}
              onClick={() => setSelected(row.id)}
            >
              <span className={css.cardTop}>
                <strong>
                  {row.organization_name} · {row.actor_name}
                </strong>
                <span
                  className={css.badge}
                  data-rating={row.helpful ? 'positive' : 'negative'}
                >
                  {row.helpful ? '好的回答' : '有问题的回答'}
                </span>
              </span>
              <span className={css.meta}>
                {row.employee_name} v{row.employee_version} ·{' '}
                {row.category ? t(`category.${row.category}`) : '未分类'} ·{' '}
                {time(row.updated_at)}
              </span>
              <span className={css.comment}>
                {row.reason || '未填写补充说明'}
              </span>
              <span className={css.preview}>{row.response_preview}</span>
              <span className={css.status} data-status={row.review_status}>
                {statuses[row.review_status]}
              </span>
            </button>
          ))}
          <div className={css.pagination}>
            <button
              disabled={page <= 1 || loading}
              onClick={() => setPage((n) => n - 1)}
            >
              上一页
            </button>
            <span>第 {page} 页</span>
            <button
              disabled={loading || page * 20 >= (inbox?.total ?? 0)}
              onClick={() => setPage((n) => n + 1)}
            >
              下一页
            </button>
          </div>
        </div>
        <aside className={css.detail} aria-label="反馈详情">
          {detailError && <p role="alert">{detailError}</p>}
          {!selected ? (
            <p className={css.empty}>选择一条反馈，查看对应问答和处理记录。</p>
          ) : !detail ? (
            <p>正在读取详情…</p>
          ) : (
            <>
              <h2>{detail.employee_name} · 反馈详情</h2>
              <p className={css.meta}>
                {detail.organization_name} / {detail.workspace_name} ·{' '}
                {detail.actor_name}
              </p>
              <div className={css.feedbackNote}>
                <strong>
                  {detail.helpful ? '好的回答' : '有问题的回答'} ·{' '}
                  {detail.category
                    ? t(`category.${detail.category}`)
                    : '未分类'}
                </strong>
                <p>{detail.reason || '未填写补充说明'}</p>
              </div>
              <h3>对应问题</h3>
              <p className={css.content}>{detail.question}</p>
              <h3>员工回复</h3>
              <div className={css.answer}>
                {detail.answer || '本次没有正文回复'}
              </div>
              <details>
                <summary>运行信息</summary>
                <dl>
                  <dt>员工版本</dt>
                  <dd>v{detail.employee_version}</dd>
                  <dt>模型</dt>
                  <dd>{detail.model}</dd>
                  <dt>结果</dt>
                  <dd>
                    {detail.run_status}
                    {detail.error_code ? ` · ${detail.error_code}` : ''}
                  </dd>
                  <dt>任务 ID</dt>
                  <dd>{detail.run_id}</dd>
                  <dt>会话 ID</dt>
                  <dd>{detail.session_id}</dd>
                </dl>
              </details>
              <div className={css.review}>
                <h3>处理记录</h3>
                <label>
                  状态
                  <select
                    aria-label="反馈处理状态"
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    {Object.entries(statuses).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  处理备注
                  <textarea
                    aria-label="处理备注"
                    value={note}
                    maxLength={4000}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="记录排查结果、改进方案或对应工单…"
                  />
                </label>
                <button
                  className={css.primary}
                  disabled={saving}
                  onClick={() => void save()}
                >
                  {saving ? '保存中…' : '保存处理记录'}
                </button>
              </div>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
