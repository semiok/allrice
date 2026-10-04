'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AdminButton as Button,
  AdminDialog,
} from '../../components/admin/admin-ui';
import { z } from 'zod';
import {
  CompanyAssetContentSchema,
  CompanyAssetMutationSchema,
  CompanyAssetSchema,
  UuidSchema,
  type CompanyAsset,
  type CompanyAssetContent,
} from '@allrice/contracts';
import { CompanyAssetRevisionView } from '../chatflow/company-template-browser';
import {
  CompanyAssetStateActions,
  companyAssetJson,
  companyAssetStateLabels,
  companyAssetUrl,
  useCompanyAssetDirectory,
} from '../chatflow/company-template-publisher';
import styles from './company-assets-panel.module.css';
import common from '../chatflow/company-template-browser.module.css';

const adminHeaders: Record<string, string> = {};
const sourcesSchema = z.object({
  sources: z.array(
    z.object({
      id: UuidSchema,
      revisionId: UuidSchema,
      revision: z.number().int().positive(),
      content: z.string(),
    }),
  ),
  employees: z.array(z.object({ id: UuidSchema, name: z.string() })),
});

function CompanyRuleEditor({
  base,
  initial,
  onSaved,
}: {
  base: string;
  initial?: CompanyAsset;
  onSaved: () => void;
}) {
  const [id] = useState(() => initial?.id ?? crypto.randomUUID());
  const [saved, setSaved] = useState(initial ?? null);
  const [content, setContent] = useState<CompanyAssetContent>(
    () =>
      initial?.latest.content ?? {
        kind: 'rule',
        title: '',
        body: '',
        category: '',
        appliesToEmployeeIds: [],
        taskKeywords: [],
        slots: [],
      },
  );
  const [keywords, setKeywords] = useState(content.taskKeywords.join('、'));
  const [sources, setSources] = useState<z.infer<typeof sourcesSchema> | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  const sourcesRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    sourcesRequest.current = controller;
    void companyAssetJson(
      companyAssetUrl(base, { sources: '1' }),
      adminHeaders,
      { signal: controller.signal },
    )
      .then((body) => {
        if (!controller.signal.aborted) setSources(sourcesSchema.parse(body));
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setSourceError(
            cause instanceof Error
              ? cause.message
              : '适用 AI 与记忆摘录读取失败',
          );
      });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [base]);
  const nextContent = {
    ...content,
    taskKeywords: [
      ...new Set(
        keywords
          .split(/[、,，\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ],
  };
  const parsed = CompanyAssetContentSchema.safeParse(nextContent);
  const dirty =
    !saved ||
    !parsed.success ||
    JSON.stringify(parsed.data) !== JSON.stringify(saved.latest.content);
  async function save() {
    if (busy || saved?.state === 'archived' || (saved && !saved.canEdit))
      return;
    if (!parsed.success) {
      setError('请填写标题和正文；任务关键词最多 12 个，适用 AI 最多 30 位。');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = CompanyAssetSchema.parse(
        await companyAssetJson(base, adminHeaders, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            CompanyAssetMutationSchema.parse({
              operation: 'save',
              assetId: id,
              expectedRevision: saved?.revision ?? 0,
              content: parsed.data,
            }),
          ),
        }),
      );
      if (controller.signal.aborted) return;
      setSaved(result);
      setContent(result.latest.content);
      setKeywords(result.latest.content.taskKeywords.join('、'));
      setNotice(
        '规矩草稿已保存。发布后才会成为公司的有效规矩；原有效版本保持不变。',
      );
      onSaved();
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : '保存结果待确认，请刷新核对',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function refresh() {
    if (!saved || busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = CompanyAssetSchema.parse(
        await companyAssetJson(
          companyAssetUrl(base, { assetId: id }),
          adminHeaders,
          { signal: controller.signal },
        ),
      );
      if (controller.signal.aborted) return;
      setSaved(result);
      setContent(result.latest.content);
      setKeywords(result.latest.content.taskKeywords.join('、'));
      setNotice('已采用最新保存草稿，请核对后继续编辑。');
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : '草稿读取失败');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const disabled =
    busy || saved?.state === 'archived' || (saved !== null && !saved.canEdit);
  return (
    <section
      className={`${common.editor} ${styles.editor}`}
      aria-label="公司规矩草稿"
    >
      <p>
        先保存草稿，再明确发布。规矩正文由你核对和编辑，不会自动搬入私人会话或触发任务。
      </p>
      {saved && (
        <p>
          {companyAssetStateLabels[saved.state]} · 最新草稿 v
          {saved.latest.number}
          {saved.publishedRevisionId &&
          saved.publishedRevisionId !== saved.latest.id
            ? ' · 原有效共享版未替换'
            : ''}
        </p>
      )}
      <label>
        规矩标题
        <input
          aria-label="规矩标题"
          value={content.title}
          maxLength={160}
          disabled={disabled}
          onChange={(e) => setContent({ ...content, title: e.target.value })}
        />
      </label>
      <label>
        正文
        <textarea
          aria-label="规矩正文"
          rows={7}
          maxLength={4000}
          disabled={disabled}
          value={content.body}
          onChange={(e) => setContent({ ...content, body: e.target.value })}
        />
      </label>
      <label>
        分类（可选）
        <input
          aria-label="规矩分类"
          value={content.category}
          maxLength={80}
          disabled={disabled}
          onChange={(e) => setContent({ ...content, category: e.target.value })}
        />
      </label>
      <label>
        任务关键词（可选）
        <input
          aria-label="规矩任务关键词"
          value={keywords}
          disabled={disabled}
          onChange={(e) => setKeywords(e.target.value)}
          placeholder="用逗号分隔，最多 12 个"
        />
      </label>
      <fieldset disabled={disabled}>
        <legend>适用 AI（不选则不限定）</legend>
        {!sources && !sourceError && <p role="status">正在读取可选择的 AI…</p>}
        {sourceError && <p role="alert">{sourceError}</p>}
        {sources?.employees.map((employee) => (
          <label className={styles.check} key={employee.id}>
            <input
              type="checkbox"
              checked={content.appliesToEmployeeIds.includes(employee.id)}
              disabled={
                !content.appliesToEmployeeIds.includes(employee.id) &&
                content.appliesToEmployeeIds.length >= 30
              }
              onChange={(e) =>
                setContent({
                  ...content,
                  appliesToEmployeeIds: e.target.checked
                    ? [...content.appliesToEmployeeIds, employee.id]
                    : content.appliesToEmployeeIds.filter(
                        (id) => id !== employee.id,
                      ),
                })
              }
            />
            {employee.name}
          </label>
        ))}
        {sources && !sources.employees.length && <p>当前没有可选择的 AI。</p>}
        {sources &&
          content.appliesToEmployeeIds.some(
            (id) => !sources.employees.some((e) => e.id === id),
          ) && (
            <p>
              部分已保存的适用 AI 当前不可选择。请刷新或核对配置；不会静默移除。
            </p>
          )}
      </fieldset>
      <label>
        可选记忆摘录
        <select
          aria-label="可选记忆摘录"
          disabled={disabled || !sources}
          value={content.sourceMemoryRevisionId ?? ''}
          onChange={(e) => {
            const chosen = sources?.sources.find(
              (s) => s.revisionId === e.target.value,
            );
            if (chosen)
              setContent({
                ...content,
                sourceMemoryId: chosen.id,
                sourceMemoryRevisionId: chosen.revisionId,
                body: chosen.content,
              });
            else {
              const {
                sourceMemoryId: _removed,
                sourceMemoryRevisionId: _revisionRemoved,
                ...rest
              } = content;
              void _removed;
              void _revisionRemoved;
              setContent(rest);
            }
          }}
        >
          <option value="">不引用记忆摘录</option>
          {content.sourceMemoryId &&
            !sources?.sources.some(
              (s) => s.revisionId === content.sourceMemoryRevisionId,
            ) && (
              <option value={content.sourceMemoryRevisionId}>
                保留已选择的原记忆版本
              </option>
            )}
          {sources?.sources.map((source, index) => (
            <option key={source.revisionId} value={source.revisionId}>
              摘录 {index + 1}：{source.content.slice(0, 70)}
            </option>
          ))}
        </select>
      </label>
      <p>
        选择摘录会填入正文；请编辑并核对最终规矩。只有最终保存、发布的内容会共享。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className={common.actions}>
        <Button
          variant="primary"
          disabled={disabled || !dirty}
          onClick={() => void save()}
        >
          {busy ? '正在提交…' : '保存规矩草稿'}
        </Button>
        {saved && (
          <Button disabled={busy} onClick={() => void refresh()}>
            {dirty ? '采用最新草稿（替换未保存编辑）' : '刷新草稿'}
          </Button>
        )}
      </div>
      {saved && (
        <CompanyAssetStateActions
          asset={saved}
          base={base}
          headers={adminHeaders}
          blocked={busy || dirty}
          onChange={(next) => {
            setSaved(next);
            setNotice('共享状态已更新。');
            onSaved();
          }}
        />
      )}
      {saved && dirty && <p>请先保存修改；发布按钮只作用于已保存的修订。</p>}
    </section>
  );
}

export function CompanyAssetsPanel({
  organizationId,
}: {
  organizationId: string;
}) {
  return <Panel key={organizationId} organizationId={organizationId} />;
}
function Panel({ organizationId }: { organizationId: string }) {
  const base = `/api/v1/admin/organizations/${organizationId}/assets`;
  const directory = useCompanyAssetDirectory(base, adminHeaders);
  const [kind, setKind] = useState<'all' | 'rule' | 'template'>('all');
  const [selected, setSelected] = useState<CompanyAsset | null>(null);
  const [editor, setEditor] = useState<{ initial?: CompanyAsset } | null>(null);
  const assets =
    directory.data?.assets.filter((a) => kind === 'all' || a.kind === kind) ??
    [];
  return (
    <section className={styles.panel} aria-label="公司规矩与范本">
      <h3>公司规矩与范本</h3>
      <p>
        规矩与范本按发布的版本共享。范本只共享选定文件，不共享作者的私人会话；保存草稿与发布是两个动作。
      </p>
      {directory.data && (
        <p>
          有效规矩正文：
          {directory.data.ruleBudget.publishedBytes.toLocaleString()} /{' '}
          {directory.data.ruleBudget.maximumBytes.toLocaleString()} 字节；最多{' '}
          {directory.data.ruleBudget.maximumRules} 项。
        </p>
      )}
      <div className={common.actions}>
        <label>
          内容类型
          <select
            aria-label="公司资料类型"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="all">全部</option>
            <option value="rule">公司规矩</option>
            <option value="template">公司范本</option>
          </select>
        </label>
        <Button
          icon="refresh"
          variant="quiet"
          disabled={directory.loading}
          onClick={() => {
            setSelected(null);
            setEditor(null);
            void directory.load();
          }}
        >
          刷新公司资料
        </Button>
        <Button
          variant="primary"
          icon="plus"
          onClick={() => {
            setSelected(null);
            setEditor({});
          }}
        >
          新增公司规矩
        </Button>
      </div>
      {directory.error && <p role="alert">{directory.error}</p>}
      {directory.loading && <p role="status">正在读取公司资料…</p>}
      <div className={styles.items}>
        {assets.map((asset) => (
          <article key={asset.id} className={common.item}>
            <strong>{asset.latest.content.title}</strong>
            <small>
              {asset.kind === 'rule' ? '公司规矩' : '公司范本'} ·{' '}
              {companyAssetStateLabels[asset.state]} · {asset.ownerName}
            </small>
            <small>
              最新修订 v{asset.latest.number}
              {asset.publishedRevisionId &&
              asset.publishedRevisionId !== asset.latest.id
                ? ' · 与当前共享版分开'
                : ''}
            </small>
            <div className={common.actions}>
              <Button onClick={() => setSelected(asset)}>查看修订与状态</Button>
              {asset.kind === 'rule' &&
                asset.canEdit &&
                asset.state !== 'archived' && (
                  <Button onClick={() => setEditor({ initial: asset })}>
                    编辑规矩草稿
                  </Button>
                )}
            </div>
          </article>
        ))}
      </div>
      {directory.data && !directory.loading && !assets.length && (
        <p>没有匹配的公司资料。范本由所选真实成果版本另存草稿并发布。</p>
      )}
      {directory.data?.nextCursor && (
        <Button
          disabled={directory.loading}
          onClick={() => void directory.load(true)}
        >
          更多公司资料
        </Button>
      )}
      {selected && !directory.error && (
        <AdminDialog
          ariaLabel="公司资料修订"
          title={selected.latest.content.title}
          onClose={() => setSelected(null)}
          size="wide"
        >
          <CompanyAssetRevisionView
            key={selected.id}
            initial={selected}
            base={base}
            headers={adminHeaders}
            onChange={(next) => setSelected(next)}
          />
        </AdminDialog>
      )}
      {editor && !directory.error && (
        <AdminDialog
          ariaLabel="编辑公司规矩"
          title={editor.initial ? '编辑公司规矩' : '新增公司规矩'}
          onClose={() => setEditor(null)}
          size="wide"
        >
          <CompanyRuleEditor
            key={editor.initial?.id ?? 'new-rule'}
            base={base}
            initial={editor.initial}
            onSaved={() => void directory.load()}
          />
        </AdminDialog>
      )}
    </section>
  );
}
