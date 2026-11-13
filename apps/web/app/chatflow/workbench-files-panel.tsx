'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  UuidSchema,
  type ReferenceRevision,
  type WorkbenchFile,
  type WorkbenchFileCatalog,
  type WorkbenchFileSharing,
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
import { DshDialog } from './dsh-upstream/Dialog';
import { WorkbenchIcon } from './workbench-modules';
import { useWorkbenchFileReference } from './use-workbench-file-reference';
import { useWorkbenchFileFavorite } from './use-workbench-file-favorite';
import { copyWorkbenchFileLink } from './workbench-file-link';
import css from './workbench-files-panel.module.css';
const scopeNames = {
  personal: '仅自己',
  departments: '指定部门',
  company: '全公司',
  workspace: '原工作区共享',
  platform: '平台资料',
};
function range(file: WorkbenchFile) {
  return file.sharing.scope === 'departments'
    ? file.sharing.departmentNames.join('、') || '部门已停用'
    : scopeNames[file.sharing.scope];
}
function size(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MiB`
    : bytes >= 1024
      ? `${Math.ceil(bytes / 1024)} KiB`
      : `${bytes} B`;
}
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
}) {
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
  const [notice, setNotice] = useState('');
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
            {employees.map((employee) => (
              <option value={employee.id} key={employee.id}>
                {employee.name}
              </option>
            ))}
            <option value="">全部员工</option>
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
      {(notice || referenceActions.notice) && (
        <p className={css.notice} role="status">
          {notice || referenceActions.notice}
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
              onNotice={setNotice}
              favoriteDisabled={favorite.disabled || !!favorite.using}
              onFavorite={() =>
                void favorite.setFavorite(file.objectId, !file.favorite)
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
  onNotice,
  favoriteDisabled,
  onFavorite,
}: {
  file: WorkbenchDeliverable;
  disabled: boolean;
  onUse: () => void;
  onNotice: (message: string) => void;
  favoriteDisabled: boolean;
  onFavorite: () => void;
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
          { id: 'copy', label: '复制链接' },
          {
            id: 'favorite',
            label: file.favorite ? '取消收藏' : '收藏',
            disabled: favoriteDisabled,
          },
        ]}
        onClose={() => setOpen(false)}
        onSelect={(id) => {
          setOpen(false);
          if (id === 'favorite') onFavorite();
          if (id === 'copy')
            void copyWorkbenchFileLink(file.workspaceId, file.objectId)
              .then(() => onNotice('链接已复制，仅你自己可以打开'))
              .catch((cause) => onNotice(message(cause)));
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
export function FileSettings(props: {
  file: WorkbenchFile | null;
  mode: 'sharing' | 'reference';
  options: WorkbenchFileCatalog['options'];
  workspaceId: string;
  headers: Record<string, string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = props.file?.sharing.scope;
  const [scope, setScope] = useState<WorkbenchFileSharing['scope'] | null>(
    !props.file || initial === 'personal'
      ? 'personal'
      : initial === 'departments' || initial === 'company'
        ? initial
        : null,
  );
  const [departments, setDepartments] = useState(
      props.file?.sharing.departmentIds ?? [],
    ),
    [reference, setReference] = useState(
      !!props.file && (props.mode === 'reference' || props.file.isReference),
    ),
    [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const reservation = useRef<{
    key: string;
    input: Record<string, unknown>;
    objectId?: string;
  } | null>(null);
  const mutationRequests = useRef(new Map<string, string>());
  const picker = useRef<HTMLInputElement>(null);
  const canCompany = props.options.maintenanceLevel === 'company',
    canDepartments =
      canCompany || props.options.maintenanceLevel === 'department';
  const choices = props.options.departments.filter(
    (department) => canCompany || department.id === props.options.departmentId,
  );
  const privateAllowed = !props.file || props.file.ownedByMe;
  const readBase64 = (selected: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(Error('文件读取失败，请重新选择。'));
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.readAsDataURL(selected);
    });
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (!scope) throw Error('请先选择文件的新可见范围。');
      const sharing: WorkbenchFileSharing = {
        scope,
        departmentIds: scope === 'departments' ? departments : [],
      };
      if (scope === 'departments' && !departments.length)
        throw Error('请至少选择一个部门。');
      const mutationKey = JSON.stringify([
        props.file?.objectId,
        props.file?.revision,
        file?.name,
        file?.size,
        file?.lastModified,
        sharing,
        reference,
      ]);
      const saveRequest =
        mutationRequests.current.get(mutationKey) ?? crypto.randomUUID();
      mutationRequests.current.set(mutationKey, saveRequest);
      if (props.file) {
        await workbenchJson(
          `/api/v1/workbench/files/${props.file.objectId}?workspaceId=${props.workspaceId}`,
          props.headers,
          {
            method: 'PATCH',
            body: JSON.stringify({
              workspaceId: props.workspaceId,
              requestId: saveRequest,
              expectedRevision: props.file.revision,
              sharing,
              ...(props.mode === 'reference' ||
              reference !== props.file.isReference
                ? { isReference: reference }
                : {}),
            }),
          },
        );
      } else {
        if (!file) throw Error('请先选择文件。');
        const key = JSON.stringify([
          file.name,
          file.size,
          file.lastModified,
          sharing,
        ]);
        if (!reservation.current || reservation.current.key !== key)
          reservation.current = {
            key,
            input: {
              workspaceId: props.workspaceId,
              requestId: crypto.randomUUID(),
              fileName: file.name,
              mediaType: file.type || 'application/octet-stream',
              contentBase64: await readBase64(file),
              sharing,
            },
          };
        const saved = (await workbenchJson(
          '/api/v1/workbench/files?workspaceId=' + props.workspaceId,
          props.headers,
          { method: 'POST', body: JSON.stringify(reservation.current.input) },
        )) as { objectId: string };
        reservation.current.objectId = saved.objectId;
        if (reference)
          await workbenchJson(
            `/api/v1/workbench/files/${saved.objectId}?workspaceId=${props.workspaceId}`,
            props.headers,
            {
              method: 'PATCH',
              body: JSON.stringify({
                workspaceId: props.workspaceId,
                requestId: saveRequest,
                expectedRevision: 1,
                isReference: true,
              }),
            },
          );
      }
      props.onSaved();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <DshDialog
      title={
        props.file
          ? props.mode === 'reference'
            ? '设为参考资料'
            : '可见范围'
          : '上传文件'
      }
      ariaLabel={
        props.file
          ? props.mode === 'reference'
            ? '设为参考资料'
            : '可见范围'
          : '上传文件'
      }
      onClose={() => {
        if (!busy) props.onClose();
      }}
      className={css.dialog}
      bodyClassName={css.dialogBody}
    >
      <form onSubmit={(event) => void save(event)} className={css.form}>
        {props.file ? (
          <>
            <div className={css.fileIdentity}>
              <FileTypeIcon path={props.file.fileName} size={32} />
              <div>
                <p className={css.filename}>{props.file.fileName}</p>
                <small>{size(props.file.sizeBytes)}</small>
              </div>
            </div>
            {props.mode === 'reference' && (
              <p className={css.hint}>保存这份文件，供后续工作查找使用。</p>
            )}
          </>
        ) : (
          <div
            className={css.dropzone}
            onDragOver={(event) => {
              event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (!busy) {
                setFile(event.dataTransfer.files[0] ?? null);
                reservation.current = null;
              }
            }}
          >
            {file ? (
              <div className={css.fileIdentity}>
                <FileTypeIcon path={file.name} size={32} />
                <div>
                  <p className={css.filename}>{file.name}</p>
                  <small>{size(file.size)}</small>
                </div>
              </div>
            ) : (
              <>
                <IconPlusOutlineRegular size={28} />
                <p>拖入文件，或选择文件</p>
                <small>文档、图片、表格与其他工作文件</small>
              </>
            )}
            <button
              type="button"
              disabled={busy}
              className={css.chooseFile}
              onClick={() => picker.current?.click()}
            >
              {file ? '更换文件' : '选择文件'}
            </button>
            <input
              ref={picker}
              hidden
              type="file"
              aria-label="选择上传文件"
              disabled={busy}
              onChange={(event) => {
                const next = event.target.files?.[0];
                if (next) {
                  setFile(next);
                  reservation.current = null;
                }
              }}
            />
          </div>
        )}
        <fieldset disabled={busy}>
          <legend>可见范围</legend>
          {scope === null && props.file && (
            <p className={css.hint}>
              当前为{range(props.file)}。请选择要保存的新范围。
            </p>
          )}
          <select
            className={css.scopeSelect}
            aria-label="可见范围"
            value={scope ?? ''}
            onChange={(event) =>
              setScope(event.target.value as WorkbenchFileSharing['scope'])
            }
          >
            {scope === null && (
              <option value="" disabled>
                选择新的可见范围
              </option>
            )}
            {(['personal', 'departments', 'company'] as const).map((value) => (
              <option
                key={value}
                value={value}
                disabled={
                  value === 'personal'
                    ? !privateAllowed
                    : value === 'company'
                      ? !canCompany
                      : !canDepartments
                }
              >
                {scopeNames[value]}
              </option>
            ))}
          </select>
          {scope === 'departments' && (
            <div className={css.departments} aria-label="选择可见部门">
              {choices.map((department) => (
                <label key={department.id}>
                  <input
                    type="checkbox"
                    checked={departments.includes(department.id)}
                    onChange={(event) =>
                      setDepartments((current) =>
                        event.target.checked
                          ? [...current, department.id]
                          : current.filter((id) => id !== department.id),
                      )
                    }
                  />
                  {department.name}
                </label>
              ))}
              {!choices.length && <p>暂无可选择的部门。</p>}
            </div>
          )}
          <p className={css.hint}>
            {scope === 'company'
              ? '公司成员可见，无需逐个选择部门。'
              : scope === 'departments'
                ? '仅所选部门及有相应维护权限的人可见。'
                : '仅你自己可见。'}
          </p>
        </fieldset>
        {props.mode !== 'reference' && (
          <label className={css.reference}>
            <span>
              设为参考资料<small>在后续工作中按需查找使用。</small>
            </span>
            <input
              type="checkbox"
              checked={reference}
              disabled={busy}
              onChange={(event) => setReference(event.target.checked)}
            />
          </label>
        )}
        <p className={css.hint}>共享这份文件，不公开原聊天。</p>
        {error && (
          <p role="alert" className={css.error}>
            {error}
          </p>
        )}
        <div className={css.formActions}>
          <button type="button" disabled={busy} onClick={props.onClose}>
            取消
          </button>
          <button
            type="submit"
            disabled={
              busy ||
              !props.options.writable ||
              scope === null ||
              (!props.file && !file)
            }
          >
            {busy
              ? '正在保存…'
              : props.file
                ? props.mode === 'reference'
                  ? '设为参考资料'
                  : '保存修改'
                : '上传文件'}
          </button>
        </div>
      </form>
    </DshDialog>
  );
}
