'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  UuidSchema,
  type ReferenceRevision,
  type WorkbenchFile,
  type WorkbenchDeliverable,
} from '@allrice/contracts';
import {
  FileTypeIcon,
  Menu,
  IconEllipsisOutlineRegular,
  IconPlusOutlineRegular,
  IconChevronDownOutlineRegular,
  IconSearchOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { workbenchJson } from '../../lib/chatflow/workbench-model';
import {
  WorkbenchDeliverablesActionsCatalogSchema,
  type WorkbenchDeliverablesActionsCatalog,
} from '../../lib/chatflow/workbench-file-actions';
import { WorkbenchIcon } from './workbench-modules';
import { useWorkbenchFileReference } from './use-workbench-file-reference';
import { useWorkbenchFileFavorite } from './use-workbench-file-favorite';
import css from './workbench-files-panel.module.css';
import { useReferencePublicationOptions } from './use-reference-publication-options';
function message(error: unknown) {
  return error instanceof Error ? error.message : '操作未完成，请重试。';
}
export function WorkbenchFilesPanel(props: {
  workspaceId: string;
  ownerKey: string;
  viewerId?: string;
  refreshKey: string;
  currentEmployee?: { id: string; name: string };
  employees?: Array<{ id: string; name: string }>;
  sessionId: string | null;
  headers: Record<string, string>;
  active: boolean;
  initialCategory?: 'all' | 'artifact' | 'reference';
  readOnly?: boolean;
  onOpen: (file: WorkbenchFile) => void;
  onUse: (reference: ReferenceRevision) => void;
  onTemplate?: (reference: ReferenceRevision) => void;
  onRead?: () => void;
  onPublish?: (file: WorkbenchDeliverable) => void;
}) {
  const publicationOptions = useReferencePublicationOptions({
    ...props,
    active: props.active && !!props.onPublish,
  }).options;
  const employeeScope = `${props.ownerKey}/${props.currentEmployee?.id ?? ''}`;
  const [employeeChoice, setEmployeeChoice] = useState({
    scope: employeeScope,
    id: props.currentEmployee?.id ?? '',
  });
  const selectedEmployeeId =
    employeeChoice.scope === employeeScope
      ? employeeChoice.id
      : (props.currentEmployee?.id ?? '');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<
    'all' | 'artifact' | 'upload' | 'favorite'
  >(props.initialCategory === 'artifact' ? 'artifact' : 'all');
  const [revision, setRevision] = useState(0);
  const employeeId = category === 'favorite' ? '' : selectedEmployeeId;
  const [page, setPage] = useState<{ key: string; cursor: string } | null>(
    null,
  );
  const [snapshot, setSnapshot] = useState<{
    key: string;
    value: WorkbenchDeliverablesActionsCatalog;
  } | null>(null);
  const [status, setStatus] = useState({ key: '', loading: false, error: '' });
  const [linkStatus, setLinkStatus] = useState<{
    scope: string;
    denied: boolean;
    error: string;
  } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const params = new URLSearchParams({
    workspaceId: props.workspaceId,
    view: 'deliverables',
    category,
    ...(employeeId ? { employeeInstanceId: employeeId } : {}),
    ...(query.trim() ? { query: query.trim() } : {}),
  });
  const request = params.toString(),
    key = `${props.ownerKey}/${request}`;
  if (page && page.key !== key) setPage(null);
  const cursor = page?.key === key ? page.cursor : null;
  const catalog = snapshot?.key === key ? snapshot.value : null;
  const loading = status.key === key && status.loading;
  const error = status.key === key ? status.error : '';
  const referenceActions = useWorkbenchFileReference(props);
  const favorite = useWorkbenchFileFavorite(props);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    if (props.initialCategory)
      setCategory(props.initialCategory === 'artifact' ? 'artifact' : 'all');
  }, [props.initialCategory]);
  useEffect(() => {
    if (!props.active) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setStatus({ key, loading: true, error: '' });
      void workbenchJson(
        '/api/v1/workbench/files?' +
          request +
          (cursor ? `&cursor=${cursor}` : ''),
        props.headers,
        { signal: controller.signal },
      )
        .then(WorkbenchDeliverablesActionsCatalogSchema.parse)
        .then((value) => {
          if (controller.signal.aborted) return;
          setSnapshot((prior) => ({
            key,
            value:
              cursor && prior?.key === key
                ? {
                    ...value,
                    files: [
                      ...new Map(
                        [...prior.value.files, ...value.files].map((file) => [
                          file.objectId,
                          file,
                        ]),
                      ).values(),
                    ],
                    quotableFileIds: [
                      ...new Set([
                        ...prior.value.quotableFileIds,
                        ...value.quotableFileIds,
                      ]),
                    ],
                  }
                : value,
          }));
          props.onRead?.();
          setStatus({ key, loading: false, error: '' });
        })
        .catch((cause) => {
          if (!controller.signal.aborted)
            setStatus({ key, loading: false, error: message(cause) });
        });
    }, 180);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [props.active, props.headers, request, key, revision, cursor]);
  useEffect(() => {
    setPage(null);
    reload();
  }, [props.refreshKey, reload]);
  useEffect(() => {
    const changed = () => {
      setPage(null);
      reload();
    };
    window.addEventListener('allrice:workbench-files-changed', changed);
    return () =>
      window.removeEventListener('allrice:workbench-files-changed', changed);
  }, [reload]);
  useEffect(() => {
    if (!props.active) return;
    const url = new URL(window.location.href),
      id = UuidSchema.safeParse(url.searchParams.get('file'));
    if (!id.success) return;
    const controller = new AbortController();
    setLinkStatus(null);
    if (url.searchParams.get('workspaceId') !== props.workspaceId) {
      setLinkStatus({ scope: props.ownerKey, denied: true, error: '' });
      return;
    }
    void workbenchJson(
      '/api/v1/workbench/files?' +
        new URLSearchParams({
          workspaceId: props.workspaceId,
          view: 'deliverables',
          objectId: id.data,
        }),
      props.headers,
      { signal: controller.signal },
    )
      .then(WorkbenchDeliverablesActionsCatalogSchema.parse)
      .then((value) => {
        if (controller.signal.aborted) return;
        const file = value.files.find((file) => file.objectId === id.data);
        if (!file) {
          setLinkStatus({ scope: props.ownerKey, denied: true, error: '' });
          return;
        }
        props.onOpen(file);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        const denied = [401, 403, 404].includes(
          (cause as { status?: number }).status ?? 0,
        );
        setLinkStatus({
          scope: props.ownerKey,
          denied,
          error: denied ? '' : message(cause),
        });
      });
    return () => controller.abort();
  }, [
    props.active,
    props.ownerKey,
    props.workspaceId,
    props.headers,
    revision,
  ]);
  if (!props.active) return null;
  if (linkStatus?.scope === props.ownerKey && linkStatus.denied)
    return (
      <section className={css.empty} aria-label="交付成果">
        <p>无权访问</p>
      </section>
    );
  const employees = [
    ...new Map(
      [...(catalog?.employees ?? []), ...(props.employees ?? [])].map(
        (employee) => [employee.id, employee],
      ),
    ).values(),
  ];
  if (
    props.currentEmployee &&
    !employees.some((employee) => employee.id === props.currentEmployee!.id)
  )
    employees.unshift(props.currentEmployee);
  const files = catalog?.files ?? [];
  return (
    <section className={css.panel} aria-label="交付成果">
      <div className={css.toolbar}>
        <div className={css.scopePicker}>
          <select
            aria-label="按员工筛选"
            disabled={category === 'favorite'}
            value={employeeId}
            onChange={(event) =>
              setEmployeeChoice({
                scope: employeeScope,
                id: event.target.value,
              })
            }
          >
            <option value="">全部员工</option>
            {employees.map((employee) => (
              <option value={employee.id} key={employee.id}>
                {employee.name}
              </option>
            ))}
          </select>
          <IconChevronDownOutlineRegular size={14} />
        </div>
        <div className={css.search}>
          <IconSearchOutlineRegular size={18} />
          <input
            type="search"
            aria-label="查找文件"
            placeholder="查找文件"
            value={query}
            maxLength={200}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>
      <nav className={css.tabs} aria-label="文件类型">
        {(
          [
            ['all', '全部'],
            ['artifact', '员工交付'],
            ['upload', '我的上传'],
            ['favorite', '我的收藏'],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            aria-pressed={category === id}
            key={id}
            onClick={() => setCategory(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {(error ||
        referenceActions.error ||
        favorite.error ||
        (linkStatus?.scope === props.ownerKey && linkStatus.error)) && (
        <p className={css.error} role="alert">
          {error ||
            referenceActions.error ||
            favorite.error ||
            linkStatus?.error}
          {(error || linkStatus?.error) && (
            <button type="button" onClick={reload}>
              重新加载
            </button>
          )}
        </p>
      )}
      {referenceActions.notice && (
        <p className={css.notice} role="status">
          {referenceActions.notice}
        </p>
      )}
      {referenceActions.pending && (
        <p className={css.notice} role="status">
          正在准备“{referenceActions.pending.reference.fileName}”…{' '}
          <button type="button" onClick={referenceActions.cancel}>
            取消等待
          </button>
        </p>
      )}
      <div
        className={css.list}
        ref={list}
        aria-busy={loading}
        onScroll={() => {
          const node = list.current;
          if (
            node &&
            node.scrollHeight - node.scrollTop - node.clientHeight < 80 &&
            catalog?.nextCursor &&
            !loading &&
            !error
          )
            setPage({ key, cursor: catalog.nextCursor });
        }}
      >
        {files.map((file) => (
          <article
            className={css.file}
            key={file.objectId}
            data-file-id={file.objectId}
          >
            <button
              type="button"
              className={css.fileMain}
              onClick={() => {
                props.onOpen(file);
              }}
              title={file.fileName}
              aria-label={file.fileName}
            >
              <span className={css.fileIcon}>
                <FileTypeIcon path={file.fileName} size={28} />
              </span>
              <span className={css.fileName}>
                {file.favorite && (
                  <span className={css.favorite} aria-label="已收藏">
                    <WorkbenchIcon kind="star" filled size={13} />
                  </span>
                )}
                {file.fileName}
              </span>
              <small>
                {new Date(file.createdAt).toLocaleString('zh-CN', {
                  month: 'numeric',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                {file.publication && (
                  <>
                    <span aria-hidden="true">·</span>
                    <WorkbenchIcon kind="materials" size={13} />
                    {file.publication.audience.scope === 'company'
                      ? '全公司'
                      : file.publication.audience.scope === 'personal'
                        ? '仅自己'
                        : publicationOptions?.departments
                            ?.filter((department) =>
                              file.publication!.audience.departmentIds.includes(
                                department.id,
                              ),
                            )
                            .map((department) => department.name)
                            .join('、')}
                  </>
                )}
              </small>
            </button>
            <FileMenu
              file={file}
              disabled={
                !!props.readOnly ||
                referenceActions.using !== null ||
                !catalog?.quotableFileIds.includes(file.objectId)
              }
              onUse={() => void referenceActions.useFile(file)}
              favoriteDisabled={favorite.disabled || !!favorite.using}
              onFavorite={() =>
                void favorite.setFavorite(file.objectId, !file.favorite)
              }
              onPublish={
                props.onPublish && catalog?.viewerId === props.viewerId
                  ? () => props.onPublish?.(file)
                  : undefined
              }
            />
          </article>
        ))}
        {!files.length && !loading && !error && (
          <div className={css.empty}>
            <WorkbenchIcon kind="files" size={36} />
            <h3>
              {query
                ? '未找到相关文件'
                : category === 'favorite'
                  ? '还没有收藏'
                  : '还没有交付成果'}
            </h3>
            <p>
              {query
                ? '换个关键词试试。'
                : '员工交付的文件和你在对话中上传的文件会显示在这里。'}
            </p>
          </div>
        )}
        {loading && (
          <p className={css.empty} role="status">
            正在读取文件…
          </p>
        )}
      </div>
    </section>
  );
}
function FileMenu({
  file,
  disabled,
  onUse,
  favoriteDisabled,
  onFavorite,
  onPublish,
}: {
  file: WorkbenchDeliverable;
  disabled: boolean;
  onUse: () => void;
  favoriteDisabled: boolean;
  onFavorite: () => void;
  onPublish?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={css.fileActions}>
      <Tooltip label="引用到对话" side="bottom" portal>
        <span>
          <button
            type="button"
            className={css.fileMenu}
            aria-label={`引用到对话 ${file.fileName}`}
            disabled={disabled}
            onClick={onUse}
          >
            <IconPlusOutlineRegular size={20} />
          </button>
        </span>
      </Tooltip>
      <Menu
        open={open}
        anchor={
          <Tooltip label="更多操作" side="bottom" disabled={open} portal>
            <button
              type="button"
              className={css.fileMenu}
              aria-label={`文件选项 ${file.fileName}`}
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
          {
            id: 'favorite',
            label: file.favorite ? '取消收藏' : '收藏',
            disabled: favoriteDisabled,
          },
          ...(onPublish
            ? [
                {
                  id: 'publish',
                  label: file.publication
                    ? '已添加为企业资料'
                    : '添加为企业资料',
                  disabled:
                    !!file.publication || file.canPublishReference !== true,
                },
              ]
            : []),
        ]}
        onClose={() => setOpen(false)}
        onSelect={(id) => {
          setOpen(false);
          if (id === 'favorite') onFavorite();
          if (id === 'publish') onPublish?.();
          if (id === 'download') {
            const a = document.createElement('a');
            a.href = `/api/v1/workbench/files/${file.objectId}/download?workspaceId=${file.workspaceId}`;
            a.download = file.fileName;
            document.body.append(a);
            a.click();
            a.remove();
          }
        }}
        align="end"
        portal
      />
    </div>
  );
}
