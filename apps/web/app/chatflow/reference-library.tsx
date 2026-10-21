'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  ReferenceRevisionSchema,
  ReferenceLibraryOptionsSchema,
  CompanyAssetSchema,
  type ReferenceRevision,
  type ReferenceUploadInput,
} from '@allrice/contracts';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { DshDialog } from './dsh-upstream/Dialog';
import { NativeDocumentPreview } from './native-document-preview';
import { DocumentToolbar } from './document-reader';
import {
  workbenchJson,
  parseArtifactPreview,
  type ArtifactPreview,
} from '../../lib/chatflow/workbench-model';
import css from './reference-library.module.css';
import {
  CompanyTemplateBrowser,
  CompanyAssetRevisionView,
} from './company-template-browser';
import type { CompanyDraftReference } from './company-template-use';
import { companyAssetUrl } from './company-template-publisher';

const responseSchema = z.object({
  references: z.array(ReferenceRevisionSchema),
  options: ReferenceLibraryOptionsSchema,
});
const scopes = {
  personal: '个人',
  department: '部门',
  company: '公司',
  platform: '平台',
};
const states = {
  uploading: '上传未完成',
  saved: '已保存 · 等待处理',
  processing: '处理中',
  ready: '处理完成',
  failed: '处理失败',
  unsupported: '已保存 · 仅文件',
};
export function ReferenceLibrary({
  workspaceId,
  headers,
  onClose,
  platform = false,
  onSelect,
  initialReference,
  onPrepareTemplate,
  initialTemplates,
  hideUpload = false,
}: {
  hideUpload?: boolean;
  workspaceId: string;
  headers: Record<string, string>;
  onClose: () => void;
  platform?: boolean;
  onSelect?: (reference: ReferenceRevision) => void;
  initialReference?: { sourceId: string; revisionId: string } | null;
  onPrepareTemplate?: (reference: CompanyDraftReference) => Promise<void>;
  initialTemplates?: { employeeId?: string; taskText: string };
}) {
  const [directory, setDirectory] = useState<z.infer<
      typeof responseSchema
    > | null>(null),
    [selected, setSelected] = useState<ReferenceRevision | null>(null);
  const [versions, setVersions] = useState<ReferenceRevision[]>([]),
    [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [error, setError] = useState(''),
    [previewError, setPreviewError] = useState(''),
    [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<ReferenceUploadInput['scope']>(
      platform ? 'platform' : 'personal',
    ),
    [department, setDepartment] = useState(''),
    [purpose, setPurpose] = useState(''),
    [query, setQuery] = useState('');
  const [updating, setUpdating] = useState<ReferenceRevision | null>(null),
    [file, setFile] = useState<File | null>(null);
  const [legacyDirectory, setLegacyDirectory] = useState(!!initialTemplates);
  const previewSection = useRef<HTMLElement>(null),
    focusPreview = useRef(false);
  useEffect(() => {
    if (!selected || !focusPreview.current) return;
    focusPreview.current = false;
    previewSection.current?.focus({ preventScroll: true });
    previewSection.current?.scrollIntoView({ block: 'start' });
  }, [selected]);
  const pending = useRef<ReferenceUploadInput | null>(null),
    actions = useRef(
      new Map<
        string,
        {
          workspaceId: string;
          requestId: string;
          expectedRevision: number;
          action: 'retry' | 'archive' | 'restore';
        }
      >(),
    ),
    request = useRef<AbortController | null>(null),
    fileInput = useRef<HTMLInputElement>(null);
  const base = '/api/v1/references',
    q = '?workspaceId=' + encodeURIComponent(workspaceId);
  const reload = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const value = responseSchema.parse(
        await workbenchJson(base + q, headers, { signal: controller.signal }),
      );
      if (!controller.signal.aborted) {
        setDirectory(value);
        setError('');
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setDirectory(null);
        setSelected(null);
        setError(e instanceof Error ? e.message : '资料读取失败');
      }
    }
  }, [q, headers]);
  useEffect(() => {
    void reload();
    return () => request.current?.abort();
  }, [reload]);
  useEffect(() => {
    if (
      !directory?.references.some(
        (r) => r.processing === 'saved' || r.processing === 'processing',
      )
    )
      return;
    const timer = setTimeout(() => void reload(), 1500);
    return () => clearTimeout(timer);
  }, [directory, reload]);
  const previewBase = selected
    ? `${base}/revisions/${selected.revisionId}`
    : '';
  useEffect(() => {
    setPreview(null);
    setPreviewError('');
    if (!selected || selected.status === 'archived' || selected.companyTemplate)
      return;
    const controller = new AbortController();
    void workbenchJson(previewBase + '/preview' + q, headers, {
      signal: controller.signal,
    })
      .then(parseArtifactPreview)
      .then((value) => {
        if (!controller.signal.aborted) setPreview(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setPreviewError(e instanceof Error ? e.message : '预览失败');
      });
    return () => controller.abort();
  }, [previewBase, q, headers, selected]);
  const initialSourceId = initialReference?.sourceId,
    initialRevisionId = initialReference?.revisionId;
  useEffect(() => {
    if (!initialSourceId || !initialRevisionId) return;
    const controller = new AbortController();
    void workbenchJson(base + q + '&sourceId=' + initialSourceId, headers, {
      signal: controller.signal,
    })
      .then(responseSchema.parse)
      .then((value) => {
        if (controller.signal.aborted) return;
        setVersions(value.references);
        const revision = value.references.find(
          (r) => r.revisionId === initialRevisionId,
        );
        focusPreview.current = true;
        setSelected(revision ?? null);
        if (!revision) setError('该资料版本已不可用。');
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : '资料不可用');
      });
    return () => controller.abort();
  }, [initialSourceId, initialRevisionId, q, headers]);
  async function open(r: ReferenceRevision, focus = true) {
    setPreview(null);
    setSelected(null);
    setVersions([]);
    try {
      const value = responseSchema.parse(
        await workbenchJson(base + q + '&sourceId=' + r.sourceId, headers),
      );
      setVersions(value.references);
      focusPreview.current = focus;
      setSelected(
        value.references.find((v) => v.revisionId === r.revisionId) ?? null,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '资料不可用');
    }
  }
  function reset() {
    pending.current = null;
    setFile(null);
    setUpdating(null);
    setPurpose('');
    if (fileInput.current) fileInput.current.value = '';
  }
  async function upload() {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    try {
      if (!pending.current) {
        const contentBase64 = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onerror = () => reject(Error('文件读取失败'));
          r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
          r.readAsDataURL(file);
        });
        pending.current = {
          workspaceId,
          requestId: crypto.randomUUID(),
          ...(updating
            ? {
                sourceId: updating.sourceId,
                expectedRevision: updating.revision,
              }
            : {}),
          scope,
          ...(scope === 'department' ? { departmentId: department } : {}),
          fileName: file.name,
          purpose,
          mediaType:
            file.type ||
            (/\.md$/i.test(file.name)
              ? 'text/markdown'
              : /\.txt$/i.test(file.name)
                ? 'text/plain'
                : 'application/octet-stream'),
          contentBase64,
        };
      }
      // Preserve this exact request for an uncertain response. Server reconciles
      // the request before writing or consuming another quota allocation.
      await workbenchJson(base, headers, {
        method: 'POST',
        body: JSON.stringify(pending.current),
      });
      reset();
      await reload();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : '保存失败，请重试；同一次保存不会生成重复资料。',
      );
    } finally {
      setBusy(false);
    }
  }
  async function action(
    r: ReferenceRevision,
    action: 'retry' | 'archive' | 'restore',
  ) {
    const key = r.sourceId + ':' + r.revision + ':' + action;
    const input = actions.current.get(key) ?? {
      workspaceId,
      requestId: crypto.randomUUID(),
      expectedRevision: r.revision,
      action,
    };
    actions.current.set(key, input);
    setBusy(true);
    try {
      await workbenchJson(base + '/' + r.sourceId, headers, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      actions.current.delete(key);
      setSelected(null);
      setPreview(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  const options = directory?.options,
    latest =
      selected &&
      directory?.references.find((r) => r.sourceId === selected.sourceId);
  if (legacyDirectory)
    return (
      <CompanyTemplateBrowser
        open
        title={initialTemplates ? '参考资料' : '历史资料与草稿'}
        recommended={!!initialTemplates}
        employeeId={initialTemplates?.employeeId}
        taskText={initialTemplates?.taskText}
        workspaceId={workspaceId}
        headers={headers}
        onPrepare={onPrepareTemplate}
        onClose={() => {
          setLegacyDirectory(false);
          setSelected(null);
          void reload();
        }}
      />
    );
  return (
    <DshDialog
      title="参考资料"
      ariaLabel="参考资料"
      onClose={onClose}
      bodyClassName={css.body}
    >
      <p className={css.hint}>
        保存可重复使用的资料。普通聊天附件不会自动分享到这里。
      </p>
      {error && (
        <p role="alert" className={css.error}>
          {error}
        </p>
      )}
      <div className={css.toolbar}>
        <input
          aria-label="查找参考资料"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="查找资料"
        />
        <Button
          onClick={() => {
            setSelected(null);
            void reload();
          }}
        >
          刷新
        </Button>
        {!platform && (
          <Button onClick={() => setLegacyDirectory(true)}>
            历史资料与草稿
          </Button>
        )}
      </div>
      {selected && (
        <section
          ref={previewSection}
          tabIndex={-1}
          className={css.preview}
          aria-label="参考资料预览"
        >
          {selected.companyTemplate ? (
            <LegacyReferenceDetails
              key={selected.revisionId}
              reference={selected}
              workspaceId={workspaceId}
              headers={headers}
              onPrepare={onPrepareTemplate}
              onChange={() => void reload()}
            />
          ) : (
            <>
              <DocumentToolbar
                title={selected.fileName}
                downloadUrl={previewBase + '/download' + q}
                actions={[{ id: 'refresh', label: '刷新预览' }]}
                onAction={() => void open(selected, false)}
              >
                <select
                  aria-label="参考资料版本"
                  value={selected.revisionId}
                  onChange={(e) =>
                    setSelected(
                      versions.find((v) => v.revisionId === e.target.value) ??
                        null,
                    )
                  }
                >
                  {versions.map((v) => (
                    <option value={v.revisionId} key={v.revisionId}>
                      v{v.revision}
                    </option>
                  ))}
                </select>
              </DocumentToolbar>
              {onSelect && (
                <Button
                  disabled={
                    busy ||
                    selected.status !== 'active' ||
                    selected.processing !== 'ready'
                  }
                  onClick={() => onSelect(selected)}
                >
                  引用当前版本 v{selected.revision}
                </Button>
              )}
              {selected.status === 'archived' ? (
                <p>资料已停用，恢复后可查看。</p>
              ) : previewError ? (
                <p role="alert">{previewError}</p>
              ) : preview ? (
                <NativeDocumentPreview
                  preview={preview}
                  fileName={selected.fileName}
                  pageUrl={previewBase + '/preview' + q}
                  headers={headers}
                />
              ) : (
                <p>正在加载预览…</p>
              )}
              {latest && (
                <p className={css.hint}>
                  当前查看固定版本 v{selected.revision}；最新为 v
                  {latest.revision}。
                </p>
              )}
            </>
          )}
        </section>
      )}
      {options?.writable && !hideUpload && (
        <fieldset disabled={busy} className={css.upload}>
          <legend>{updating ? '更新参考资料' : '上传参考资料'}</legend>
          <label>
            保存范围
            <select
              aria-label="资料保存范围"
              value={scope}
              disabled={!!updating}
              onChange={(e) => {
                setScope(e.target.value as typeof scope);
                pending.current = null;
                setDepartment(
                  options.departmentId ?? options.departments[0]?.id ?? '',
                );
              }}
            >
              {platform && options.platformMaintainer ? (
                <option value="platform">平台</option>
              ) : (
                <>
                  <option value="personal">个人</option>
                  {options.maintenanceLevel !== 'personal' &&
                    options.departments.length > 0 && (
                      <option value="department">部门</option>
                    )}
                  {options.maintenanceLevel === 'company' && (
                    <option value="company">公司</option>
                  )}
                </>
              )}
            </select>
          </label>
          {scope === 'department' && (
            <label>
              部门
              <select
                aria-label="资料所属部门"
                value={department}
                disabled={!!updating}
                onChange={(e) => {
                  setDepartment(e.target.value);
                  pending.current = null;
                }}
              >
                <option value="">选择部门</option>
                {options.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            用途（选填）
            <input
              value={purpose}
              maxLength={1000}
              onChange={(e) => {
                setPurpose(e.target.value);
                pending.current = null;
              }}
            />
          </label>
          <input
            ref={fileInput}
            type="file"
            aria-label="上传参考文件"
            onChange={(e) => {
              const next = e.target.files?.[0] ?? null;
              pending.current = null;
              if (next && next.size > 50 * 1024 * 1024) {
                setFile(null);
                setError('文件超过 50 MiB。');
              } else setFile(next);
            }}
          />
          <div>
            <Button
              disabled={!file || (scope === 'department' && !department)}
              onClick={() => void upload()}
            >
              {busy ? '保存中…' : '保存资料'}
            </Button>
            {updating && <Button onClick={reset}>取消更新</Button>}
          </div>
        </fieldset>
      )}
      <div className={css.list} aria-label="资料列表">
        {directory?.references
          .filter((r) => (r.fileName + ' ' + r.purpose).includes(query))
          .map((r) => (
            <div className={css.item} key={r.sourceId}>
              <button className={css.name} onClick={() => void open(r)}>
                {r.fileName}
              </button>
              <span>
                {scopes[r.ownership.scope]} · v{r.revision} ·{' '}
                {r.status === 'archived' ? '已停用' : states[r.processing]}
              </span>
              <p>{r.purpose}</p>
              {r.origin && (
                <p className={css.hint}>
                  来自成果 {r.origin.fileName} · v{r.origin.version}
                </p>
              )}
              {r.failure && <p className={css.hint}>{r.failure}</p>}
              {r.companyTemplate && (
                <Button onClick={() => void open(r)}>填写参数与选用</Button>
              )}
              {r.companyTemplate &&
                r.canRetryProcessing &&
                (r.processing === 'failed' ||
                  r.processing === 'unsupported') && (
                  <Button
                    disabled={busy}
                    onClick={() => void action(r, 'retry')}
                  >
                    重试处理
                  </Button>
                )}
              {onSelect && !r.companyTemplate && (
                <Button
                  disabled={
                    busy || r.status !== 'active' || r.processing !== 'ready'
                  }
                  onClick={() => onSelect(r)}
                >
                  引用 v{r.revision}
                </Button>
              )}
              {r.canMaintain && (
                <div className={css.actions}>
                  {r.status === 'active' && (
                    <>
                      <Button
                        disabled={busy}
                        onClick={() => {
                          reset();
                          setUpdating(r);
                          setScope(r.ownership.scope as typeof scope);
                          setDepartment(
                            r.ownership.scope === 'department'
                              ? r.ownership.departmentId
                              : '',
                          );
                          setPurpose(r.purpose);
                          fileInput.current?.focus();
                        }}
                      >
                        更新文件
                      </Button>
                      {(r.processing === 'failed' ||
                        (r.processing === 'unsupported' &&
                          r.canRetryProcessing)) && (
                        <Button
                          disabled={busy}
                          onClick={() => void action(r, 'retry')}
                        >
                          重试处理
                        </Button>
                      )}
                    </>
                  )}
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void action(
                        r,
                        r.status === 'active' ? 'archive' : 'restore',
                      )
                    }
                  >
                    {r.status === 'active' ? '停用' : '恢复'}
                  </Button>
                </div>
              )}
            </div>
          ))}
      </div>
      {directory?.references.length === 0 && (
        <p className={css.hint}>还没有可查看的参考资料。</p>
      )}
    </DshDialog>
  );
}

/** Reuse the existing publication, fixed-version file and parameter workflow.
 * Knowledge processing support does not gate a published Office template. */
function LegacyReferenceDetails({
  reference,
  workspaceId,
  headers,
  onPrepare,
  onChange,
}: {
  reference: ReferenceRevision;
  workspaceId: string;
  headers: Record<string, string>;
  onPrepare?: (reference: CompanyDraftReference) => Promise<void>;
  onChange: () => void;
}) {
  const [asset, setAsset] = useState<z.infer<typeof CompanyAssetSchema> | null>(
    null,
  );
  const [error, setError] = useState('');
  const base = companyAssetUrl('/api/v1/company-assets', { workspaceId });
  const identity = reference.companyTemplate!;
  useEffect(() => {
    const controller = new AbortController();
    void workbenchJson(
      companyAssetUrl(base, {
        assetId: identity.assetId,
        history: '1',
        revisionId: identity.revisionId,
      }),
      headers,
      { signal: controller.signal },
    )
      .then(z.object({ asset: CompanyAssetSchema }).parse)
      .then((value) => {
        if (!controller.signal.aborted) setAsset(value.asset);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : '资料不可用');
      });
    return () => controller.abort();
  }, [base, headers, identity.assetId]);
  if (error) return <p role="alert">{error}</p>;
  if (!asset) return <p>正在读取资料…</p>;
  return (
    <CompanyAssetRevisionView
      initial={asset}
      initialRevisionId={identity.revisionId}
      base={base}
      headers={headers}
      onPrepare={onPrepare}
      onChange={onChange}
    />
  );
}
