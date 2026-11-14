'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  ReferenceAudienceSchema,
  ReferencePublicationActionSchema,
  ReferencePublishInputSchema,
  ReferenceSaveResultSchema,
  UuidSchema,
  type ReferenceRevision,
  type WorkbenchDeliverable,
} from '@allrice/contracts';
import {
  Button,
  FileTypeIcon,
  IconDownloadOutlineRegular,
  classifyFileType,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { DshDialog } from './dsh-upstream/Dialog';
import { WorkbenchFileIcon } from './workbench-file-icon';
import { workbenchJson } from '../../lib/chatflow/workbench-model';
import css from './reference-publication-dialog.module.css';
import {
  useReferencePublicationOptions,
  type ReferencePublicationOptions,
} from './use-reference-publication-options';

export type ReferencePublicationTarget =
  | { kind: 'file'; file: WorkbenchDeliverable }
  | { kind: 'upload' }
  | {
      kind: 'audience' | 'revoke' | 'delete';
      reference: ReferenceRevision;
    };
type Props = {
  workspaceId: string;
  viewerId: string;
  headers: Record<string, string>;
  options?: ReferencePublicationOptions;
  target: ReferencePublicationTarget;
  onClose: () => void;
  onSaved: (result: { sourceId: string; revisionId?: string }) => void;
};

// Replacing the account, workspace or precise target discards local form state
// and aborts its transport; expected-viewer is a write precondition, not owner.
export function ReferencePublicationDialog(props: Props) {
  const target = props.target;
  const identity =
    target.kind === 'file'
      ? target.file.objectId
      : 'reference' in target
        ? `${target.reference.sourceId}:${target.reference.publication?.audienceRevision}`
        : 'upload';
  return (
    <PublicationForm
      key={`${props.workspaceId}:${props.viewerId}:${target.kind}:${identity}:${JSON.stringify(props.headers)}`}
      {...props}
    />
  );
}

function PublicationForm({
  workspaceId,
  viewerId,
  headers,
  options: suppliedOptions,
  target,
  onClose,
  onSaved,
}: Props) {
  const available = useReferencePublicationOptions({
    workspaceId,
    viewerId,
    headers,
    active: true,
    supplied: suppliedOptions,
  });
  const options = available.options;
  const reference = 'reference' in target ? target.reference : null;
  const publication = reference?.publication;
  const destructive = target.kind === 'revoke' || target.kind === 'delete';
  const [scope, setScope] = useState(publication?.audience.scope ?? 'personal');
  const [departmentIds, setDepartmentIds] = useState<string[]>(
    publication?.audience.departmentIds ?? [],
  );
  const [purpose, setPurpose] = useState('');
  const [upload, setUpload] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const transport = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const requestIds = useRef(new Map<string, string>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      transport.current?.abort();
    };
  }, []);

  const title = {
    file: '添加为企业资料',
    upload: '上传企业资料',
    audience: '修改范围',
    revoke: '撤销这份企业资料？',
    delete: '删除这份企业资料？',
  }[target.kind];
  const confirmation = {
    file: '确认',
    upload: '发布',
    audience: '保存',
    revoke: '撤销资料',
    delete: '删除资料',
  }[target.kind];
  const names = (options?.departments ?? [])
    .filter((department) => departmentIds.includes(department.id))
    .map((department) => department.name);
  const audienceLabel =
    scope === 'personal'
      ? '仅自己'
      : scope === 'company'
        ? '全公司'
        : names.join('、');
  const permitted =
    options?.workspaceId === workspaceId &&
    options.writable &&
    (target.kind === 'file'
      ? target.file.canPublishReference === true
      : target.kind === 'upload'
        ? true
        : reference?.canMaintain === true &&
          publication?.publisherId === viewerId &&
          (target.kind === 'audience' ||
            (target.kind === 'revoke' && publication.origin === 'file') ||
            (target.kind === 'delete' && publication.origin === 'upload')));

  async function save() {
    if (
      !permitted ||
      pending.current ||
      (!destructive && scope === 'departments' && departmentIds.length === 0) ||
      (target.kind === 'upload' && !upload)
    )
      return;
    pending.current = true;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    transport.current = controller;
    try {
      const audience = ReferenceAudienceSchema.parse({
        scope,
        departmentIds: scope === 'departments' ? departmentIds : [],
      });
      let value: Record<string, unknown>;
      let url = '/api/v1/references/publications';
      if (target.kind === 'file') {
        value = {
          workspaceId,
          origin: 'file',
          objectId: target.file.objectId,
          audience,
          purpose,
        };
      } else if (target.kind === 'upload' && upload) {
        const contentBase64 = await fileBase64(upload);
        if (!alive.current || controller.signal.aborted) return;
        value = {
          workspaceId,
          origin: 'upload',
          fileName: upload.name,
          mediaType: upload.type || 'application/octet-stream',
          contentBase64,
          audience,
          purpose,
        };
      } else if (reference && publication) {
        url += '/' + encodeURIComponent(reference.sourceId);
        value = {
          workspaceId,
          expectedRevision: publication.audienceRevision,
          action: target.kind,
          ...(target.kind === 'audience' ? { audience } : {}),
        };
      } else return;

      const schema = reference
        ? ReferencePublicationActionSchema
        : ReferencePublishInputSchema;
      const parsed = schema.parse({ ...value, requestId: crypto.randomUUID() });
      const { requestId: proposed, ...canonical } = parsed;
      // Keep only a compact payload identity between retries, not another full
      // base64 upload for every edit of its purpose or audience.
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(canonical)),
      );
      if (!alive.current || controller.signal.aborted) return;
      const key = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const requestId = requestIds.current.get(key) ?? proposed;
      requestIds.current.set(key, requestId);
      const data = await workbenchJson(url, headers, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-allrice-expected-viewer-id': viewerId,
        },
        body: JSON.stringify({ ...canonical, requestId }),
        signal: controller.signal,
      });
      const saved = reference
        ? z.object({ sourceId: UuidSchema }).strict().parse(data)
        : ReferenceSaveResultSchema.parse(data);
      if (alive.current && !controller.signal.aborted) onSaved(saved);
    } catch (caught) {
      if (alive.current && !controller.signal.aborted) {
        setError(
          reference && caught instanceof Error && 'status' in caught
            ? caught.message
            : '发布未完成，请重试。',
        );
      }
    } finally {
      if (alive.current && !controller.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <DshDialog
      title={title}
      ariaLabel={title}
      onClose={() => {
        if (!pending.current) onClose();
      }}
      closeDisabled={busy}
      className={css.dialog}
      bodyClassName={css.body}
    >
      {destructive && reference ? (
        <>
          <p className={css.description}>
            {reference.fileName} · {audienceLabel}
          </p>
          <ul className={css.destructiveCopy}>
            {target.kind === 'revoke' ? (
              <>
                <li>
                  {scope === 'personal'
                    ? '你'
                    : scope === 'company'
                      ? '公司里所有人'
                      : audienceLabel + '的人'}
                  和 AI 员工都看不到、搜不到它了。
                </li>
                <li>你的交付成果里原文件还在，以后可以再添加。</li>
              </>
            ) : (
              <li>
                这份是直接上传的，交付成果里没有它，删除后谁都看不到了，需要的话先下载。
              </li>
            )}
          </ul>
        </>
      ) : (
        <>
          {target.kind === 'file' && (
            <>
              <p className={css.description}>
                把这个文件复制一份放进企业资料。之后原文件怎么改都不影响它。
              </p>
              <div className={css.file}>
                <FileTypeIcon
                  kind={classifyFileType(target.file.fileName)}
                  size={32}
                />
                <div>
                  <strong>{target.file.fileName}</strong>
                  <span>
                    {new Date(target.file.createdAt).toLocaleString('zh-CN', {
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              </div>
            </>
          )}
          {target.kind === 'upload' && (
            <div
              className={css.dropzone}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (!busy && event.dataTransfer.files[0])
                  setUpload(event.dataTransfer.files[0]);
              }}
            >
              <WorkbenchFileIcon kind="upload" />
              <p>
                拖文件到这里，或{' '}
                <button
                  type="button"
                  disabled={busy}
                  className={css.textLink}
                  onClick={() => fileInput.current?.click()}
                >
                  选择文件
                </button>
              </p>
              {upload && <p className={css.caption}>已选：{upload.name}</p>}
              <input
                ref={fileInput}
                type="file"
                aria-label="选择文件"
                hidden
                disabled={busy}
                onChange={(event) => {
                  setUpload(event.target.files?.[0] ?? null);
                }}
              />
            </div>
          )}
          <fieldset className={css.field} disabled={busy || !permitted}>
            <legend>谁能看到</legend>
            <div className={css.choices}>
              {(['personal', 'departments', 'company'] as const).map(
                (value, index) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="publication-audience"
                      value={value}
                      checked={scope === value}
                      onChange={() => setScope(value)}
                    />
                    {['仅自己', '指定部门', '全公司'][index]}
                  </label>
                ),
              )}
            </div>
          </fieldset>
          {scope === 'departments' && (
            <fieldset className={css.field} disabled={busy || !permitted}>
              <legend>部门（可多选）</legend>
              <div className={css.departments}>
                {(options?.departments ?? []).map((department) => (
                  <label key={department.id}>
                    <input
                      type="checkbox"
                      checked={departmentIds.includes(department.id)}
                      onChange={(event) =>
                        setDepartmentIds((ids) =>
                          event.target.checked
                            ? [...ids, department.id]
                            : ids.filter((id) => id !== department.id),
                        )
                      }
                    />
                    {department.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {target.kind !== 'audience' && (
            <label className={css.field}>
              <span>用途</span>
              <textarea
                value={purpose}
                maxLength={1000}
                disabled={busy || !permitted}
                onChange={(event) => setPurpose(event.target.value)}
                placeholder="例如：每月经营报告的格式参考"
              />
            </label>
          )}
          <p className={css.hint}>
            {scope === 'personal'
              ? '只有你能看到和下载，AI 员工为你工作时也会查到它。'
              : scope === 'company'
                ? '公司里所有人都能看到和下载，AI 员工为他们工作时也会查到它。'
                : names.length
                  ? names.join('、') +
                    '的人都能看到和下载，AI 员工为他们工作时也会查到它。'
                  : '请选择至少一个部门。'}
          </p>
        </>
      )}
      {(error || available.error) && (
        <p role="alert" className={css.error}>
          {error || available.error}
        </p>
      )}
      <footer className={css.actions}>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
          取消
        </Button>
        {target.kind === 'delete' && (
          <a
            className={css.download}
            href={`/api/v1/references/revisions/${encodeURIComponent(target.reference.revisionId)}/download?workspaceId=${encodeURIComponent(workspaceId)}`}
            download
          >
            <IconDownloadOutlineRegular size={18} />
            先下载
          </a>
        )}
        <Button
          type="button"
          variant="primary"
          className={destructive ? css.danger : undefined}
          disabled={
            busy ||
            !permitted ||
            (!destructive &&
              scope === 'departments' &&
              !departmentIds.length) ||
            (target.kind === 'upload' && !upload)
          }
          onClick={() => void save()}
        >
          {confirmation}
        </Button>
      </footer>
    </DshDialog>
  );
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const value = reader.result;
      if (typeof value !== 'string' || !value.includes(','))
        reject(Error('File read failed'));
      else resolve(value.slice(value.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}
