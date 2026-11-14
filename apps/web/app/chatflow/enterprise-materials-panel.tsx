'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { z } from 'zod';
import {
  ReferencePublicationQuerySchema,
  ReferencePublicationQueryResultSchema,
  type ReferenceSearchCursorSchema,
  ReferenceInputSelectionResultSchema,
  referenceSearchPolicy,
  ReferenceLibraryOptionsSchema,
  UuidSchema,
  type ReferenceRevision,
} from '@allrice/contracts';
import {
  FileTypeIcon,
  IconPlusOutlineRegular,
  IconLinkOutlineRegular,
  IconEllipsisOutlineRegular,
  IconEditOutlineRegular,
  IconTrashOutlineRegular,
  IconDownloadOutlineRegular,
  IconSearchOutlineRegular,
  Menu,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { workbenchJson } from '../../lib/chatflow/workbench-model';
import {
  checkReferenceSelectionFailure,
  ReferenceSelectionUnavailableError,
} from '../../lib/chatflow/reference-selection';
import { readJson } from './chatflow-utils';
import type { ReferenceDraft } from './reference-chips';
import { ReferenceSnapshotPreview } from './workbench-reference-preview';
import { WorkbenchIcon } from './workbench-modules';
import { WorkbenchFileIcon } from './workbench-file-icon';
import {
  referencePublicationLink,
  clearReferencePublicationLocation,
} from './reference-publication-link';
import reader from './document-reader.module.css';
import files from './workbench-files-panel.module.css';
import css from './enterprise-materials-panel.module.css';

const catalogSchema = ReferencePublicationQueryResultSchema.extend({
  viewerId: UuidSchema,
  options: ReferenceLibraryOptionsSchema,
});
export type ReferencePublicationOptions = z.infer<
  typeof ReferenceLibraryOptionsSchema
>;
export type ReferencePublicationManagementAction =
  'audience' | 'revoke' | 'delete';
type ReferenceLocation = { sourceId: string; revisionId: string };
const categories = {
  all: '全部',
  company: '全公司',
  departments: '部门',
  mine: '我的',
} as const;

export function EnterpriseMaterialsPanel(props: {
  ownerKey: string;
  viewerId?: string;
  workspaceId: string;
  sessionId: string | null;
  headers: Record<string, string>;
  active: boolean;
  readOnly?: boolean;
  initialReference?: ReferenceLocation;
  onUse: (reference: ReferenceDraft) => void;
  onNotice?: (message: string) => void;
  onUpload?: (options: ReferencePublicationOptions) => void;
  onManage?: (
    reference: ReferenceRevision,
    action: ReferencePublicationManagementAction,
    options: ReferencePublicationOptions,
  ) => void;
}) {
  const identity = `${props.ownerKey}/${props.workspaceId}/${props.viewerId}/${props.sessionId ?? 'draft'}`;
  const current = useRef(identity);
  current.current = identity;
  const active = useRef(props.active);
  active.current = props.active;
  const inputAllowed = useRef(false);
  inputAllowed.current = props.active && !props.readOnly;
  const [category, setCategory] = useState<keyof typeof categories>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<{
    key: string;
    cursor: z.infer<typeof ReferenceSearchCursorSchema>;
  } | null>(null);
  const [selected, setSelected] = useState<ReferenceLocation | null>(
    props.initialReference ?? null,
  );
  const [snapshot, setSnapshot] = useState<{
    key: string;
    value: z.infer<typeof catalogSchema>;
  } | null>(null);
  const [status, setStatus] = useState({
    key: '',
    loading: false,
    error: '',
    denied: false,
  });
  const [action, setAction] = useState({
    key: '',
    busy: '',
    error: '',
    notice: '',
  });
  const [deniedRevisions, setDeniedRevisions] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);
  const operation = useRef<AbortController | null>(null);
  const quoteOperation = useRef<AbortController | null>(null);
  const retryRequests = useRef(new Map<string, string>());
  const list = useRef<HTMLDivElement>(null);
  const sourceId = props.initialReference?.sourceId;
  const revisionId = props.initialReference?.revisionId;
  const locatedSourceId =
    selected?.sourceId === sourceId && selected?.revisionId === revisionId
      ? sourceId
      : undefined;
  const filterKey = `${identity}/${category}/${query.trim()}/${locatedSourceId ?? ''}`;
  const cursor = page?.key === filterKey ? page.cursor : undefined;
  const requestKey = `${filterKey}/${cursor ? JSON.stringify(cursor) : ''}`;
  const reload = useCallback(() => {
    setPage(null);
    setAttempt((n) => n + 1);
  }, []);
  useEffect(() => {
    setSelected(sourceId && revisionId ? { sourceId, revisionId } : null);
  }, [identity, sourceId, revisionId]);
  useEffect(() => {
    window.addEventListener('allrice:workbench-files-changed', reload);
    return () =>
      window.removeEventListener('allrice:workbench-files-changed', reload);
  }, [reload]);
  useEffect(() => {
    setAction((prior) =>
      prior.key === identity
        ? { ...prior, busy: '', notice: props.active ? prior.notice : '' }
        : { key: identity, busy: '', error: '', notice: '' },
    );
    return () => operation.current?.abort();
  }, [identity, props.active]);
  useEffect(() => {
    if (!props.readOnly || !quoteOperation.current) return;
    quoteOperation.current.abort();
    if (operation.current === quoteOperation.current)
      setAction((prior) => ({ ...prior, busy: '' }));
    quoteOperation.current = null;
  }, [props.readOnly]);
  useEffect(() => {
    if (!props.active || !props.viewerId) return;
    const controller = new AbortController();
    setStatus({ key: requestKey, loading: true, error: '', denied: false });
    const input = ReferencePublicationQuerySchema.parse({
      query: locatedSourceId ? '' : query,
      category: locatedSourceId ? 'all' : category,
      limit: 20,
      ...(locatedSourceId ? { sourceId: locatedSourceId } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const params = new URLSearchParams({
      workspaceId: props.workspaceId,
      category: input.category,
      query: input.query,
      limit: String(input.limit),
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    });
    if (input.cursor) params.set('cursor', JSON.stringify(input.cursor));
    void workbenchJson(
      '/api/v1/references/publications?' + params,
      props.headers,
      { signal: controller.signal },
    )
      .then(catalogSchema.parse)
      .then((value) => {
        if (controller.signal.aborted || current.current !== identity) return;
        if (
          value.viewerId !== props.viewerId ||
          value.options.workspaceId !== props.workspaceId
        )
          throw Error('资料加载失败');
        const denied =
          !!locatedSourceId &&
          !value.references.some(
            (r) =>
              r.sourceId === locatedSourceId && r.revisionId === revisionId,
          );
        setSnapshot((prior) => ({
          key: filterKey,
          value:
            cursor && prior?.key === filterKey
              ? {
                  ...value,
                  references: [
                    ...new Map(
                      [...prior.value.references, ...value.references].map(
                        (r) => [r.revisionId, r],
                      ),
                    ).values(),
                  ],
                  matches: [
                    ...new Map(
                      [...prior.value.matches, ...value.matches].map(
                        (match) => [match.revisionId, match],
                      ),
                    ).values(),
                  ],
                }
              : value,
        }));
        setStatus({ key: requestKey, loading: false, error: '', denied });
      })
      .catch((cause) => {
        if (controller.signal.aborted || current.current !== identity) return;
        setSnapshot(null);
        setStatus({
          key: requestKey,
          loading: false,
          error: '资料加载失败',
          denied:
            !!locatedSourceId &&
            [401, 403, 404].includes(
              (cause as { status?: number }).status ?? 0,
            ),
        });
      });
    return () => controller.abort();
  }, [
    identity,
    requestKey,
    filterKey,
    query,
    category,
    cursor,
    props.active,
    props.viewerId,
    props.workspaceId,
    props.headers,
    locatedSourceId,
    revisionId,
    attempt,
  ]);
  const catalog = snapshot?.key === filterKey ? snapshot.value : null;
  const visibleStatus = status.key === requestKey ? status : null;
  const activeAction = action.key === identity ? action : null;
  const reference = selected
    ? catalog?.references.find(
        (r) =>
          r.sourceId === selected.sourceId &&
          r.revisionId === selected.revisionId &&
          r.publication,
      )
    : undefined;
  const canManage = (r: ReferenceRevision) =>
    r.canMaintain &&
    r.publication?.publisherId === props.viewerId &&
    catalog?.viewerId === props.viewerId;
  const audienceLabel = (r: ReferenceRevision) => {
    const audience = r.publication!.audience;
    return audience.scope === 'personal'
      ? '仅自己'
      : audience.scope === 'company'
        ? '全公司'
        : audience.departmentIds
            .map(
              (id) =>
                catalog?.options.departments.find((d) => d.id === id)?.name,
            )
            .filter(Boolean)
            .join('、') || '指定部门';
  };
  const downloadUrl = (r: ReferenceRevision) =>
    `/api/v1/references/revisions/${r.revisionId}/download?workspaceId=${encodeURIComponent(props.workspaceId)}`;
  const quoteDisabled = (r: ReferenceRevision) =>
    !!props.readOnly ||
    !!activeAction?.busy ||
    r.status !== 'active' ||
    r.processing !== 'ready';
  async function quote(r: ReferenceRevision) {
    if (quoteDisabled(r) || !props.active || !props.viewerId) return;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    quoteOperation.current = controller;
    setAction({ key: identity, busy: r.revisionId, error: '', notice: '' });
    try {
      const response = await fetch(
        `/api/v1/references/revisions/${r.revisionId}/selection?workspaceId=${encodeURIComponent(props.workspaceId)}`,
        {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: props.headers,
          signal: controller.signal,
        },
      );
      await checkReferenceSelectionFailure(response, [r.revisionId]);
      const value = ReferenceInputSelectionResultSchema.parse(
        await readJson(response, { read: true }),
      );
      if (
        controller.signal.aborted ||
        current.current !== identity ||
        !inputAllowed.current
      )
        return;
      if (
        value.viewerId !== props.viewerId ||
        value.workspaceId !== props.workspaceId ||
        value.selection.sourceId !== r.sourceId ||
        value.selection.revisionId !== r.revisionId ||
        value.selection.revision !== r.revision
      )
        throw Error('操作未完成，请重试。');
      props.onUse({ ...value.selection, publication: r.publication });
      setDeniedRevisions((ids) => ids.filter((id) => id !== r.revisionId));
      setAction({ key: identity, busy: '', error: '', notice: '' });
    } catch (cause) {
      if (
        controller.signal.aborted ||
        current.current !== identity ||
        !inputAllowed.current
      )
        return;
      if (cause instanceof ReferenceSelectionUnavailableError) {
        setDeniedRevisions((ids) => [...new Set([...ids, r.revisionId])]);
        setSelected(null);
      }
      setAction({
        key: identity,
        busy: '',
        error: cause instanceof Error ? cause.message : '操作未完成，请重试。',
        notice: '',
      });
    } finally {
      if (quoteOperation.current === controller) quoteOperation.current = null;
    }
  }
  async function copy(r: ReferenceRevision) {
    try {
      await navigator.clipboard.writeText(
        referencePublicationLink(props.workspaceId, r.sourceId, r.revisionId),
      );
      if (current.current === identity && active.current) {
        const notice = '链接已复制，查看仍需资料访问权限';
        props.onNotice?.(notice);
        setAction({
          key: identity,
          busy: '',
          error: '',
          notice: props.onNotice ? '' : notice,
        });
      }
    } catch {
      if (current.current === identity && active.current)
        setAction({
          key: identity,
          busy: '',
          error: '操作未完成，请重试。',
          notice: '',
        });
    }
  }
  async function retry(r: ReferenceRevision) {
    if (
      r.canRetryProcessing !== true ||
      r.processing !== 'failed' ||
      activeAction?.busy ||
      !props.viewerId
    )
      return;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    const requestKey = `${identity}/${r.sourceId}/${r.revision}`;
    const requestId =
      retryRequests.current.get(requestKey) ?? crypto.randomUUID();
    retryRequests.current.set(requestKey, requestId);
    setAction({ key: identity, busy: r.revisionId, error: '', notice: '' });
    try {
      await workbenchJson(
        `/api/v1/references/${r.sourceId}`,
        { ...props.headers, 'X-AllRice-Expected-Viewer-Id': props.viewerId },
        {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({
            workspaceId: props.workspaceId,
            requestId,
            expectedRevision: r.revision,
            action: 'retry',
          }),
        },
      );
      if (controller.signal.aborted || current.current !== identity) return;
      // A later processing failure is a new user retry, while an unconfirmed
      // transport keeps the same key above until its receipt is received.
      retryRequests.current.delete(requestKey);
      setAction({ key: identity, busy: '', error: '', notice: '' });
      reload();
    } catch (cause) {
      if (!controller.signal.aborted && current.current === identity)
        setAction({
          key: identity,
          busy: '',
          error:
            cause instanceof Error ? cause.message : '操作未完成，请重试。',
          notice: '',
        });
    }
  }
  const manage = (
    r: ReferenceRevision,
    kind: ReferencePublicationManagementAction,
  ) => {
    if (catalog && canManage(r)) props.onManage?.(r, kind, catalog.options);
  };
  const iconAction = (
    label: string,
    icon: ReactNode,
    onClick: () => void,
    disabled = false,
  ) => (
    <Tooltip label={label} side="bottom" portal>
      <span>
        <button
          type="button"
          className={reader.iconButton}
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
        >
          {icon}
        </button>
      </span>
    </Tooltip>
  );
  const management = (r: ReferenceRevision) =>
    canManage(r) && props.onManage ? (
      <section className={css.management}>
        <p>管理（只有你能看到）</p>
        <div className={files.detailActions}>
          <button type="button" onClick={() => manage(r, 'audience')}>
            修改范围
          </button>
          <button
            type="button"
            className={css.destructive}
            onClick={() =>
              manage(r, r.publication!.origin === 'file' ? 'revoke' : 'delete')
            }
          >
            {r.publication!.origin === 'file' ? '撤销资料' : '删除资料'}
          </button>
        </div>
      </section>
    ) : null;
  if (!props.active) return null;
  if (visibleStatus?.denied)
    return (
      <section className={files.empty} aria-label="企业资料">
        <p>无权访问</p>
      </section>
    );
  return (
    <section
      className={`${files.panel} ${reference ? css.detail : ''}`}
      aria-label="企业资料"
    >
      {activeAction?.error && (
        <div className={files.error} role="alert">
          {activeAction.error}
        </div>
      )}
      {activeAction?.notice && (
        <div className={css.toast} role="status">
          {activeAction.notice}
        </div>
      )}
      {reference ? (
        <>
          <button
            type="button"
            className={css.back}
            onClick={() => {
              clearReferencePublicationLocation();
              setSelected(null);
            }}
          >
            ‹ 企业资料
          </button>
          <ReferenceSnapshotPreview
            key={`${identity}/${reference.revisionId}`}
            revisionId={reference.revisionId}
            title={reference.fileName}
            workspaceId={props.workspaceId}
            headers={props.headers}
            active={props.active}
            material={{
              purpose: reference.purpose,
              quickActions: iconAction(
                '引用到对话',
                <IconPlusOutlineRegular size={20} />,
                () => void quote(reference),
                quoteDisabled(reference),
              ),
              trailingActions: (
                <>
                  {iconAction(
                    '复制链接',
                    <IconLinkOutlineRegular size={20} />,
                    () => void copy(reference),
                  )}
                  {canManage(reference) && props.onManage && (
                    <>
                      {iconAction(
                        '修改范围',
                        <IconEditOutlineRegular size={20} />,
                        () => manage(reference, 'audience'),
                      )}
                      {iconAction(
                        reference.publication!.origin === 'file'
                          ? '撤销资料'
                          : '删除资料',
                        <IconTrashOutlineRegular size={20} />,
                        () =>
                          manage(
                            reference,
                            reference.publication!.origin === 'file'
                              ? 'revoke'
                              : 'delete',
                          ),
                      )}
                    </>
                  )}
                </>
              ),
              beforePreview:
                reference.processing === 'failed' ? (
                  <div className={`${files.error} ${css.failure}`} role="alert">
                    <span>读取失败：Rice 暂时无法读取这份资料的内容</span>
                    {reference.canRetryProcessing === true && (
                      <button
                        type="button"
                        disabled={!!activeAction?.busy}
                        onClick={() => void retry(reference)}
                      >
                        重新处理
                      </button>
                    )}
                  </div>
                ) : null,
              footer: (
                <footer className={files.detailFooter}>
                  <dl className={files.metadata}>
                    <dt>范围</dt>
                    <dd>{audienceLabel(reference)}</dd>
                    <dt>发布人</dt>
                    <dd>
                      {reference.publication!.publisherId === props.viewerId
                        ? '我'
                        : reference.publication!.publisherName}{' '}
                      · {new Date(reference.createdAt).toLocaleString('zh-CN')}
                    </dd>
                  </dl>
                  <div className={files.detailActions}>
                    <button
                      type="button"
                      disabled={quoteDisabled(reference)}
                      onClick={() => void quote(reference)}
                    >
                      <IconPlusOutlineRegular size={18} />
                      引用到对话
                    </button>
                    <a href={downloadUrl(reference)} download>
                      <IconDownloadOutlineRegular size={18} />
                      下载
                    </a>
                    <button type="button" onClick={() => void copy(reference)}>
                      <IconLinkOutlineRegular size={18} />
                      复制链接
                    </button>
                  </div>
                  {management(reference)}
                </footer>
              ),
            }}
          />
        </>
      ) : (
        <>
          <div className={css.tools}>
            <label className={css.search}>
              <IconSearchOutlineRegular size={18} />
              <input
                type="search"
                aria-label="查找资料（文件名、用途、正文）"
                placeholder="查找资料（文件名、用途、正文）"
                maxLength={referenceSearchPolicy.maximumQueryCharacters}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(null);
                }}
              />
            </label>
            {props.onUpload && catalog?.options.writable && (
              <button
                type="button"
                onClick={() => props.onUpload?.(catalog.options)}
              >
                <WorkbenchFileIcon kind="upload" />
                上传
              </button>
            )}
          </div>
          <div className={files.tabs} aria-label="资料范围">
            {Object.entries(categories).map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={category === value}
                onClick={() => {
                  setCategory(value as keyof typeof categories);
                  setPage(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {visibleStatus?.error ? (
            <div className={files.error} role="alert">
              资料加载失败{' '}
              <button type="button" onClick={reload}>
                重新加载
              </button>
            </div>
          ) : !catalog ? (
            <MaterialLoading />
          ) : (
            <div
              className={css.list}
              ref={list}
              aria-busy={visibleStatus?.loading}
              onScroll={() => {
                const node = list.current;
                if (
                  node &&
                  node.scrollHeight - node.scrollTop - node.clientHeight < 80 &&
                  catalog.nextCursor &&
                  !visibleStatus?.loading &&
                  !visibleStatus?.error
                )
                  setPage({ key: filterKey, cursor: catalog.nextCursor });
              }}
            >
              {catalog.references
                .filter((r) => r.publication)
                .map((r) => (
                  <article className={css.row} key={r.revisionId}>
                    <button
                      type="button"
                      className={css.open}
                      aria-label={r.fileName}
                      disabled={deniedRevisions.includes(r.revisionId)}
                      onClick={() =>
                        setSelected({
                          sourceId: r.sourceId,
                          revisionId: r.revisionId,
                        })
                      }
                    >
                      <FileTypeIcon path={r.fileName} size={28} />
                      <span>
                        <strong>
                          {r.fileName}
                          <small className={css.scope}>
                            {audienceLabel(r)}
                          </small>
                        </strong>
                        <small>
                          {r.purpose} ·{' '}
                          {r.publication!.publisherId === props.viewerId
                            ? '我'
                            : r.publication!.publisherName}{' '}
                          · {new Date(r.createdAt).toLocaleDateString('zh-CN')}
                        </small>
                        {query.trim() &&
                          catalog.matches
                            .filter(
                              (match) => match.revisionId === r.revisionId,
                            )
                            .map((match) => (
                              <span
                                className={css.excerpt}
                                key={match.revisionId}
                              >
                                <MarkedExcerpt
                                  content={match.content}
                                  query={query.trim()}
                                />
                              </span>
                            ))}
                      </span>
                    </button>
                    <div className={css.actions}>
                      {iconAction(
                        '引用到对话',
                        <IconPlusOutlineRegular size={20} />,
                        () => void quote(r),
                        quoteDisabled(r),
                      )}
                      <MaterialMenu
                        reference={r}
                        downloadUrl={downloadUrl(r)}
                        onCopy={() => void copy(r)}
                        onManage={
                          canManage(r) && props.onManage
                            ? (kind) => manage(r, kind)
                            : undefined
                        }
                      />
                    </div>
                  </article>
                ))}
              {!catalog.references.length && (
                <div className={files.empty}>
                  <WorkbenchIcon kind="materials" size={36} />
                  <h3>{query.trim() ? '未找到相关资料' : '还没有企业资料'}</h3>
                  <p>
                    {query.trim()
                      ? '换个关键词试试。'
                      : '你可以上传文件，也可以从交付成果添加。'}
                  </p>
                </div>
              )}
              {visibleStatus?.loading && <MaterialLoading />}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function MaterialLoading() {
  return (
    <div className={css.loading} role="status" aria-label="正在读取企业资料">
      <div />
      <div />
      <div />
    </div>
  );
}

function MarkedExcerpt({ content, query }: { content: string; query: string }) {
  return (
    <>
      {content.split(query).map((part, index) => (
        <span key={index}>
          {index > 0 && <mark>{query}</mark>}
          {part}
        </span>
      ))}
    </>
  );
}

function MaterialMenu(props: {
  reference: ReferenceRevision;
  downloadUrl: string;
  onCopy: () => void;
  onManage?: (action: ReferencePublicationManagementAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const withdrawal =
    props.reference.publication!.origin === 'file' ? 'revoke' : 'delete';
  return (
    <Menu
      open={open}
      anchor={
        <Tooltip label="更多操作" side="bottom" disabled={open} portal>
          <button
            type="button"
            className={css.menuButton}
            aria-label={`资料选项 ${props.reference.fileName}`}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <IconEllipsisOutlineRegular size={20} />
          </button>
        </Tooltip>
      }
      items={[
        { id: 'download', label: '下载' },
        { id: 'copy', label: '复制链接' },
        ...(props.onManage
          ? [
              { id: 'audience', label: '修改范围' },
              {
                id: withdrawal,
                label: withdrawal === 'revoke' ? '撤销资料' : '删除资料',
              },
            ]
          : []),
      ]}
      onClose={() => setOpen(false)}
      onSelect={(id) => {
        setOpen(false);
        if (id === 'copy') props.onCopy();
        else if (id === 'download') {
          const link = document.createElement('a');
          link.href = props.downloadUrl;
          link.download = props.reference.fileName;
          link.click();
        } else if (id === 'audience' || id === 'revoke' || id === 'delete')
          props.onManage?.(id);
      }}
      align="end"
      portal
    />
  );
}
