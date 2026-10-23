'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  type ReferenceRevision,
  type WorkbenchFile,
  type WorkbenchFileCatalog,
  type WorkbenchFileSharing,
} from '@allrice/contracts';
import {
  FileTypeIcon,
  classifyFileType,
  Menu,
  IconEllipsisOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconChevronDownOutlineRegular,
  IconSearchOutlineRegular,
  IconSettingsOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { workbenchJson } from '../../lib/chatflow/workbench-model';
import {
  WorkbenchFileActionsCatalogSchema,
  type WorkbenchFileActionsCatalog,
} from '../../lib/chatflow/workbench-file-actions';
import { DshDialog } from './dsh-upstream/Dialog';
import { isToolResultFile } from '../../lib/chatflow/document-reader-model';
import { WorkbenchIcon } from './workbench-modules';
import { WorkbenchFileIcon } from './workbench-file-icon';
import { useWorkbenchFileReference } from './use-workbench-file-reference';
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
  const [scope, setScope] = useState('all'),
    [query, setQuery] = useState(''),
    [category, setCategory] = useState(props.initialCategory ?? 'all');
  const [snapshot, setSnapshot] = useState<{
      key: string;
      value: WorkbenchFileActionsCatalog;
    } | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [loading, setLoading] = useState(false),
    [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState<WorkbenchFile | 'upload' | null>(null),
    [editorMode, setEditorMode] = useState<'sharing' | 'reference'>('sharing');
  const referenceActions = useWorkbenchFileReference(props);
  const { using, pending, useFile } = referenceActions;
  const params = new URLSearchParams({
    workspaceId: props.workspaceId,
    scope,
    ...(props.sessionId ? { sessionId: props.sessionId } : {}),
    ...(query.trim() ? { query: query.trim() } : {}),
  });
  const key = params.toString(),
    catalog = snapshot?.key === key ? snapshot.value : null;
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  const changed = () => {
    reload();
    window.dispatchEvent(new Event('allrice:workbench-files-changed'));
  };
  useEffect(() => {
    if (props.initialCategory) setCategory(props.initialCategory);
  }, [props.initialCategory]);
  useEffect(() => {
    if (!props.active) return;
    const controller = new AbortController(),
      timer = setTimeout(() => {
        setLoading(true);
        setError('');
        void workbenchJson('/api/v1/workbench/files?' + key, props.headers, {
          signal: controller.signal,
        })
          .then(WorkbenchFileActionsCatalogSchema.parse)
          .then((value) => {
            if (controller.signal.aborted) return;
            setSnapshot({ key, value });
            props.onRead?.();
          })
          .catch((error) => {
            if (!controller.signal.aborted) {
              setSnapshot(null);
              setError(message(error));
            }
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
      }, 180);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [props.active, props.headers, key, revision]);
  useEffect(() => {
    window.addEventListener('allrice:workbench-files-changed', reload);
    return () =>
      window.removeEventListener('allrice:workbench-files-changed', reload);
  }, [reload]);
  const files = (catalog?.files ?? []).filter(
    (file) =>
      category === 'all' ||
      (category === 'artifact' && file.category === 'artifact') ||
      (category === 'reference' && file.isReference),
  );
  if (!props.active) return null;
  return (
    <section className={css.panel} aria-label="工作区文件">
      <div className={css.toolbar}>
        <div className={css.scopePicker}>
          <select
            aria-label="文件范围"
            value={scope}
            onChange={(event) => setScope(event.target.value)}
          >
            <option value="all">全部可见</option>
            <option value="current" disabled={!props.sessionId}>
              本次对话
            </option>
            <option value="my">我的文件</option>
            <option value="departments">部门共享</option>
            <option value="company">公司共享</option>
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
          <Tooltip label="刷新文件列表" side="bottom" portal>
            <button
              type="button"
              className={css.iconButton}
              aria-label="刷新文件列表"
              disabled={loading}
              onClick={reload}
            >
              <IconRefreshOutlineRegular size={20} />
            </button>
          </Tooltip>
        </div>
        <button
          type="button"
          className={css.upload}
          onClick={() => setEditor('upload')}
          disabled={!catalog?.options.writable}
        >
          <WorkbenchFileIcon kind="upload" />
          上传
        </button>
      </div>
      <nav className={css.tabs} aria-label="文件类型">
        {(
          [
            ['all', '全部'],
            ['artifact', '交付成果'],
            ['reference', '参考资料'],
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
      {(error || referenceActions.error) && (
        <p className={css.error} role="alert">
          {error || referenceActions.error}
        </p>
      )}
      {(notice || referenceActions.notice) && (
        <p className={css.notice} role="status">
          {notice || referenceActions.notice}
        </p>
      )}
      {pending && (
        <p role="status" className={css.notice}>
          正在准备“{pending.reference.fileName}”…{' '}
          <button
            type="button"
            onClick={() => {
              referenceActions.cancel();
            }}
          >
            取消等待
          </button>
        </p>
      )}
      <div className={css.list} aria-busy={loading}>
        {files.map((file) => {
          const version =
            catalog?.fileVersions[file.objectId] ?? file.artifact?.version;
          return (
            <article
              className={css.file}
              key={file.objectId}
              data-file-id={file.objectId}
            >
              <button
                type="button"
                className={css.fileMain}
                onClick={() => props.onOpen(file)}
                title={file.fileName}
                aria-label={file.fileName + (version ? ` · v${version}` : '')}
              >
                <span className={css.fileIcon}>
                  <FileTypeIcon
                    kind={classifyFileType(file.fileName)}
                    size={28}
                  />
                </span>
                <span className={css.fileName}>
                  {isToolResultFile(file.fileName, file.objectId)
                    ? `${file.fileName.startsWith('tool-result-web-search-') ? '搜索资料' : '工具记录'} · ${file.objectId.slice(0, 8)}`
                    : file.fileName}
                  {version ? ` · v${version}` : ''}
                </span>
                <small>
                  <span>
                    {file.fileName.split('.').at(-1)?.toUpperCase() || '文件'}
                  </span>
                  <span>·</span>
                  {size(file.sizeBytes)}
                  <span>·</span>
                  <span className={css.range} title={range(file)}>
                    {range(file)}
                  </span>
                  {file.isReference
                    ? ` · 长期参考${file.reference && file.reference.checksum !== file.checksum ? ' · 早期版本' : ''}${file.reference?.processing === 'ready' ? '' : file.reference?.processing === 'failed' ? ' · 处理失败' : file.reference?.processing === 'unsupported' ? '' : ' · 准备中'}`
                    : ''}
                </small>
              </button>
              <FileMenu
                file={file}
                quotable={
                  catalog?.quotableFileIds.includes(file.objectId) ?? false
                }
                disabled={props.readOnly || using !== null}
                onUse={() => {
                  setNotice('');
                  setError('');
                  void useFile(file);
                }}
                onEdit={(mode) => {
                  setEditorMode(mode);
                  setEditor(file);
                }}
              />
            </article>
          );
        })}
        {!files.length && !loading && !error && (
          <div className={css.empty}>
            <WorkbenchIcon kind="files" size={36} />
            <p>
              {query
                ? '没有找到匹配的文件。'
                : category === 'reference'
                  ? '暂无长期参考资料。可在文件设置中将可维护的文件设为长期参考。'
                  : '这个范围内暂无文件。'}
            </p>
          </div>
        )}
        {loading && !files.length && (
          <p className={css.empty} role="status">
            正在读取文件…
          </p>
        )}
        {catalog?.truncated && (
          <p className={css.hint}>
            显示最近 200 个文件。可缩小范围或按名称查找。
          </p>
        )}
      </div>
      {editor && catalog && (
        <FileSettings
          key={
            editor === 'upload'
              ? 'upload'
              : editor.objectId + '/' + editor.revision
          }
          file={editor === 'upload' ? null : editor}
          mode={editorMode}
          options={catalog.options}
          workspaceId={props.workspaceId}
          headers={props.headers}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            changed();
            setNotice('文件设置已保存。');
          }}
        />
      )}
    </section>
  );
}
function FileMenu({
  file,
  quotable,
  disabled,
  onUse,
  onEdit,
}: {
  file: WorkbenchFile;
  quotable: boolean;
  disabled: boolean;
  onUse: () => void;
  onEdit: (mode: 'sharing' | 'reference') => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={css.fileActions}>
      <Tooltip label="可见范围" side="bottom" portal>
        <button
          type="button"
          className={css.fileMenu}
          aria-label={`可见范围 ${file.fileName}`}
          disabled={!file.canMaintain}
          onClick={() => onEdit('sharing')}
        >
          <IconSettingsOutlineRegular size={20} />
        </button>
      </Tooltip>
      <Menu
        open={open}
        anchor={
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
        }
        items={[
          ...(quotable ? [{ id: 'use', label: '引用文件', disabled }] : []),
          ...(file.canMaintain && !file.isReference
            ? [{ id: 'reference', label: '设为参考资料' }]
            : []),
          { id: 'download', label: '下载' },
        ]}
        onClose={() => setOpen(false)}
        onSelect={(id) => {
          setOpen(false);
          if (id === 'use' && !disabled) onUse();
          if (id === 'sharing' || id === 'reference') onEdit(id);
          if (id === 'download') {
            const a = document.createElement('a');
            a.href = `/api/v1/files/${file.objectId}/download?name=${encodeURIComponent(file.fileName)}`;
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
              <FileTypeIcon
                kind={classifyFileType(props.file.fileName)}
                size={32}
              />
              <div>
                <p className={css.filename}>{props.file.fileName}</p>
                <small>
                  {props.file.artifact
                    ? `v${props.file.artifact.version} · `
                    : ''}
                  {size(props.file.sizeBytes)}
                </small>
              </div>
            </div>
            {props.mode === 'reference' && (
              <p className={css.hint}>保留当前版本，供后续工作查找使用。</p>
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
                <FileTypeIcon kind={classifyFileType(file.name)} size={32} />
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
