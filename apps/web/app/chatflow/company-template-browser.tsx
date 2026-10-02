'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { z } from 'zod';
import {
  CompanyAssetSchema,
  CompanyAssetRevisionSchema,
  UuidSchema,
  type CompanyAsset,
  type CompanyAssetRevision,
} from '@allrice/contracts';
import { DshDialog } from './dsh-upstream/Dialog';
import { NativeDocumentPreview } from './native-document-preview';
import { FontNotice } from './dsh-upstream/document/office/FontNotice';
import { zh as officeZh } from './dsh-upstream/document/office/locales';
import {
  parseArtifactPreview,
  type ArtifactPreview,
} from '../../lib/chatflow/workbench-model';
import {
  CompanyAssetStateActions,
  CompanyTemplateEditor,
  companyAssetJson,
  companyAssetStateLabels,
  companyAssetUrl,
  useCompanyAssetDirectory,
} from './company-template-publisher';
import styles from './company-template-browser.module.css';

const historySchema = z.object({
  asset: CompanyAssetSchema,
  revisions: z.array(CompanyAssetRevisionSchema),
  publishedRevisionIds: z.array(UuidSchema).optional(),
});
export function companyRevisionReadable(
  asset: CompanyAsset,
  revision: CompanyAssetRevision,
  publishedRevisionIds: readonly string[],
) {
  return (
    asset.state === 'published' &&
    !!revision.file &&
    publishedRevisionIds.includes(revision.id)
  );
}

/** A fixed revision and the existing native preview, including its source paging. */
export function CompanyAssetRevisionView({
  initial,
  base,
  headers,
  onChange,
}: {
  initial: CompanyAsset;
  base: string;
  headers: Record<string, string>;
  onChange?: (asset: CompanyAsset) => void;
}) {
  const [history, setHistory] = useState<z.infer<typeof historySchema> | null>(
    null,
  );
  const [selectedId, setSelectedId] = useState(
    initial.publishedRevisionId ?? initial.latest.id,
  );
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const request = useRef<AbortController | null>(null);
  const asset = history?.asset ?? initial;
  const revisions = history?.revisions ?? [initial.latest];
  const selected = revisions.find((r) => r.id === selectedId);
  const publications =
    history?.publishedRevisionIds ??
    (asset.publishedRevisionId ? [asset.publishedRevisionId] : []);
  const readable = selected
    ? companyRevisionReadable(asset, selected, publications)
    : false;
  async function refresh() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    // A refresh rechecks access. The selected immutable revision is retained.
    setPreview(null);
    try {
      const result = historySchema.parse(
        await companyAssetJson(
          companyAssetUrl(base, { assetId: initial.id, history: '1' }),
          headers,
          { signal: controller.signal },
        ),
      );
      if (controller.signal.aborted) return;
      if (result.asset.id !== initial.id)
        throw Error('范本来源已变化，请重新打开。');
      setHistory(result);
      onChange?.(result.asset);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setHistory(null);
        setError(cause instanceof Error ? cause.message : '修订记录读取失败');
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
    // Parent keys the view by directory identity and asset, preserving selection.
  }, []);
  const previewUrl = selected
    ? companyAssetUrl(base, {
        assetId: asset.id,
        revisionId: selected.id,
        preview: '1',
      })
    : '';
  useEffect(() => {
    setPreview(null);
    setPreviewError('');
    if (!readable || !selected || error || loading) return;
    const controller = new AbortController();
    void companyAssetJson(previewUrl, headers, { signal: controller.signal })
      .then(parseArtifactPreview)
      .then((value) => {
        if (!controller.signal.aborted) setPreview(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setPreviewError(
            cause instanceof Error ? cause.message : '预览读取失败',
          );
      });
    return () => controller.abort();
  }, [previewUrl, headers, readable, selected, error, loading]);
  if (
    editing &&
    asset.canEdit &&
    asset.kind === 'template' &&
    asset.latest.content.sourceVersionId
  ) {
    return (
      <div className={styles.detail}>
        <Button
          onClick={() => {
            setEditing(false);
            void refresh();
          }}
        >
          返回固定修订
        </Button>
        <CompanyTemplateEditor
          base={base}
          headers={headers}
          initial={asset}
          versionId={asset.latest.content.sourceVersionId}
          fileName={asset.latest.file?.fileName ?? asset.latest.content.title}
          onSaved={(next) => {
            setHistory((h) => (h ? { ...h, asset: next } : null));
            onChange?.(next);
          }}
        />
      </div>
    );
  }
  return (
    <section className={styles.detail} aria-label="公司资料固定修订">
      <div className={styles.actions}>
        <Button disabled={loading} onClick={() => void refresh()}>
          刷新状态与修订
        </Button>
        {asset.canEdit &&
          asset.kind === 'template' &&
          asset.state !== 'archived' && (
            <Button
              disabled={loading || !!error}
              onClick={() => setEditing(true)}
            >
              编辑范本草稿
            </Button>
          )}
      </div>
      <p>
        {companyAssetStateLabels[asset.state]} · {asset.ownerName}
        {asset.canEdit &&
        asset.publishedRevisionId !== asset.latest.id &&
        asset.publishedRevisionId
          ? ' · 最新草稿与共享版分开保存'
          : ''}
      </p>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">正在读取修订…</p>}
      {!error && (
        <>
          <label>
            固定修订
            <select
              aria-label="公司资料修订"
              value={selectedId}
              disabled={loading}
              onChange={(e) => {
                setPreview(null);
                setSelectedId(e.target.value);
              }}
            >
              {!selected && (
                <option value={selectedId}>所选修订不在当前可读历史中</option>
              )}
              {revisions.map((r) => (
                <option key={r.id} value={r.id}>
                  v{r.number} · {r.content.title}
                  {r.id === asset.publishedRevisionId
                    ? ' · 当前共享版'
                    : publications.includes(r.id)
                      ? ' · 曾共享'
                      : ' · 草稿'}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <>
              <h4>{selected.content.title}</h4>
              <p className={styles.text}>{selected.content.body}</p>
              {selected.content.category && (
                <p>分类：{selected.content.category}</p>
              )}
              {selected.content.taskKeywords.length > 0 && (
                <p>适用任务：{selected.content.taskKeywords.join('、')}</p>
              )}
              {selected.content.slots.length > 0 && (
                <div>
                  <strong>使用时所需填写项</strong>
                  <ul>
                    {selected.content.slots.map((slot) => (
                      <li key={slot.key}>
                        {slot.label}
                        {slot.required ? '（必填）' : '（可选）'}
                        {slot.multiline ? ' · 多行' : ''}
                      </li>
                    ))}
                  </ul>
                  <p>本期仅查看和管理范本，不会自动填写草稿或启动工作。</p>
                </div>
              )}
              {selected.file && (
                <>
                  <p>
                    原件：{selected.file.fileName} ·{' '}
                    {(selected.file.sizeBytes / 1024).toFixed(1)} KB
                  </p>
                  {readable && !loading && (
                    <a
                      href={companyAssetUrl(base, {
                        assetId: asset.id,
                        revisionId: selected.id,
                        download: '1',
                      })}
                    >
                      下载此修订原文件
                    </a>
                  )}
                  {!readable && (
                    <p>
                      {asset.state !== 'published'
                        ? '已暂停、撤回或尚未共享，不能新读取预览或下载。'
                        : '此修订尚未共享；草稿保存不会自动开放文件读取。'}
                    </p>
                  )}
                  {previewError && <p role="alert">{previewError}</p>}
                  {readable && !loading && !preview && !previewError && (
                    <p role="status">正在读取固定版本预览…</p>
                  )}
                  {preview && (
                    <>
                      <FontNotice
                        key={selected.id}
                        fonts={
                          preview.kind === 'pdf'
                            ? (preview.missingFonts ?? [])
                            : []
                        }
                        t={(key, params) =>
                          Object.entries(params ?? {}).reduce(
                            (text, [name, value]) =>
                              text.replaceAll(`{${name}}`, String(value)),
                            officeZh[key] as string,
                          )
                        }
                      />
                      <div className={styles.preview}>
                        <NativeDocumentPreview
                          key={selected.id}
                          preview={preview}
                          fileName={selected.file.fileName}
                          pageUrl={previewUrl}
                          headers={headers}
                        />
                      </div>
                    </>
                  )}
                </>
              )}
            </>
          )}
          <CompanyAssetStateActions
            asset={asset}
            base={base}
            headers={headers}
            blocked={loading}
            onChange={(next) => {
              setPreview(null);
              setHistory((h) => (h ? { ...h, asset: next } : null));
              onChange?.(next);
              void refresh();
            }}
          />
        </>
      )}
    </section>
  );
}

export function CompanyTemplateBrowser(props: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  headers: Record<string, string>;
}) {
  if (!props.open) return null;
  return (
    <Browser
      key={JSON.stringify([props.workspaceId, props.headers])}
      {...props}
    />
  );
}
function Browser({
  onClose,
  workspaceId,
  headers,
}: Parameters<typeof CompanyTemplateBrowser>[0]) {
  const base = companyAssetUrl('/api/v1/company-assets', { workspaceId });
  const directory = useCompanyAssetDirectory(base, headers);
  const [selected, setSelected] = useState<CompanyAsset | null>(null);
  const templates =
    directory.data?.assets.filter((a) => a.kind === 'template') ?? [];
  return (
    <DshDialog
      ariaLabel="公司范本"
      title="公司范本"
      onClose={onClose}
      className={styles.dialog}
      bodyClassName={styles.body}
    >
      <p>
        查看公司已共享的固定修订，或管理本人范本。保存草稿不等于共享；这里不会自动启动工作。
      </p>
      <Button
        disabled={directory.loading}
        onClick={() => {
          setSelected(null);
          void directory.load();
        }}
      >
        刷新范本目录
      </Button>
      {directory.error && <p role="alert">{directory.error}</p>}
      {directory.loading && <p role="status">正在读取范本目录…</p>}
      <div className={styles.layout}>
        <div className={styles.list} aria-label="公司范本目录">
          {templates.map((asset) => (
            <article key={asset.id} className={styles.item}>
              <strong>{asset.latest.content.title}</strong>
              <small>
                {companyAssetStateLabels[asset.state]} · {asset.ownerName}
              </small>
              <small>
                所示修订 v{asset.latest.number}
                {asset.canEdit &&
                asset.publishedRevisionId &&
                asset.publishedRevisionId !== asset.latest.id
                  ? ' · 本人最新草稿'
                  : ''}
              </small>
              <Button onClick={() => setSelected(asset)}>查看范本</Button>
            </article>
          ))}
          {!directory.loading && directory.data && !templates.length && (
            <p>
              当前没有可查看的公司范本。可从自己的成果卡选择具体版本，保存后再发布。
            </p>
          )}
          {directory.data?.nextCursor && (
            <Button
              disabled={directory.loading}
              onClick={() => void directory.load(true)}
            >
              更多公司资料
            </Button>
          )}
        </div>
        {selected && !directory.error ? (
          <CompanyAssetRevisionView
            key={selected.id}
            initial={selected}
            base={base}
            headers={headers}
            onChange={(next) => setSelected(next)}
          />
        ) : (
          <p>选择一项范本查看用途、历史修订和原文件。</p>
        )}
      </div>
    </DshDialog>
  );
}
