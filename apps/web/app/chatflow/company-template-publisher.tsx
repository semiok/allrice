'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  CompanyAssetContentSchema,
  CompanyAssetDirectorySchema,
  CompanyAssetMutationSchema,
  CompanyAssetSchema,
  type CompanyAsset,
  type CompanyAssetContent,
  type CompanyAssetDirectory,
  type CompanyAssetMutation,
} from '@allrice/contracts';
import { DshDialog } from './dsh-upstream/Dialog';
import styles from './company-template-browser.module.css';

export const companyAssetStateLabels = {
  draft: '未发布草稿',
  published: '已共享',
  paused: '已暂停',
  withdrawn: '已撤回',
  archived: '已归档',
};
export function companyAssetUrl(base: string, values: Record<string, string>) {
  const [path, query] = base.split('?');
  const params = new URLSearchParams(query);
  Object.entries(values).forEach(([key, value]) => params.set(key, value));
  return `${path}?${params}`;
}
export async function companyAssetJson(
  url: string,
  headers: Record<string, string>,
  options: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...options,
    headers: { ...headers, ...options.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.error;
    throw Object.assign(
      Error(
        typeof detail?.message === 'string'
          ? detail.message
          : response.status === 409
            ? '内容已有变化，请刷新后核对。'
            : response.status === 403 || response.status === 404
              ? '当前内容不可访问，或权限已撤销。'
              : response.status === 401
                ? '登录已失效，请重新登录。'
                : '公司资料服务暂不可用，请刷新核对操作结果。',
      ),
      { status: response.status, code: detail?.code },
    );
  }
  return body;
}

/** Only reads the existing directory. No polling or automatic mutations. */
export function useCompanyAssetDirectory(
  base: string,
  headers: Record<string, string>,
  enabled = true,
) {
  const scope = JSON.stringify([base, headers, enabled]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const request = useRef<AbortController | null>(null);
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    data: CompanyAssetDirectory | null;
    error: string;
    loading: boolean;
  }>({ scope, data: null, error: '', loading: false });
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const load = useCallback(
    async (more = false) => {
      if (!enabled) return;
      const previous =
        latest.current.scope === scope ? latest.current.data : null;
      if (more && !previous?.nextCursor) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setSnapshot({ scope, data: previous, error: '', loading: true });
      try {
        const data = CompanyAssetDirectorySchema.parse(
          await companyAssetJson(
            more
              ? companyAssetUrl(base, { after: previous!.nextCursor! })
              : base,
            headers,
            { signal: controller.signal },
          ),
        );
        if (controller.signal.aborted || currentScope.current !== scope) return;
        setSnapshot({
          scope,
          data: more
            ? {
                ...data,
                assets: [
                  ...new Map(
                    [...previous!.assets, ...data.assets].map((a) => [a.id, a]),
                  ).values(),
                ],
              }
            : data,
          error: '',
          loading: false,
        });
      } catch (error) {
        if (controller.signal.aborted || currentScope.current !== scope) return;
        setSnapshot({
          scope,
          data: null,
          error:
            error instanceof Error ? error.message : '目录读取失败，请刷新。',
          loading: false,
        });
      }
    },
    [base, enabled, headers, scope],
  );
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);
  return {
    ...(snapshot.scope === scope
      ? snapshot
      : { data: null, error: '', loading: enabled }),
    load,
  };
}

type StateOperation = Exclude<CompanyAssetMutation['operation'], 'save'>;
export function companyAssetActions(asset: CompanyAsset): StateOperation[] {
  if (!asset.canEdit || asset.state === 'archived') return [];
  const actions: StateOperation[] = [];
  if (asset.latest.id !== asset.publishedRevisionId || asset.state === 'draft')
    actions.push('publish');
  if (asset.state === 'published') actions.push('pause', 'withdraw');
  if (asset.state === 'published' && asset.kind === 'template')
    actions.push(asset.pinned ? 'unpin' : 'pin');
  if (
    (asset.state === 'paused' || asset.state === 'withdrawn') &&
    asset.publishedRevisionId
  )
    actions.push('resume');
  if (asset.state === 'paused') actions.push('withdraw');
  actions.push('archive');
  return actions;
}
const operationLabels: Record<StateOperation, string> = {
  publish: '发布已保存草稿',
  pause: '暂停共享',
  resume: '恢复共享版',
  withdraw: '撤回共享',
  archive: '归档',
  pin: '置顶推荐',
  unpin: '取消置顶',
};
const operationNotices: Record<StateOperation, string> = {
  publish: '将已保存的这一修订共享给本公司员工。私人会话和其他文件不会共享。',
  pause:
    '暂停后，公司员工不能再读取此范本的新预览或下载。已有工作不会自动重跑。',
  resume: '恢复原共享修订。尚未发布的最新草稿不会随之共享。',
  withdraw: '撤回后禁止新的预览和下载；已经下载的文件无法从他人电脑收回。',
  archive: '归档后不再共享此内容。历史修订保留用于核对。',
  pin: '在本公司员工的推荐入口优先展示当前共享范本。不会发布新草稿或启动工作。',
  unpin: '取消本公司的优先展示，现有共享版本与成果不变。',
};
export function CompanyAssetStateActions({
  asset,
  base,
  headers,
  blocked = false,
  onChange,
}: {
  asset: CompanyAsset;
  base: string;
  headers: Record<string, string>;
  blocked?: boolean;
  onChange: (asset: CompanyAsset) => void;
}) {
  const [operation, setOperation] = useState<StateOperation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setOperation(null);
  }, [asset.revision]);
  useEffect(() => () => request.current?.abort(), []);
  async function confirm() {
    if (
      !operation ||
      busy ||
      blocked ||
      !companyAssetActions(asset).includes(operation)
    )
      return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const changed = CompanyAssetSchema.parse(
        await companyAssetJson(base, headers, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify(
            CompanyAssetMutationSchema.parse({
              operation,
              assetId: asset.id,
              expectedRevision: asset.revision,
            }),
          ),
        }),
      );
      if (!controller.signal.aborted) {
        setOperation(null);
        onChange(changed);
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : '操作结果待确认，请刷新核对。',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const actions = companyAssetActions(asset);
  if (!actions.length) return null;
  return (
    <div className={styles.actions}>
      {actions.map((action) => (
        <Button
          key={action}
          disabled={busy || blocked}
          onClick={() => {
            setError('');
            setOperation(action);
          }}
        >
          {operationLabels[action]}
        </Button>
      ))}
      {operation && (
        <div className={styles.confirm}>
          <p>{operationNotices[operation]}</p>
          {operation === 'publish' && (
            <p>
              将发布修订 v{asset.latest.number}：{asset.latest.content.title}
            </p>
          )}
          <Button
            variant="primary"
            disabled={busy || blocked}
            onClick={() => void confirm()}
          >
            {busy ? '正在提交…' : `确认${operationLabels[operation]}`}
          </Button>
          <Button disabled={busy} onClick={() => setOperation(null)}>
            暂不操作
          </Button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function CompanyTemplateEditor({
  base,
  headers,
  versionId,
  fileName,
  initial,
  onSaved,
}: {
  base: string;
  headers: Record<string, string>;
  versionId: string;
  fileName: string;
  initial?: CompanyAsset;
  onSaved?: (asset: CompanyAsset) => void;
}) {
  const [assetId] = useState(() => initial?.id ?? crypto.randomUUID());
  const [saved, setSaved] = useState(initial ?? null);
  const [content, setContent] = useState<CompanyAssetContent>(
    () =>
      initial?.latest.content ?? {
        kind: 'template',
        title: fileName,
        body: '',
        category: '',
        appliesToEmployeeIds: [],
        taskKeywords: [],
        slots: [],
        sourceVersionId: versionId,
      },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const parsed = CompanyAssetContentSchema.safeParse(content);
  const dirty =
    !saved ||
    !parsed.success ||
    JSON.stringify(parsed.data) !== JSON.stringify(saved.latest.content);
  async function save() {
    if (busy || saved?.state === 'archived' || (saved && !saved.canEdit))
      return;
    if (!parsed.success) {
      setError('请填写标题、用途，并为每个填写项提供标签；最多 12 项。');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = CompanyAssetSchema.parse(
        await companyAssetJson(base, headers, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify(
            CompanyAssetMutationSchema.parse({
              operation: 'save',
              assetId,
              expectedRevision: saved?.revision ?? 0,
              content: parsed.data,
            }),
          ),
        }),
      );
      if (controller.signal.aborted) return;
      setSaved(result);
      setContent(result.latest.content);
      setNotice('草稿已保存。确认发布后，所选修订才会共享给公司员工。');
      onSaved?.(result);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : '保存结果待确认，请刷新核对。',
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
      const next = CompanyAssetSchema.parse(
        await companyAssetJson(companyAssetUrl(base, { assetId }), headers, {
          signal: controller.signal,
        }),
      );
      if (!controller.signal.aborted) {
        setSaved(next);
        setContent(next.latest.content);
        setNotice('已采用最新保存草稿，请核对后编辑或发布。');
      }
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
    <section className={styles.editor} aria-label="公司范本草稿">
      <p>
        所选原件：<strong>{fileName}</strong>
        。只共享此成果版本的文件副本，不共享私人会话或其他附件。
      </p>
      {saved && (
        <p>
          {companyAssetStateLabels[saved.state]} · 最新草稿 v
          {saved.latest.number}
          {saved.publishedRevisionId &&
          saved.publishedRevisionId !== saved.latest.id
            ? ' · 原共享版保持不变'
            : ''}
        </p>
      )}
      <label>
        范本标题
        <Input
          aria-label="范本标题"
          value={content.title}
          maxLength={160}
          disabled={disabled}
          onChange={(e) => setContent({ ...content, title: e.target.value })}
        />
      </label>
      <label>
        用途与说明
        <textarea
          aria-label="范本用途与说明"
          value={content.body}
          maxLength={4000}
          rows={4}
          disabled={disabled}
          onChange={(e) => setContent({ ...content, body: e.target.value })}
        />
      </label>
      <fieldset disabled={disabled}>
        <legend>填写项（可选）</legend>
        <p>注明使用这份范本所需的资料。</p>
        {content.slots.map((slot, index) => (
          <div key={slot.key} className={styles.slot}>
            <label>
              填写项 {index + 1}
              <Input
                aria-label={`填写项 ${index + 1} 标签`}
                value={slot.label}
                maxLength={80}
                onChange={(e) =>
                  setContent({
                    ...content,
                    slots: content.slots.map((s, i) =>
                      i === index ? { ...s, label: e.target.value } : s,
                    ),
                  })
                }
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={slot.required}
                onChange={(e) =>
                  setContent({
                    ...content,
                    slots: content.slots.map((s, i) =>
                      i === index ? { ...s, required: e.target.checked } : s,
                    ),
                  })
                }
              />
              必填
            </label>
            <label>
              <input
                type="checkbox"
                checked={slot.multiline}
                onChange={(e) =>
                  setContent({
                    ...content,
                    slots: content.slots.map((s, i) =>
                      i === index ? { ...s, multiline: e.target.checked } : s,
                    ),
                  })
                }
              />
              多行
            </label>
            <Button
              onClick={() =>
                setContent({
                  ...content,
                  slots: content.slots.filter((_, i) => i !== index),
                })
              }
            >
              移除此填写项
            </Button>
          </div>
        ))}
        <Button
          disabled={content.slots.length >= 12}
          onClick={() =>
            setContent({
              ...content,
              slots: [
                ...content.slots,
                {
                  key: `field_${crypto.randomUUID().replaceAll('-', '')}`,
                  label: '',
                  required: false,
                  multiline: false,
                },
              ],
            })
          }
        >
          添加填写项
        </Button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className={styles.actions}>
        <Button
          variant="primary"
          disabled={disabled || !dirty}
          onClick={() => void save()}
        >
          {busy ? '正在提交…' : '保存范本草稿'}
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
          headers={headers}
          blocked={busy || dirty}
          onChange={(next) => {
            setSaved(next);
            setNotice('共享状态已更新。');
            onSaved?.(next);
          }}
        />
      )}
      {saved && dirty && (
        <p>先保存修改，再发布所选修订；旧共享版不会自动更新。</p>
      )}
    </section>
  );
}

export function CompanyTemplatePublisher(props: {
  workspaceId: string;
  headers: Record<string, string>;
  versionId: string;
  fileName: string;
}) {
  return (
    <Publisher
      key={JSON.stringify([props.workspaceId, props.headers, props.versionId])}
      {...props}
    />
  );
}
function Publisher({
  workspaceId,
  headers,
  versionId,
  fileName,
}: Parameters<typeof CompanyTemplatePublisher>[0]) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button aria-haspopup="dialog" onClick={() => setOpen(true)}>
        共享为公司范本
      </Button>
      {open && (
        <DshDialog
          ariaLabel="共享为公司范本"
          title="准备公司范本"
          onClose={() => setOpen(false)}
          className={styles.dialog}
          bodyClassName={styles.body}
        >
          <CompanyTemplateEditor
            base={companyAssetUrl('/api/v1/company-assets', { workspaceId })}
            headers={headers}
            versionId={versionId}
            fileName={fileName}
          />
        </DshDialog>
      )}
    </>
  );
}
