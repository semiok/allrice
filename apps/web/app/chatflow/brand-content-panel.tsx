'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { z } from 'zod';
import {
  BrandContentActionSchema,
  BrandContentBoardSchema,
  BrandContentBrandSchema,
  BrandContentFileRefSchema,
  BrandContentMutationReceiptSchema,
  StartBrandContentWorkflowSchema,
  WorkflowPackageSchema,
  brandContentTemplateKeys,
  type BrandContentBoard,
  type BrandContentFileRef,
  type BrandContentImage,
  type BrandContextContent,
  type WorkflowPackage,
} from '@allrice/contracts';
import { DshDialog } from './dsh-upstream/Dialog';
import css from './brand-content-panel.module.css';

const FileSchema = BrandContentFileRefSchema.extend({
  fileName: z.string(),
  mediaType: z.string(),
  sourceKind: z.enum(['uploaded', 'generated']).optional(),
  operationId: z.uuid().optional(),
}).passthrough();
const ReadSchema = z.object({
  brands: z.array(BrandContentBrandSchema),
  board: BrandContentBoardSchema.nullable(),
  packages: z.array(WorkflowPackageSchema),
  files: z.array(FileSchema),
});
type BoardRead = z.infer<typeof ReadSchema>;
type ContentFile = z.infer<typeof FileSchema>;
type Topic = BrandContentBoard['topics'][number];
type Article = BrandContentBoard['articles'][number];
type Bundle = BrandContentBoard['bundles'][number];
type Plan = BrandContentBoard['plans'][number];
type Stage = 'topics' | 'article' | 'revision' | 'handoff';
type Tab = 'context' | 'topics' | 'articles' | 'plans';
type Mutate = (
  input: Record<string, unknown>,
  success: string,
) => Promise<boolean>;
type RegisterReminder = (plan: Plan) => Promise<void>;
type Start = (
  stage: Stage,
  options?: {
    topicId?: string;
    articleId?: string;
    sessionId?: string;
    count?: number;
    platform?: string;
  },
) => Promise<void>;

export interface BrandContentPanelProps {
  scopeId?: string;
  workspaceId: string;
  instanceId: string;
  employeeName: string;
  headers: Record<string, string>;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}

const stageNames: Record<Stage, string> = {
  topics: '生成选题',
  article: '起草',
  revision: '按意见修订',
  handoff: '整理交接清单',
};
const tabs: Array<{ key: Tab; label: string }> = [
  { key: 'context', label: '品牌资料' },
  { key: 'topics', label: '选题' },
  { key: 'articles', label: '稿件' },
  { key: 'plans', label: '排期与回执' },
];

export function brandContentStageAvailable(
  packages: WorkflowPackage[],
  stage: Stage,
) {
  return packages.some(
    (item) => item.manifest.templateKey === brandContentTemplateKeys[stage],
  );
}

/** Never infer the current version from array order or a historical approval. */
export function currentBrandContentBundle(
  board: BrandContentBoard,
  article: Article,
) {
  return board.bundles.find(
    (bundle) =>
      bundle.id === article.currentBundleId && bundle.articleId === article.id,
  );
}

export function currentBrandContentApproval(
  board: BrandContentBoard,
  article: Article,
) {
  const bundle = currentBrandContentBundle(board, article);
  if (!bundle || article.state !== 'approved') return undefined;
  return board.reviews.find(
    (review) =>
      review.articleId === article.id &&
      review.bundleId === bundle.id &&
      review.bundleDigest === bundle.digest &&
      review.decision === 'approved',
  );
}

export function selectableBrandContentImages(files: ContentFile[]) {
  return files.filter(
    (file) =>
      file.mediaType.startsWith('image/') &&
      (file.sourceKind === 'uploaded' ||
        (file.sourceKind === 'generated' && Boolean(file.operationId))),
  );
}

function fileRef(file: BrandContentFileRef): BrandContentFileRef {
  return {
    objectId: file.objectId,
    checksum: file.checksum,
    ...(file.versionId ? { versionId: file.versionId } : {}),
  };
}

function readDraft<T>(key: string, fallback: T): T {
  try {
    return typeof window === 'undefined'
      ? fallback
      : (JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? fallback);
  } catch {
    return fallback;
  }
}

function useDraft<T>(key: string, initial: T) {
  const [draft, setDraft] = useState<T>(() => readDraft(key, initial));
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(draft));
    } catch {
      /* The form remains usable without browser storage. */
    }
  }, [key, draft]);
  return [draft, setDraft] as const;
}

function identityKey(headers: Record<string, string>) {
  // Isolate tab drafts when a different signed-in identity reuses this browser.
  let hash = 2166136261;
  for (const character of JSON.stringify(Object.entries(headers).sort()))
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}

export function BrandContentPanel(props: BrandContentPanelProps) {
  return (
    <BrandContentReader
      key={`${props.scopeId ?? ''}/${props.workspaceId}/${props.instanceId}/${identityKey(props.headers)}`}
      {...props}
    />
  );
}

function BrandContentReader(props: BrandContentPanelProps) {
  const scope = `allrice.brand-content.${props.scopeId ?? ''}.${props.workspaceId}.${props.instanceId}.${identityKey(props.headers)}`;
  const base = `/api/v1/employee-instances/${encodeURIComponent(props.instanceId)}/brand-content`;
  const headersRef = useRef(props.headers);
  headersRef.current = props.headers;
  const [selected, setSelected] = useState<string | undefined>(() =>
    readDraft<string | undefined>(`${scope}.brand`, undefined),
  );
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useDraft<Tab>(`${scope}.tab`, 'context');
  const [data, setData] = useState<BoardRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sequence = useRef(0);
  const requestIds = useRef(
    new Map<string, string>(
      readDraft<Array<[string, string]>>(`${scope}.requests`, []),
    ),
  );
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, []);

  const read = useCallback(
    async (brandId?: string, signal?: AbortSignal) => {
      const order = ++sequence.current;
      setLoading(true);
      try {
        const query = new URLSearchParams({ workspaceId: props.workspaceId });
        if (brandId) query.set('brandId', brandId);
        const result = ReadSchema.parse(
          await fetchJson(`${base}?${query}`, headersRef.current, {
            signal,
            cache: 'no-store',
          }),
        );
        if (signal?.aborted || order !== sequence.current) return false;
        if (brandId && result.board?.brand.id !== brandId)
          throw new Error('未能读取所选品牌，请重新选择。');
        setData(result);
        return true;
      } catch (cause) {
        if (signal?.aborted || order !== sequence.current) return false;
        setError(errorText(cause, '读取失败，请重试。已填写的内容仍保留。'));
        return false;
      } finally {
        if (!signal?.aborted && order === sequence.current) setLoading(false);
      }
    },
    [base, props.workspaceId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    void read(selected, controller.signal);
    return () => controller.abort();
  }, [read, selected]);

  useEffect(() => {
    if (data?.board) {
      try {
        sessionStorage.setItem(
          `${scope}.brand`,
          JSON.stringify(data.board.brand.id),
        );
      } catch {
        /* optional */
      }
    }
  }, [data, scope]);

  const requestIdFor = (input: unknown) => {
    const key = JSON.stringify(input);
    const existing = requestIds.current.get(key);
    if (existing) return existing;
    const requestId = crypto.randomUUID();
    requestIds.current.set(key, requestId);
    while (requestIds.current.size > 24)
      requestIds.current.delete(requestIds.current.keys().next().value!);
    try {
      sessionStorage.setItem(
        `${scope}.requests`,
        JSON.stringify([...requestIds.current]),
      );
    } catch {
      /* In-memory retries still use the same request. */
    }
    return requestId;
  };
  const finishRequest = (input: unknown) => {
    requestIds.current.delete(JSON.stringify(input));
    try {
      sessionStorage.setItem(
        `${scope}.requests`,
        JSON.stringify([...requestIds.current]),
      );
    } catch {
      /* Optional browser persistence. */
    }
  };
  const mutate: Mutate = async (input, success) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const action = BrandContentActionSchema.safeParse({
        ...input,
        workspaceId: props.workspaceId,
        instanceId: props.instanceId,
        requestId: requestIdFor(input),
      });
      if (!action.success) {
        if (
          action.error.issues.some((issue) =>
            issue.path.includes('publishedUrl'),
          )
        )
          throw new Error(
            '请填写真实的公开发布链接，示例链接或本地地址不可作为回执。输入仍保留。',
          );
        if (action.error.issues.some((issue) => issue.path.includes('facts')))
          throw new Error('请至少填写一条完整的真实事实。输入仍保留。');
        throw new Error('请检查必填内容、文件选择和时间后再提交。输入仍保留。');
      }
      const response = await fetchJson(base, headersRef.current, {
        method: 'POST',
        body: JSON.stringify(action.data),
      });
      const receipt = BrandContentMutationReceiptSchema.parse(
        (response as { receipt: unknown }).receipt,
      );
      if (!mounted.current) return false;
      const refreshed = await read(receipt.result.brandId);
      if (!mounted.current) return false;
      if (refreshed) finishRequest(input);
      setCreating(false);
      if (selected !== receipt.result.brandId)
        setSelected(receipt.result.brandId);
      setNotice(
        `${success}${receipt.replayed ? '（已核对上次提交结果）' : ''}${refreshed ? '' : '；结果已保存，请重新读取确认当前状态。'}`,
      );
      return true;
    } catch (cause) {
      setError(errorText(cause, '提交失败，输入仍保留。请核对后重试。'));
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const start: Start = async (stage, options = {}) => {
    if (inFlight.current || !data?.board) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const input = {
      workspaceId: props.workspaceId,
      brandId: data.board.brand.id,
      stage,
      ...options,
    };
    try {
      const startInput = StartBrandContentWorkflowSchema.parse({
        ...input,
        requestId: requestIdFor(input),
      });
      const result = z.object({ sessionId: z.uuid(), runId: z.uuid() }).parse(
        await fetchJson(`${base}/workflow`, headersRef.current, {
          method: 'POST',
          body: JSON.stringify(startInput),
        }),
      );
      if (!mounted.current) return;
      finishRequest(input);
      await read(data.board.brand.id);
      if (!mounted.current) return;
      setNotice(
        `${stageNames[stage]}任务已启动，请在对话中查看。完成后回到工作台刷新。`,
      );
      props.onOpenSession(result.sessionId);
    } catch (cause) {
      setError(
        errorText(cause, '任务未能启动，输入仍保留。可重试核对上次请求。'),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const registerReminder: RegisterReminder = async (plan) => {
    if (inFlight.current || !data?.board) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const input = {
      workspaceId: props.workspaceId,
      instanceId: props.instanceId,
      brandId: data.board.brand.id,
      planId: plan.id,
      expectedRevision: plan.revision,
    };
    const requestKey = { operation: 'reminder.register', ...input };
    try {
      const receipt = z
        .object({
          automationId: z.uuid(),
          planId: z.uuid(),
          revision: z.number().int().positive(),
          replayed: z.boolean(),
        })
        .parse(
          await fetchJson(`${base}/reminder`, headersRef.current, {
            method: 'POST',
            body: JSON.stringify({
              ...input,
              requestId: requestIdFor(requestKey),
            }),
          }),
        );
      if (!mounted.current) return;
      if (receipt.planId !== plan.id)
        throw new Error('提醒结果与当前排期不一致，请刷新核对。');
      const refreshed = await read(input.brandId);
      if (!mounted.current) return;
      if (refreshed) finishRequest(requestKey);
      setNotice(
        `到点提醒已登记，届时会投递到原会话。${receipt.replayed ? '已核对上次登记结果。' : ''}${refreshed ? '' : '请重新读取，确认提醒登记状态。'}`,
      );
    } catch (cause) {
      if (mounted.current)
        setError(errorText(cause, '提醒登记失败，请重试核对上次请求。'));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const board = creating ? null : (data?.board ?? null);
  const disabled = busy || loading;
  const chooseBrand = (value: string) => {
    setError('');
    setNotice('');
    if (!value) {
      setCreating(true);
      setTab('context');
    } else if (value !== (selected ?? data?.board?.brand.id)) {
      setCreating(false);
      setSelected(value);
    } else setCreating(false);
  };

  return (
    <DshDialog
      ariaLabel="内容工作台"
      title="内容工作台"
      eyebrow={props.employeeName}
      onClose={props.onClose}
      className={css.dialog}
      bodyClassName={css.body}
    >
      <div className={css.toolbar}>
        <label className={css.brandSelect}>
          品牌
          <select
            aria-label="选择品牌"
            value={creating ? '' : (board?.brand.id ?? selected ?? '')}
            disabled={busy || loading}
            onChange={(event) => chooseBrand(event.target.value)}
          >
            <option value="">新建品牌资料</option>
            {data?.brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={css.button}
          disabled={busy || loading}
          onClick={() => {
            setError('');
            void read(creating ? undefined : (board?.brand.id ?? selected));
          }}
        >
          刷新
        </button>
      </div>
      <nav aria-label="内容工作台分类" className={css.tabs}>
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={tab === item.key}
            onClick={() => setTab(item.key)}
            className={tab === item.key ? css.activeTab : ''}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className={css.content} aria-busy={busy || loading}>
        {error && (
          <p className={css.error} role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className={css.notice} role="status">
            {notice}
          </p>
        )}
        {loading && (
          <p className={css.muted} role="status">
            正在读取当前记录…
          </p>
        )}
        {!loading && !data && (
          <div className={css.actions}>
            <button
              type="button"
              className={css.button}
              onClick={() => {
                setError('');
                void read(selected);
              }}
            >
              重新读取
            </button>
            {selected && (
              <button
                type="button"
                className={css.button}
                onClick={() => {
                  setCreating(false);
                  setSelected(undefined);
                }}
              >
                返回品牌列表
              </button>
            )}
          </div>
        )}
        {data && (
          <>
            {board?.truncated && (
              <p className={css.notice}>
                历史记录较多，当前只展示最近一部分。请根据业务编号核对版本。
              </p>
            )}
            {tab === 'context' && (
              <BrandForm
                key={`${board?.brand.id ?? 'new'}/${board?.brand.contextRevisionId ?? 'new'}`}
                board={board}
                files={data.files}
                disabled={disabled}
                draftKey={`${scope}.context.${board?.brand.id ?? 'new'}.${board?.brand.contextRevisionId ?? 'new'}`}
                onMutate={mutate}
                onSaved={() => setTab('topics')}
              />
            )}
            {!board && tab !== 'context' && (
              <Empty>
                先保存品牌资料，再开始选题与写稿。
                <button
                  type="button"
                  className={css.linkButton}
                  onClick={() => setTab('context')}
                >
                  填写品牌资料
                </button>
              </Empty>
            )}
            {board && tab === 'topics' && (
              <TopicsPanel
                board={board}
                packages={data.packages}
                files={data.files}
                disabled={disabled}
                draftKey={`${scope}.topics.${board.brand.id}`}
                onMutate={mutate}
                onStart={start}
                onArticles={() => setTab('articles')}
              />
            )}
            {board && tab === 'articles' && (
              <ArticlesPanel
                board={board}
                packages={data.packages}
                files={data.files}
                disabled={disabled}
                draftKey={`${scope}.articles`}
                onMutate={mutate}
                onStart={start}
                onOpenSession={props.onOpenSession}
                onPlans={() => setTab('plans')}
                headers={props.headers}
              />
            )}
            {board && tab === 'plans' && (
              <PlansPanel
                board={board}
                packages={data.packages}
                disabled={disabled}
                draftKey={`${scope}.plans`}
                onMutate={mutate}
                onStart={start}
                onRegisterReminder={registerReminder}
                onOpenSession={props.onOpenSession}
              />
            )}
          </>
        )}
      </div>
    </DshDialog>
  );
}

type BrandDraft = {
  name: string;
  audience: string;
  tone: string;
  requirements: string;
  visualBrief: string;
  facts: Array<{ id: string; text: string }>;
  sourceIds: string[];
};

function BrandForm({
  board,
  files,
  disabled,
  draftKey,
  onMutate,
  onSaved,
}: {
  board: BrandContentBoard | null;
  files: ContentFile[];
  disabled: boolean;
  draftKey: string;
  onMutate: Mutate;
  onSaved: () => void;
}) {
  const context = board?.contexts.find(
    (item) => item.id === board.brand.contextRevisionId,
  );
  const [draft, setDraft] = useDraft<BrandDraft>(draftKey, {
    name: board?.brand.name ?? '',
    audience: context?.content.audience ?? '',
    tone: context?.content.tone ?? '',
    requirements: context?.content.requirements ?? '',
    visualBrief: context?.content.visualBrief ?? '',
    facts: context?.content.facts ?? [{ id: 'fact_1', text: '' }],
    sourceIds: context?.content.sourceFiles.map((file) => file.objectId) ?? [],
  });
  const set = (
    key: 'name' | 'audience' | 'tone' | 'requirements' | 'visualBrief',
    value: string,
  ) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const sourceFiles = draft.sourceIds
      .map(
        (id) =>
          files.find((file) => file.objectId === id) ??
          context?.content.sourceFiles.find((file) => file.objectId === id),
      )
      .filter((file): file is BrandContentFileRef => Boolean(file))
      .map(fileRef);
    const content: BrandContextContent = {
      ...context?.content,
      audience: draft.audience,
      tone: draft.tone,
      requirements: draft.requirements,
      visualBrief: draft.visualBrief,
      facts: draft.facts.filter((fact) => fact.text.trim()),
      sourceFiles,
      strategies: context?.content.strategies ?? [],
    };
    if (
      await onMutate(
        {
          operation: 'context.save',
          ...(board ? { brandId: board.brand.id } : {}),
          expectedRevision: board?.brand.revision ?? 0,
          name: draft.name,
          content,
        },
        '品牌资料已保存。',
      )
    )
      onSaved();
  };
  return (
    <form onSubmit={(event) => void submit(event)}>
      <SectionTitle
        title={board ? '品牌资料' : '建立品牌资料'}
        detail="写清事实与边界，供选题和写稿使用。"
      />
      {board && (
        <RecordInfo
          id={board.brand.id}
          revision={board.brand.revision}
          extra={`资料 v${context?.number ?? '—'}`}
        />
      )}
      <fieldset disabled={disabled} className={css.fieldset}>
        <div className={css.formGrid}>
          <Field label="品牌名称">
            <input
              required
              maxLength={160}
              value={draft.name}
              onChange={(event) => set('name', event.target.value)}
            />
          </Field>
          <Field label="目标受众">
            <textarea
              required
              maxLength={2000}
              rows={2}
              placeholder="谁会读？他们最关心什么？"
              value={draft.audience}
              onChange={(event) => set('audience', event.target.value)}
            />
          </Field>
          <Field label="表达语气">
            <textarea
              required
              maxLength={2000}
              rows={2}
              placeholder="例如：清楚、温和，有依据"
              value={draft.tone}
              onChange={(event) => set('tone', event.target.value)}
            />
          </Field>
          <Field label="内容规则">
            <textarea
              required
              maxLength={8000}
              rows={3}
              placeholder="必须说明、禁止夸大、需要避开的说法"
              value={draft.requirements}
              onChange={(event) => set('requirements', event.target.value)}
            />
          </Field>
          <Field label="视觉要求（选填）">
            <textarea
              maxLength={4000}
              rows={2}
              placeholder="画面风格、构图或配图限制"
              value={draft.visualBrief}
              onChange={(event) => set('visualBrief', event.target.value)}
            />
          </Field>
        </div>
        <div className={css.sectionHead}>
          <h3>真实事实</h3>
          <span className={css.muted}>每条只写已确认的内容</span>
        </div>
        <div className={css.stack}>
          {draft.facts.map((fact, index) => (
            <div className={css.factRow} key={fact.id}>
              <label>
                <span className={css.srOnly}>事实 {index + 1}</span>
                <textarea
                  required
                  maxLength={2000}
                  rows={2}
                  placeholder="输入可核对的品牌或产品事实"
                  value={fact.text}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      facts: current.facts.map((item) =>
                        item.id === fact.id
                          ? { ...item, text: event.target.value }
                          : item,
                      ),
                    }))
                  }
                />
              </label>
              <button
                type="button"
                className={css.linkButton}
                disabled={draft.facts.length === 1}
                aria-label={`删除事实 ${index + 1}`}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    facts: current.facts.filter((item) => item.id !== fact.id),
                  }))
                }
              >
                删除
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className={css.linkButton}
          disabled={draft.facts.length >= 100}
          onClick={() =>
            setDraft((current) => ({
              ...current,
              facts: [
                ...current.facts,
                {
                  id: `fact_${crypto.randomUUID().replaceAll('-', '')}`,
                  text: '',
                },
              ],
            }))
          }
        >
          ＋ 添加事实
        </button>
        <details className={css.details}>
          <summary>来源文件（已选 {draft.sourceIds.length}）</summary>
          <p className={css.muted}>
            从当前用户文件中选择事实依据；最多 24 个。资料中的既有来源会保留。
          </p>
          <div className={css.fileList}>
            {files.map((file) => (
              <label className={css.checkRow} key={file.objectId}>
                <input
                  type="checkbox"
                  checked={draft.sourceIds.includes(file.objectId)}
                  disabled={
                    !draft.sourceIds.includes(file.objectId) &&
                    draft.sourceIds.length >= 24
                  }
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      sourceIds: event.target.checked
                        ? [...current.sourceIds, file.objectId]
                        : current.sourceIds.filter(
                            (id) => id !== file.objectId,
                          ),
                    }))
                  }
                />
                <span>{file.fileName}</span>
              </label>
            ))}
          </div>
          {!files.length && (
            <p className={css.muted}>
              暂无可选文件，可先在文件库上传真实资料后刷新。
            </p>
          )}
          {draft.sourceIds
            .filter((id) => !files.some((file) => file.objectId === id))
            .map((id) => (
              <label className={css.checkRow} key={id}>
                <input
                  type="checkbox"
                  checked
                  onChange={() =>
                    setDraft((current) => ({
                      ...current,
                      sourceIds: current.sourceIds.filter(
                        (item) => item !== id,
                      ),
                    }))
                  }
                />
                <span>既有来源 · {id}</span>
              </label>
            ))}
        </details>
        <div className={css.actions}>
          <button type="submit" className={css.primary}>
            保存品牌资料
          </button>
          <span className={css.muted}>保存后可生成候选选题</span>
        </div>
      </fieldset>
    </form>
  );
}

function TopicsPanel({
  board,
  packages,
  files,
  disabled,
  draftKey,
  onMutate,
  onStart,
  onArticles,
}: {
  board: BrandContentBoard;
  packages: WorkflowPackage[];
  files: ContentFile[];
  disabled: boolean;
  draftKey: string;
  onMutate: Mutate;
  onStart: Start;
  onArticles: () => void;
}) {
  const [generation, setGeneration] = useDraft(draftKey, {
    platform: '小红书',
    count: 5,
  });
  const [filter, setFilter] = useState('candidate');
  const available = brandContentStageAvailable(packages, 'topics');
  const topics = [...board.topics]
    .filter((topic) => filter === 'all' || topic.state === filter)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const decideTopic: Mutate = async (input, success) => {
    const saved = await onMutate(input, success);
    if (saved && input.operation === 'topics.decide') {
      const choice = (input.choices as Array<{ decision: string }>)[0];
      if (choice) setFilter(choice.decision);
    }
    return saved;
  };
  return (
    <>
      <SectionTitle title="候选选题" detail="先确认方向，再让 AI 员工起草。" />
      <form
        className={css.generation}
        onSubmit={(event) => {
          event.preventDefault();
          void onStart('topics', generation);
        }}
      >
        <fieldset disabled={disabled} className={css.inlineFields}>
          <Field label="发布平台">
            <input
              required
              maxLength={80}
              value={generation.platform}
              onChange={(event) =>
                setGeneration((current) => ({
                  ...current,
                  platform: event.target.value,
                }))
              }
              list="brand-content-platforms"
            />
          </Field>
          <Field label="候选数量">
            <input
              required
              type="number"
              min={1}
              max={40}
              value={generation.count}
              onChange={(event) =>
                setGeneration((current) => ({
                  ...current,
                  count: Number(event.target.value),
                }))
              }
            />
          </Field>
          <button className={css.primary} disabled={!available} type="submit">
            生成候选
          </button>
        </fieldset>
        <WorkflowHint available={available} stage="topics" />
      </form>
      <div className={css.filters} aria-label="选题状态">
        {(
          [
            ['candidate', '待决定'],
            ['accepted', '已采纳'],
            ['rejected', '已弃选'],
            ['all', '全部'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            className={filter === value ? css.selectedFilter : css.button}
            onClick={() => setFilter(value)}
          >
            {label}{' '}
            {value === 'all'
              ? board.topics.length
              : board.topics.filter((topic) => topic.state === value).length}
          </button>
        ))}
      </div>
      {!topics.length && (
        <Empty>
          {filter === 'candidate'
            ? '暂无待决定选题。生成任务完成后，点击刷新读取候选。'
            : '暂无此状态的选题。'}
        </Empty>
      )}
      <div className={css.stack}>
        {topics.map((topic) => (
          <BrandContentTopicCard
            key={`${topic.id}/${topic.revision}`}
            topic={topic}
            board={board}
            files={files}
            disabled={disabled}
            draftKey={`${draftKey}.${topic.id}.${topic.revision}`}
            onMutate={decideTopic}
            onStart={onStart}
            articleAvailable={brandContentStageAvailable(packages, 'article')}
            onArticles={onArticles}
          />
        ))}
      </div>
      <datalist id="brand-content-platforms">
        <option value="小红书" />
        <option value="微信公众号" />
        <option value="抖音" />
        <option value="微博" />
        <option value="B站" />
      </datalist>
    </>
  );
}

export function BrandContentTopicCard({
  topic,
  board,
  files,
  disabled,
  draftKey,
  onMutate,
  onStart,
  articleAvailable,
  onArticles,
}: {
  topic: Topic;
  board: BrandContentBoard;
  files: ContentFile[];
  disabled: boolean;
  draftKey: string;
  onMutate: Mutate;
  onStart: Start;
  articleAvailable: boolean;
  onArticles: () => void;
}) {
  const [reason, setReason] = useDraft(draftKey, '');
  const context = board.contexts.find(
    (item) => item.id === topic.contextRevisionId,
  );
  const batch = board.batches.find((item) => item.topicIds.includes(topic.id));
  const article = board.articles.find((item) => item.topicId === topic.id);
  const decide = (decision: 'accepted' | 'rejected') =>
    batch &&
    onMutate(
      {
        operation: 'topics.decide',
        brandId: board.brand.id,
        batchId: batch.id,
        expectedRevision: batch.revision,
        choices: [{ topicId: topic.id, decision, reason }],
      },
      decision === 'accepted' ? '选题已采纳，可以起草。' : '选题已弃选。',
    );
  return (
    <article className={css.card}>
      <div className={css.cardHeading}>
        <h3>{topic.candidate.title}</h3>
        <Status>
          {topic.state === 'candidate'
            ? '待决定'
            : topic.state === 'accepted'
              ? '已采纳'
              : '已弃选'}
        </Status>
      </div>
      <p className={css.meta}>
        {topic.platform} · 资料 v{context?.number ?? '—'} ·{' '}
        {topic.candidate.audience}
      </p>
      <p className={css.prose}>{topic.candidate.angle}</p>
      <details className={css.details}>
        <summary>理由、提纲与事实来源</summary>
        <dl className={css.definition}>
          <dt>推荐理由</dt>
          <dd>{topic.candidate.rationale}</dd>
          <dt>内容提纲</dt>
          <dd>{topic.candidate.outline}</dd>
          {topic.candidate.imageBrief && (
            <>
              <dt>配图建议</dt>
              <dd>{topic.candidate.imageBrief}</dd>
            </>
          )}
          {topic.candidate.suggestedWindow && (
            <>
              <dt>时间建议</dt>
              <dd>{topic.candidate.suggestedWindow}</dd>
            </>
          )}
        </dl>
        <h4>引用的真实事实</h4>
        <ul className={css.sourceList}>
          {topic.candidate.factIds.map((id) => (
            <li key={id}>
              {context?.content.facts.find((fact) => fact.id === id)?.text ??
                `资料中未找到此事实（${id}），请先核对。`}
            </li>
          ))}
        </ul>
        {Boolean(context?.content.sourceFiles.length) && (
          <>
            <h4>该版资料的来源文件</h4>
            <ul className={css.sourceList}>
              {context?.content.sourceFiles.map((file) => (
                <li key={file.objectId}>
                  {files.find((item) => item.objectId === file.objectId)
                    ?.fileName ?? `来源 ${file.objectId}`}
                </li>
              ))}
            </ul>
          </>
        )}
        <RecordInfo id={topic.id} revision={topic.revision} />
      </details>
      {topic.state === 'candidate' ? (
        <fieldset className={css.fieldset} disabled={disabled || !batch}>
          <Field label="决定说明（选填）">
            <input
              maxLength={2000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <div className={css.actions}>
            <button
              type="button"
              className={css.primary}
              onClick={() => void decide('accepted')}
            >
              采纳选题
            </button>
            <button
              type="button"
              className={css.button}
              onClick={() => void decide('rejected')}
            >
              弃选
            </button>
          </div>
          {!batch && (
            <p className={css.error}>无法核对选题批次，请刷新后再决定。</p>
          )}
        </fieldset>
      ) : (
        <>
          {topic.decisionReason && (
            <p className={css.muted}>决定说明：{topic.decisionReason}</p>
          )}
          {topic.state === 'accepted' &&
            (article ? (
              <button type="button" className={css.button} onClick={onArticles}>
                查看已有稿件
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className={css.primary}
                  disabled={disabled || !articleAvailable}
                  onClick={() => void onStart('article', { topicId: topic.id })}
                >
                  让 AI 员工起草
                </button>
                <WorkflowHint stage="article" available={articleAvailable} />
              </>
            ))}
        </>
      )}
    </article>
  );
}

function ArticlesPanel({
  board,
  packages,
  files,
  disabled,
  draftKey,
  onMutate,
  onStart,
  onOpenSession,
  onPlans,
  headers,
}: {
  board: BrandContentBoard;
  packages: WorkflowPackage[];
  files: ContentFile[];
  disabled: boolean;
  draftKey: string;
  onMutate: Mutate;
  onStart: Start;
  onOpenSession: (id: string) => void;
  onPlans: () => void;
  headers: Record<string, string>;
}) {
  return (
    <>
      <SectionTitle
        title="稿件与审稿"
        detail="审核只对展示的当前版本生效；替换配图后需要重新审核。"
      />
      {!board.articles.length && (
        <Empty>
          暂无稿件。先在选题中采纳一个方向，再发起起草。任务完成后刷新。
        </Empty>
      )}
      <div className={css.stack}>
        {[...board.articles]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((article) => (
            <BrandContentArticleCard
              key={`${article.id}/${article.revision}`}
              article={article}
              board={board}
              files={files}
              disabled={disabled}
              draftKey={`${draftKey}.${article.id}.${article.revision}`}
              onMutate={onMutate}
              onStart={onStart}
              onOpenSession={onOpenSession}
              onPlans={onPlans}
              revisionAvailable={brandContentStageAvailable(
                packages,
                'revision',
              )}
              headers={headers}
            />
          ))}
      </div>
    </>
  );
}

export function BrandContentArticleCard({
  article,
  board,
  files,
  disabled,
  draftKey,
  onMutate,
  onStart,
  onOpenSession,
  onPlans,
  revisionAvailable,
  headers,
}: {
  article: Article;
  board: BrandContentBoard;
  files: ContentFile[];
  disabled: boolean;
  draftKey: string;
  onMutate: Mutate;
  onStart: Start;
  onOpenSession: (id: string) => void;
  onPlans: () => void;
  revisionAvailable: boolean;
  headers: Record<string, string>;
}) {
  const bundle = currentBrandContentBundle(board, article);
  const approval = currentBrandContentApproval(board, article);
  const topic = board.topics.find((item) => item.id === article.topicId);
  const title = topic?.candidate.title ?? '内容稿件';
  const reviews = board.reviews
    .filter((review) => review.articleId === article.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const [reason, setReason] = useDraft(`${draftKey}.review`, '');
  const [downloadError, setDownloadError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const download = async (item: Bundle) => {
    setDownloadError('');
    setDownloading(true);
    try {
      const name =
        files.find((file) => file.objectId === item.content.objectId)
          ?.fileName ?? `${title}-v${item.number}.md`;
      const response = await fetch(
        `/api/v1/files/${encodeURIComponent(item.content.objectId)}/download?name=${encodeURIComponent(name)}`,
        { headers, cache: 'no-store' },
      );
      if (!response.ok) throw new Error('暂时无法下载这版稿件，请重试。');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setDownloadError(errorText(cause, '下载失败，请重试。'));
    } finally {
      setDownloading(false);
    }
  };
  const review = (decision: 'approved' | 'rejected') =>
    bundle &&
    onMutate(
      {
        operation: 'article.review',
        brandId: board.brand.id,
        articleId: article.id,
        expectedRevision: article.revision,
        bundleDigest: bundle.digest,
        decision,
        reason,
      },
      decision === 'approved'
        ? '当前版本审稿通过，可以排期。'
        : '已退回并保留审稿意见，可以按意见重新起草。',
    );
  return (
    <article className={css.card}>
      <div className={css.cardHeading}>
        <h3>{title}</h3>
        <Status>
          {article.state === 'approved'
            ? '审稿通过'
            : article.state === 'changes_requested'
              ? '已退回'
              : '待审稿'}
        </Status>
      </div>
      <p className={css.meta}>
        {article.platform} · 当前稿件 v{bundle?.number ?? '—'} · 业务修订 r
        {article.revision}
      </p>
      {!bundle ? (
        <p className={css.error}>
          当前版本记录不完整，暂不可审核或排期。请刷新后核对。
        </p>
      ) : (
        <>
          <p className={css.prose}>{bundle.changeSummary}</p>
          <div className={css.actions}>
            <button
              type="button"
              className={css.button}
              disabled={downloading}
              onClick={() => void download(bundle)}
            >
              {downloading ? '正在下载…' : `下载当前稿件 v${bundle.number}`}
            </button>
            <button
              type="button"
              className={css.linkButton}
              onClick={() => onOpenSession(article.sessionId)}
            >
              查看写作对话
            </button>
          </div>
          {downloadError && (
            <p role="alert" className={css.error}>
              {downloadError}
            </p>
          )}
          <details className={css.details}>
            <summary>当前版本与历史审稿</summary>
            <RecordInfo id={article.id} revision={article.revision} />
            <dl className={css.definition}>
              <dt>当前内容版本</dt>
              <dd className={css.identifier}>{bundle.content.versionId}</dd>
              <dt>内容校验</dt>
              <dd className={css.identifier}>{bundle.content.checksum}</dd>
              <dt>稿件与配图校验</dt>
              <dd className={css.identifier}>{bundle.digest}</dd>
            </dl>
            {board.bundles
              .filter(
                (item) =>
                  item.articleId === article.id && item.id !== bundle.id,
              )
              .map((item) => (
                <div key={item.id} className={css.historyRow}>
                  <span>
                    历史稿件 v{item.number} · {item.changeSummary}
                  </span>
                  <button
                    type="button"
                    className={css.linkButton}
                    disabled={downloading}
                    onClick={() => void download(item)}
                  >
                    下载
                  </button>
                </div>
              ))}
            {!reviews.length && <p className={css.muted}>尚无审稿记录。</p>}
            {reviews.map((item) => (
              <div className={css.reviewHistory} key={item.id}>
                <strong>
                  {item.decision === 'approved' ? '通过' : '退回'} · 稿件 v
                  {board.bundles.find((version) => version.id === item.bundleId)
                    ?.number ?? '—'}
                  {item.bundleId === bundle.id ? ' · 当前版本' : ''}
                </strong>
                <p>{item.reason}</p>
                <span className={css.muted}>{displayTime(item.createdAt)}</span>
              </div>
            ))}
          </details>
          <ImageEditor
            key={bundle.id}
            article={article}
            bundle={bundle}
            brandId={board.brand.id}
            files={files}
            disabled={disabled}
            draftKey={`${draftKey}.images`}
            onMutate={onMutate}
          />
          {article.state === 'awaiting_review' && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void review('approved');
              }}
            >
              <fieldset className={css.fieldset} disabled={disabled}>
                <Field label={`对当前稿件 v${bundle.number} 的审稿意见`}>
                  <textarea
                    required
                    maxLength={2000}
                    rows={2}
                    placeholder="说明通过依据，或具体需要修改的内容"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </Field>
                <div className={css.actions}>
                  <button type="submit" className={css.primary}>
                    审稿通过
                  </button>
                  <button
                    type="button"
                    className={css.button}
                    disabled={!reason.trim()}
                    onClick={() => void review('rejected')}
                  >
                    退回修改
                  </button>
                </div>
              </fieldset>
            </form>
          )}
          {article.state === 'changes_requested' && (
            <div className={css.actions}>
              <button
                type="button"
                className={css.primary}
                disabled={disabled || !revisionAvailable}
                onClick={() =>
                  void onStart('revision', {
                    articleId: article.id,
                    sessionId: article.sessionId,
                  })
                }
              >
                按审稿意见重新起草
              </button>
              <WorkflowHint stage="revision" available={revisionAvailable} />
            </div>
          )}
          {approval && (
            <div className={css.actions}>
              <span className={css.muted}>
                当前稿件 v{bundle.number} 已通过审核
              </span>
              <button type="button" className={css.primary} onClick={onPlans}>
                去排期
              </button>
            </div>
          )}
          {article.state === 'approved' && !approval && (
            <p className={css.error}>
              缺少当前版本的准确审核记录，暂不可排期。请刷新核对。
            </p>
          )}
        </>
      )}
    </article>
  );
}

type ImageDraft = {
  slotKey: string;
  objectId: string;
  caption: string;
  summary: string;
  remove: boolean;
};
function ImageEditor({
  article,
  bundle,
  brandId,
  files,
  disabled,
  draftKey,
  onMutate,
}: {
  article: Article;
  bundle: Bundle;
  brandId: string;
  files: ContentFile[];
  disabled: boolean;
  draftKey: string;
  onMutate: Mutate;
}) {
  const selectable = selectableBrandContentImages(files);
  const first = bundle.images[0];
  let nextSlotNumber = 1;
  while (
    bundle.images.some((image) => image.slotKey === `image_${nextSlotNumber}`)
  )
    nextSlotNumber++;
  const nextSlot = `image_${nextSlotNumber}`;
  const [draft, setDraft] = useDraft<ImageDraft>(draftKey, {
    slotKey: first?.slotKey ?? 'cover',
    objectId: first?.file.objectId ?? '',
    caption: first?.caption ?? '',
    summary: '',
    remove: false,
  });
  const set = <K extends keyof ImageDraft>(key: K, value: ImageDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const currentImage = bundle.images.find(
    (image) => image.slotKey === draft.slotKey,
  );
  const selected = selectable.find((file) => file.objectId === draft.objectId);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.remove && !selected) return;
    const image: BrandContentImage | undefined = selected && {
      slotKey: draft.slotKey,
      file: fileRef(selected),
      sourceKind: selected.sourceKind as 'uploaded' | 'generated',
      ...(selected.sourceKind === 'generated'
        ? { operationId: selected.operationId }
        : {}),
      caption: draft.caption,
    };
    void onMutate(
      {
        operation: 'article.images',
        brandId,
        articleId: article.id,
        expectedRevision: article.revision,
        bundleDigest: bundle.digest,
        images: draft.remove ? [] : [image],
        removeSlots: draft.remove ? [draft.slotKey] : [],
        changeSummary: draft.summary,
      },
      '配图已更新并生成新的稿件版本，请重新审稿。',
    );
  };
  return (
    <details className={css.details}>
      <summary>
        配图（{bundle.images.length} 张）
        {bundle.images.length ? ' · 更换单图' : ' · 从文件中选择'}
      </summary>
      {bundle.images.map((image) => (
        <p className={css.imageRecord} key={image.slotKey}>
          <strong>
            {image.slotKey === 'cover' ? '封面图' : image.slotKey}
          </strong>
          <span>
            {files.find((file) => file.objectId === image.file.objectId)
              ?.fileName ?? '当前配图'}
          </span>
          <span className={css.muted}>
            {image.sourceKind === 'generated' ? '已有生成回执' : '已上传'}
            {image.caption ? ` · ${image.caption}` : ''}
          </span>
        </p>
      ))}
      <form onSubmit={submit}>
        <fieldset className={css.fieldset} disabled={disabled}>
          <div className={css.formGrid}>
            <Field label="要编辑的位置">
              <select
                value={draft.slotKey}
                onChange={(event) => {
                  const image = bundle.images.find(
                    (item) => item.slotKey === event.target.value,
                  );
                  setDraft((current) => ({
                    ...current,
                    slotKey: event.target.value,
                    objectId: image?.file.objectId ?? '',
                    caption: image?.caption ?? '',
                    remove: false,
                  }));
                }}
              >
                {bundle.images.map((image) => (
                  <option key={image.slotKey} value={image.slotKey}>
                    {image.slotKey === 'cover' ? '封面图' : image.slotKey}
                  </option>
                ))}
                {!bundle.images.some((image) => image.slotKey === 'cover') && (
                  <option value="cover">封面图</option>
                )}
                {bundle.images.length < 12 && (
                  <option value={nextSlot}>新增配图</option>
                )}
              </select>
            </Field>
            <Field label="当前用户的图片文件">
              <select
                required={!draft.remove}
                disabled={draft.remove}
                value={draft.objectId}
                onChange={(event) => set('objectId', event.target.value)}
              >
                <option value="">请选择图片</option>
                {selectable.map((file) => (
                  <option key={file.objectId} value={file.objectId}>
                    {file.fileName}
                    {file.sourceKind === 'generated' ? '（已有生成回执）' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="图片说明（选填）">
              <input
                maxLength={1000}
                disabled={draft.remove}
                value={draft.caption}
                onChange={(event) => set('caption', event.target.value)}
              />
            </Field>
            <Field label="本次配图修改说明">
              <input
                required
                maxLength={2000}
                value={draft.summary}
                onChange={(event) => set('summary', event.target.value)}
                placeholder="例如：替换为已确认的产品实拍图"
              />
            </Field>
          </div>
          {currentImage && (
            <label className={css.checkRow}>
              <input
                type="checkbox"
                checked={draft.remove}
                onChange={(event) => set('remove', event.target.checked)}
              />
              移除这个位置的图片
            </label>
          )}
          {!selectable.length && (
            <p className={css.muted}>
              暂无可选图片。请先上传图片，再刷新工作台。
            </p>
          )}
          <p className={css.muted}>
            每次只修改一个位置，其余配图保留。修改后需要重新审稿。
          </p>
          <button
            type="submit"
            className={css.button}
            disabled={!draft.summary.trim() || (!draft.remove && !selected)}
          >
            保存这张配图的修改
          </button>
        </fieldset>
      </form>
    </details>
  );
}

function PlansPanel({
  board,
  packages,
  disabled,
  draftKey,
  onMutate,
  onStart,
  onRegisterReminder,
  onOpenSession,
}: {
  board: BrandContentBoard;
  packages: WorkflowPackage[];
  disabled: boolean;
  draftKey: string;
  onMutate: Mutate;
  onStart: Start;
  onRegisterReminder: RegisterReminder;
  onOpenSession: (sessionId: string) => void;
}) {
  const approved = board.articles.filter((article) =>
    currentBrandContentApproval(board, article),
  );
  const [articleId, setArticleId] = useState(approved[0]?.id ?? '');
  const article = approved.find((item) => item.id === articleId) ?? approved[0];
  return (
    <>
      <SectionTitle
        title="排期与人工发布回执"
        detail="排期不等于已发布。请在实际发布后填写真实链接与时间。"
      />
      <div className={css.card}>
        {!approved.length ? (
          <Empty>
            暂无当前版本已审稿通过的稿件。审稿通过后可安排发布时间。
          </Empty>
        ) : (
          <>
            <Field label="选择已审稿通过的稿件">
              <select
                value={article?.id ?? ''}
                onChange={(event) => setArticleId(event.target.value)}
                disabled={disabled}
              >
                {approved.map((item) => (
                  <option key={item.id} value={item.id}>
                    {board.topics.find((topic) => topic.id === item.topicId)
                      ?.candidate.title ?? '内容稿件'}{' '}
                    · v{currentBrandContentBundle(board, item)?.number}
                  </option>
                ))}
              </select>
            </Field>
            {article && (
              <PlanForm
                key={`${article.id}/${article.revision}/${board.plans
                  .filter((plan) => plan.articleId === article.id)
                  .map((plan) => `${plan.id}.${plan.revision}`)
                  .join(',')}`}
                board={board}
                article={article}
                disabled={disabled}
                draftKey={`${draftKey}.${article.id}.${article.revision}`}
                onMutate={onMutate}
              />
            )}
            {article && (
              <div className={css.actions}>
                <button
                  type="button"
                  className={css.button}
                  disabled={
                    disabled || !brandContentStageAvailable(packages, 'handoff')
                  }
                  onClick={() =>
                    void onStart('handoff', {
                      articleId: article.id,
                      sessionId: article.sessionId,
                    })
                  }
                >
                  整理发布交接清单
                </button>
                <WorkflowHint
                  stage="handoff"
                  available={brandContentStageAvailable(packages, 'handoff')}
                />
              </div>
            )}
          </>
        )}
      </div>
      <div className={css.sectionHead}>
        <h3>排期记录</h3>
        <span className={css.muted}>{board.plans.length} 条</span>
      </div>
      {!board.plans.length && <Empty>暂无排期。</Empty>}
      <div className={css.stack}>
        {[...board.plans]
          .sort((a, b) => b.plannedAt.localeCompare(a.plannedAt))
          .map((plan) => (
            <BrandContentPlanCard
              key={`${plan.id}/${plan.revision}/${board.receipts.filter((receipt) => receipt.planId === plan.id).length}`}
              plan={plan}
              board={board}
              disabled={disabled}
              draftKey={`${draftKey}.receipt.${plan.id}.${plan.revision}`}
              onMutate={onMutate}
              onRegisterReminder={onRegisterReminder}
              onOpenSession={onOpenSession}
            />
          ))}
      </div>
    </>
  );
}

function PlanForm({
  board,
  article,
  disabled,
  draftKey,
  onMutate,
}: {
  board: BrandContentBoard;
  article: Article;
  disabled: boolean;
  draftKey: string;
  onMutate: Mutate;
}) {
  const bundle = currentBrandContentBundle(board, article)!;
  const review = currentBrandContentApproval(board, article)!;
  const plan = [...board.plans]
    .filter(
      (item) =>
        item.articleId === article.id &&
        item.bundleId === bundle.id &&
        item.state === 'planned' &&
        !board.receipts.some((receipt) => receipt.planId === item.id),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const [draft, setDraft] = useDraft(
    `${draftKey}.plan.${plan?.id ?? 'new'}.${plan?.revision ?? 0}`,
    {
      platform: plan?.platform ?? article.platform,
      timezone: plan?.timezone ?? browserTimezone(),
      plannedAt: plan ? zonedDateTimeInput(plan.plannedAt, plan.timezone) : '',
      publisher: plan?.publisher ?? '',
      notes: plan?.notes ?? '',
    },
  );
  const [timeError, setTimeError] = useState('');
  const set = (key: keyof typeof draft, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTimeError('');
    try {
      const plannedAt = brandContentZonedTime(draft.plannedAt, draft.timezone);
      void onMutate(
        {
          operation: 'plan.save',
          brandId: board.brand.id,
          articleId: article.id,
          expectedRevision: article.revision,
          ...(plan ? { planId: plan.id } : {}),
          bundleDigest: bundle.digest,
          reviewId: review.id,
          platform: draft.platform,
          plannedAt,
          timezone: draft.timezone,
          publisher: draft.publisher,
          notes: draft.notes,
        },
        '排期已保存。实际发布后请补充真实发布回执。',
      );
    } catch (cause) {
      setTimeError(errorText(cause, '请填写有效的计划时间和 IANA 时区。'));
    }
  };
  return (
    <form onSubmit={submit}>
      <fieldset className={css.fieldset} disabled={disabled}>
        <p className={css.muted}>绑定当前已审稿通过的稿件 v{bundle.number}</p>
        <div className={css.formGrid}>
          <Field label="发布平台">
            <input
              required
              maxLength={80}
              value={draft.platform}
              onChange={(event) => set('platform', event.target.value)}
            />
          </Field>
          <Field label="IANA 时区">
            <input
              required
              maxLength={64}
              value={draft.timezone}
              onChange={(event) => set('timezone', event.target.value)}
              list="brand-content-timezones"
              placeholder="Asia/Shanghai"
            />
          </Field>
          <Field label={`计划时间（${draft.timezone || '所选时区'}）`}>
            <input
              required
              type="datetime-local"
              value={draft.plannedAt}
              onChange={(event) => set('plannedAt', event.target.value)}
            />
          </Field>
          <Field label="实际发布负责人">
            <input
              required
              maxLength={160}
              value={draft.publisher}
              onChange={(event) => set('publisher', event.target.value)}
              placeholder="填写具体负责人"
            />
          </Field>
        </div>
        <Field label="交接备注（选填）">
          <textarea
            maxLength={2000}
            rows={2}
            value={draft.notes}
            onChange={(event) => set('notes', event.target.value)}
          />
        </Field>
        {timeError && (
          <p role="alert" className={css.error}>
            {timeError}
          </p>
        )}
        <button type="submit" className={css.primary}>
          {plan ? '更新排期' : '保存排期'}
        </button>
        <datalist id="brand-content-timezones">
          <option value="Asia/Shanghai" />
          <option value="Asia/Hong_Kong" />
          <option value="Asia/Tokyo" />
          <option value="Europe/London" />
          <option value="America/New_York" />
          <option value="UTC" />
        </datalist>
      </fieldset>
    </form>
  );
}

export function BrandContentPlanCard({
  plan,
  board,
  disabled,
  draftKey,
  onMutate,
  onRegisterReminder,
  onOpenSession,
}: {
  plan: Plan;
  board: BrandContentBoard;
  disabled: boolean;
  draftKey: string;
  onMutate: Mutate;
  onRegisterReminder?: RegisterReminder;
  onOpenSession?: (sessionId: string) => void;
}) {
  const article = board.articles.find((item) => item.id === plan.articleId);
  const bundle = board.bundles.find((item) => item.id === plan.bundleId);
  const receipts = board.receipts.filter(
    (receipt) => receipt.planId === plan.id,
  );
  const current = Boolean(
    article &&
    article.currentBundleId === plan.bundleId &&
    bundle?.digest === plan.bundleDigest &&
    currentBrandContentApproval(board, article),
  );
  const [cancelReason, setCancelReason] = useDraft(`${draftKey}.cancel`, '');
  const reminder: Record<Plan['reminderStatus'], string> = {
    not_registered: '未登记提醒',
    registered: '提醒已登记，尚未确认执行',
    reminded: '提醒已送达原会话',
    failed: '提醒执行失败',
    unknown: '提醒执行结果待核实',
  };
  return (
    <article className={css.card}>
      <div className={css.cardHeading}>
        <h3>
          {board.topics.find((topic) => topic.id === article?.topicId)
            ?.candidate.title ?? '内容排期'}
        </h3>
        <Status>
          {plan.state === 'cancelled'
            ? '已取消排期'
            : receipts.length
              ? '已提供人工发布回执'
              : '已排期 · 待人工发布'}
        </Status>
      </div>
      <p className={css.prose}>
        {displayTime(plan.plannedAt, plan.timezone)}（{plan.timezone}）
      </p>
      <p className={css.meta}>
        {plan.platform} · 负责人：{plan.publisher} · 稿件 v
        {bundle?.number ?? '—'}
      </p>
      {plan.notes && <p className={css.prose}>{plan.notes}</p>}
      <p className={css.muted}>{reminder[plan.reminderStatus]}</p>
      <div className={css.actions}>
        {plan.state === 'planned' &&
          current &&
          !receipts.length &&
          plan.reminderStatus === 'not_registered' && (
            <button
              type="button"
              className={css.button}
              disabled={disabled || !onRegisterReminder}
              onClick={() => void onRegisterReminder?.(plan)}
            >
              开启到点提醒
            </button>
          )}
        {plan.reminderMessageId && article && onOpenSession && (
          <button
            type="button"
            className={css.linkButton}
            onClick={() => onOpenSession(article.sessionId)}
          >
            查看提醒
          </button>
        )}
      </div>
      {!current && plan.state === 'planned' && !receipts.length && (
        <p className={css.notice}>
          当前稿件已变化或审核记录不完整，请核对当前版本并重新排期。
        </p>
      )}
      {receipts.map((receipt) => (
        <div className={css.receipt} key={receipt.id}>
          <strong>人工提供的发布记录 · 尚未核验</strong>
          <p>
            <a
              href={safePublicationUrl(receipt.publishedUrl)}
              target="_blank"
              rel="noopener noreferrer"
            >
              查看真实发布链接
            </a>
          </p>
          <p>
            {displayTime(receipt.actualPublishedAt, plan.timezone)}（
            {plan.timezone}） · {receipt.publisher}
          </p>
          <p className={css.prose}>{receipt.evidence}</p>
        </div>
      ))}
      {plan.state === 'planned' && current && !receipts.length && (
        <details className={css.details}>
          <summary>实际发布后，填写人工回执</summary>
          <ReceiptForm
            key={plan.id}
            plan={plan}
            brandId={board.brand.id}
            disabled={disabled}
            draftKey={draftKey}
            onMutate={onMutate}
          />
        </details>
      )}
      <details className={css.details}>
        <summary>
          排期编号与版本
          {plan.state === 'planned' && !receipts.length ? ' / 取消排期' : ''}
        </summary>
        <RecordInfo id={plan.id} revision={plan.revision} />
        <p className={`${css.identifier} ${css.muted}`}>{plan.bundleDigest}</p>
        {plan.state === 'planned' && !receipts.length && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void onMutate(
                {
                  operation: 'plan.cancel',
                  brandId: board.brand.id,
                  planId: plan.id,
                  expectedRevision: plan.revision,
                  reason: cancelReason,
                },
                '排期已取消。',
              );
            }}
          >
            <fieldset disabled={disabled} className={css.fieldset}>
              <Field label="取消原因">
                <input
                  required
                  maxLength={2000}
                  value={cancelReason}
                  onChange={(event) => setCancelReason(event.target.value)}
                />
              </Field>
              <button type="submit" className={css.button}>
                取消排期
              </button>
            </fieldset>
          </form>
        )}
      </details>
    </article>
  );
}

function ReceiptForm({
  plan,
  brandId,
  disabled,
  draftKey,
  onMutate,
}: {
  plan: Plan;
  brandId: string;
  disabled: boolean;
  draftKey: string;
  onMutate: Mutate;
}) {
  const [draft, setDraft] = useDraft(draftKey, {
    url: '',
    actualAt: '',
    publisher: plan.publisher,
    evidence: '',
    confirmed: false,
  });
  const [timeError, setTimeError] = useState('');
  const set = (
    key: 'url' | 'actualAt' | 'publisher' | 'evidence',
    value: string,
  ) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTimeError('');
    try {
      if (!draft.confirmed) return;
      const actualPublishedAt = brandContentZonedTime(
        draft.actualAt,
        plan.timezone,
      );
      void onMutate(
        {
          operation: 'receipt.record',
          brandId,
          planId: plan.id,
          expectedRevision: plan.revision,
          bundleDigest: plan.bundleDigest,
          platform: plan.platform,
          publisher: draft.publisher,
          publishedUrl: draft.url,
          actualPublishedAt,
          sourceType: 'manual_confirmation',
          evidence: draft.evidence,
          evidenceFiles: [],
        },
        '人工发布回执已记录。链接与时间为人工提供，尚未核验。',
      );
    } catch (cause) {
      setTimeError(errorText(cause, '请填写真实有效的发布时间。'));
    }
  };
  return (
    <form onSubmit={submit}>
      <fieldset className={css.fieldset} disabled={disabled}>
        <p className={css.muted}>
          请由发布者确认实际结果。排期时间不会自动作为发布时间。
        </p>
        <Field label="真实公开发布链接">
          <input
            required
            type="url"
            maxLength={2000}
            value={draft.url}
            onChange={(event) => set('url', event.target.value)}
            placeholder="https://…"
          />
        </Field>
        <div className={css.formGrid}>
          <Field label={`实际发布时间（${plan.timezone}）`}>
            <input
              required
              type="datetime-local"
              value={draft.actualAt}
              onChange={(event) => set('actualAt', event.target.value)}
            />
          </Field>
          <Field label="实际发布者">
            <input
              required
              maxLength={160}
              value={draft.publisher}
              onChange={(event) => set('publisher', event.target.value)}
            />
          </Field>
        </div>
        <Field label="发布结果与人工确认依据">
          <textarea
            required
            maxLength={4000}
            rows={2}
            value={draft.evidence}
            onChange={(event) => set('evidence', event.target.value)}
            placeholder="说明在哪个平台实际发布、如何确认该链接对应此版稿件"
          />
        </Field>
        <label className={css.checkRow}>
          <input
            required
            type="checkbox"
            checked={draft.confirmed}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                confirmed: event.target.checked,
              }))
            }
          />
          我已核对，以上链接和时间来自真实的人工发布结果。
        </label>
        {timeError && (
          <p className={css.error} role="alert">
            {timeError}
          </p>
        )}
        <button
          type="submit"
          className={css.primary}
          disabled={!draft.confirmed}
        >
          记录人工发布回执
        </button>
      </fieldset>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={css.field}>
      <span>{label}</span>
      {children}
    </label>
  );
}
function SectionTitle({ title, detail }: { title: string; detail: string }) {
  return (
    <div className={css.sectionTitle}>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
function Status({ children }: { children: ReactNode }) {
  return <span className={css.status}>{children}</span>;
}
function Empty({ children }: { children: ReactNode }) {
  return <div className={css.empty}>{children}</div>;
}
function RecordInfo({
  id,
  revision,
  extra,
}: {
  id: string;
  revision: number;
  extra?: string;
}) {
  return (
    <p className={`${css.recordInfo} ${css.identifier}`}>
      业务编号 {id} · r{revision}
      {extra ? ` · ${extra}` : ''}
    </p>
  );
}
function WorkflowHint({
  available,
  stage,
}: {
  available: boolean;
  stage: Stage;
}) {
  return !available ? (
    <p className={css.muted}>
      该员工暂未配置“{stageNames[stage]}”能力，请联系管理员。
    </p>
  ) : null;
}
function safePublicationUrl(value: string) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}
function displayTime(value: string, timezone?: string) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
      hourCycle: 'h23',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function zonedParts(value: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return [
    get('year'),
    get('month'),
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  ] as const;
}
function zonedDateTimeInput(value: string, timezone: string) {
  const [year, month, day, hour, minute] = zonedParts(
    Date.parse(value),
    timezone,
  );
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Convert a wall-clock entry in its declared IANA zone, independently of the viewer's zone. */
export function brandContentZonedTime(value: string, timezone: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new Error('请填写完整的日期和时间。');
  const [year, month, day, hour, minute] = value.split(/[-T:]/).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59
  )
    throw new Error('日期或时间无效，请重新填写。');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new Error('时区无效，请使用 IANA 时区，例如 Asia/Shanghai。');
  }
  const offsets = new Set<number>();
  // Both sides of a DST transition must be considered; ambiguous entries are rejected.
  for (const distance of [-36, 0, 36]) {
    const probe = wall + distance * 3600000;
    const [y, m, d, h, min, s] = zonedParts(probe, timezone);
    offsets.add(Date.UTC(y, m - 1, d, h, min, s) - probe);
  }
  const matches = [...offsets]
    .map((offset) => wall - offset)
    .filter(
      (instant) =>
        zonedDateTimeInput(new Date(instant).toISOString(), timezone) === value,
    );
  if (!matches.length)
    throw new Error('所选时区在这个时间发生夏令时跳变，请选择其他时间。');
  if (matches.length > 1)
    throw new Error('这个时间在所选时区重复出现，请选择不重叠的时间。');
  return new Date(matches[0]!).toISOString();
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  init: RequestInit = {},
) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...headers,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    if (response.ok)
      throw new Error('服务返回的内容无法读取，请刷新核对结果。');
  }
  if (!response.ok) {
    if (response.status === 409)
      throw new Error(
        '记录已变化或本次操作与当前状态不符。输入仍保留，请刷新核对版本后再提交。',
      );
    if (response.status === 401 || response.status === 403)
      throw new Error(
        '当前身份无权执行此操作。输入仍保留，请核对登录与工作区。',
      );
    if (response.status === 404)
      throw new Error('当前品牌、稿件或文件已不可用，请刷新核对。');
    if (response.status === 400 || response.status === 422)
      throw new Error(
        '提交内容未通过检查。请核对必填内容、真实链接、版本和时间。输入仍保留。',
      );
    throw new Error('服务暂时不可用。输入仍保留，请稍后重试核对上次提交结果。');
  }
  return value;
}
function errorText(cause: unknown, fallback: string) {
  return cause instanceof Error && !(cause instanceof z.ZodError)
    ? cause.message
    : fallback;
}
