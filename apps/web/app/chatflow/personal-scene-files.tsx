'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  PersonalSceneFileSchema,
  PersonalSceneFilePreviewSchema,
  PersonalSceneFileHistorySchema,
  PersonalSceneSkillSaveReceiptSchema,
  SavePersonalSceneSkillSchema,
  PersonalSceneRestorePreviewSchema,
  RestorePersonalSceneFileSchema,
  type PersonalSceneFile,
  type PersonalSceneFileHistory,
  type PersonalSceneFilePreview,
  type EmployeeContentReference,
  type SavePersonalSceneSkill,
  type RestorePersonalSceneFile,
  type PersonalSceneRestorePreview,
} from '@allrice/contracts';
import css from './personal-scene-files.module.css';

type Props = {
  scopeId: string;
  instanceId: string;
  workspaceId: string;
  headers: Record<string, string>;
  writes: PersonalSceneFileWriteStore;
};
type Receipt = ReturnType<typeof PersonalSceneSkillSaveReceiptSchema.parse> & {
  requestId: string;
};
type PendingWrite = SavePersonalSceneSkill | RestorePersonalSceneFile;
/** Owned by the existing employee-details dialog, never global or persistent.
 * Only a matching viewer/workspace/instance may recover a pending request. */
export type PersonalSceneFileWriteStore = Map<
  string,
  {
    input?: PendingWrite;
    receipt?: Receipt;
  }
>;
const writeKey = (props: Props) =>
  JSON.stringify([props.scopeId, props.workspaceId, props.instanceId]);

export class PersonalSceneHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(
      status === 401
        ? '登录已失效，请重新登录。'
        : status === 403 || status === 404
          ? '当前内容不可访问，可能已撤销或权限已变更。'
          : status === 409
            ? '内容或请求已有变化。请重新预览当前目标，再核对差异。'
            : status === 400
              ? '文件格式或内容校验未通过，请重新打包后导入。'
              : '服务暂不可用，请核对当前内容后重试。',
    );
  }
}

export async function personalSceneJson(
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
  if (!response.ok)
    throw new PersonalSceneHttpError(
      response.status,
      typeof body?.error?.code === 'string' ? body.error.code : 'UNKNOWN',
    );
  return body;
}

const referenceKey = (ref: EmployeeContentReference) =>
  `${ref.sourceKind} / ${ref.contentId} / ${ref.revisionId} / ${ref.digest}`;

export function PersonalSceneFileDiff({
  preview,
}: {
  preview: PersonalSceneFilePreview;
}) {
  if (!('skillPackage' in preview.file.procedure)) return null;
  const procedure = preview.file.procedure;
  const bundle = procedure.skillPackage.bundle;
  const paths = [
    ...new Set([
      ...(preview.current?.resources.map((resource) => resource.path) ?? []),
      ...bundle.resources.map((resource) => resource.path),
    ]),
  ];
  return (
    <section className={css.diff} aria-label="文件与当前内容差异">
      <p>
        <strong>
          保存到：{preview.instanceName} → {preview.file.scene.name}
        </strong>
        {' · '}
        {preview.currentScene ? '更新这个场景' : '新增场景'}
      </p>
      <p className={css.hint}>
        仅本人、这位员工可用。其他场景保持原样；保存成功后即生效。
      </p>
      <dl className={css.facts}>
        <div>
          <dt>当前修订</dt>
          <dd>{preview.expectedRevision || '尚未保存'}</dd>
        </div>
        <div>
          <dt>文件版本</dt>
          <dd>{bundle.version}</dd>
        </div>
        <div>
          <dt>方法标题</dt>
          <dd>
            {preview.currentMetadata?.title ??
              (preview.expectedContentRef ? '不可读取' : '无')}{' '}
            → {preview.file.procedure.title}
          </dd>
        </div>
        <div>
          <dt>场景名称</dt>
          <dd>
            {preview.currentScene?.name ?? '无'} → {preview.file.scene.name}
          </dd>
        </div>
        <div>
          <dt>使用说明</dt>
          <dd>
            {preview.currentScene?.appliesWhen ?? '无'} →{' '}
            {preview.file.scene.appliesWhen}
          </dd>
        </div>
      </dl>
      <div className={css.columns}>
        <section aria-label="当前正文">
          <h5>当前正文</h5>
          <pre>
            {preview.current?.content ??
              (preview.expectedContentRef
                ? '当前正文不可读，可能已撤销。可用新文件准确替换这个包。'
                : '尚无 Workflow 包。')}
          </pre>
        </section>
        <section aria-label="文件正文">
          <h5>将保存的正文</h5>
          <pre>{preview.file.procedure.body}</pre>
        </section>
      </div>
      <details>
        <summary>资源差异（{paths.length} 个路径）</summary>
        {paths.map((path) => {
          const before = preview.current?.resources.find(
            (resource) => resource.path === path,
          );
          const after = bundle.resources.find(
            (resource) => resource.path === path,
          );
          return (
            <div className={css.resource} key={path}>
              <strong>{path}</strong>
              <span>
                {!after
                  ? '移除'
                  : !before
                    ? preview.expectedContentRef && !preview.current
                      ? '文件资源'
                      : '新增'
                    : before.checksum === after.checksum &&
                        before.mediaType === after.mediaType
                      ? '保持'
                      : '更新'}
              </span>
              <code>
                当前：
                {before
                  ? `${before.byteLength} bytes · ${before.mediaType} · ${before.checksum}`
                  : preview.expectedContentRef && !preview.current
                    ? '不可读取'
                    : '无'}
              </code>
              <code>
                文件：
                {after
                  ? `${after.byteLength} bytes · ${after.mediaType} · ${after.checksum}`
                  : '无'}
              </code>
            </div>
          );
        })}
        {!paths.length && <p className={css.hint}>没有固定资源。</p>}
      </details>
      <details>
        <summary>包元数据与资源来源映射差异</summary>
        <p className={css.hint}>
          工具依赖声明不授予工具权限；脚本保持为资源字节。
        </p>
        <div className={css.columns}>
          <section>
            <h5>当前元数据</h5>
            <pre>
              {preview.currentMetadata
                ? JSON.stringify(preview.currentMetadata, null, 2)
                : preview.expectedContentRef
                  ? '当前元数据不可读，无法比较旧值。'
                  : '无'}
            </pre>
          </section>
          <section>
            <h5>文件元数据</h5>
            <pre>
              {JSON.stringify(
                {
                  title: preview.file.procedure.title,
                  bundle: {
                    schemaVersion: bundle.schemaVersion,
                    version: bundle.version,
                    sourceRef: bundle.sourceRef,
                    license: bundle.license,
                    reviewedBy: bundle.reviewedBy,
                    dependencies: bundle.dependencies,
                    contentChecksum: bundle.contentChecksum,
                    checksum: bundle.checksum,
                  },
                  resourceSources: procedure.skillPackage.resourceSources,
                },
                null,
                2,
              )}
            </pre>
          </section>
        </div>
      </details>
      <details>
        <summary>来源与准确版本</summary>
        <p className={css.hint}>
          {'restoreContentRef' in preview
            ? '将恢复以下历史内容；保存时会再次检查是否仍可用。'
            : '只保存文件声明的来源；服务端会重新核验当前权限。'}
        </p>
        <div className={css.columns}>
          <section>
            <h5>当前引用</h5>
            <pre>
              {preview.currentScene?.references.map(referenceKey).join('\n') ||
                '无'}
            </pre>
          </section>
          <section>
            <h5>文件引用</h5>
            <pre>
              {preview.file.references.map(referenceKey).join('\n') || '无'}
            </pre>
          </section>
        </div>
        <code>当前内容：{preview.expectedContentRef ?? '无'}</code>
        <code>正文：{bundle.contentChecksum}</code>
        <code>完整包：{bundle.checksum}</code>
      </details>
    </section>
  );
}

/** Viewer/instance changes remount all private state before the first frame. */
export function PersonalSceneFilePanel(props: Props) {
  return <FilePanel key={writeKey(props)} {...props} />;
}

function FilePanel(props: Props) {
  const key = writeKey(props);
  const recovered = props.writes.get(key);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<PersonalSceneFile | null>(null);
  const [preview, setPreview] = useState<
    PersonalSceneFilePreview | PersonalSceneRestorePreview | null
  >(null);
  const [restoreRef, setRestoreRef] = useState<string | null>(
    recovered?.input && 'restoreContentRef' in recovered.input
      ? recovered.input.restoreContentRef
      : null,
  );
  const [history, setHistory] = useState<PersonalSceneFileHistory | null>(null);
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(Boolean(recovered?.input));
  const [receipt, setReceipt] = useState<Receipt | null>(
    recovered?.receipt ?? null,
  );
  const pending = useRef<PendingWrite | null>(recovered?.input ?? null);
  const reading = useRef<AbortController | null>(null);
  const historyReading = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const base = `/api/v1/employee-instances/${encodeURIComponent(props.instanceId)}/scene-skills`;
  const historyUrl = `${base}/files?workspaceId=${encodeURIComponent(props.workspaceId)}`;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reading.current?.abort();
      historyReading.current?.abort();
    };
  }, []);

  async function loadHistory(beforeRevision?: number) {
    historyReading.current?.abort();
    const controller = new AbortController();
    historyReading.current = controller;
    setHistoryError('');
    try {
      const next = PersonalSceneFileHistorySchema.parse(
        await personalSceneJson(
          `${historyUrl}${beforeRevision ? `&beforeRevision=${beforeRevision}` : ''}`,
          props.headers,
          { signal: controller.signal },
        ),
      );
      if (next.instanceId !== props.instanceId) throw Error('target_changed');
      if (!controller.signal.aborted && mounted.current)
        setHistory((previous) =>
          beforeRevision && previous
            ? { ...next, entries: [...previous.entries, ...next.entries] }
            : next,
        );
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) {
        // Drop an old successful read when its current authorization failed.
        setHistory(null);
        setHistoryError(
          cause instanceof PersonalSceneHttpError
            ? cause.message
            : '修改记录暂时无法读取，请重新读取。',
        );
      }
    }
  }

  async function prepare(nextFile: PersonalSceneFile) {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    setBusy(true);
    setError('');
    setPreview(null);
    setReceipt(null);
    try {
      const next = PersonalSceneFilePreviewSchema.parse(
        await personalSceneJson(`${base}/files`, props.headers, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId: props.workspaceId,
            file: nextFile,
          }),
        }),
      );
      if (
        next.instanceId !== props.instanceId ||
        next.file.scene.id !== nextFile.scene.id
      )
        throw Error('target_changed');
      if (!controller.signal.aborted && mounted.current) setPreview(next);
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current)
        setError(
          cause instanceof PersonalSceneHttpError
            ? cause.message
            : '文件预览失败，请重新读取。',
        );
    } finally {
      if (!controller.signal.aborted && mounted.current) setBusy(false);
    }
  }

  async function upload(input: HTMLInputElement) {
    const selected = input.files?.[0];
    if (!selected || busy || uncertain) return;
    pending.current = null;
    props.writes.delete(key);
    setFile(null);
    setRestoreRef(null);
    setPreview(null);
    setReceipt(null);
    setError('');
    setBusy(true);
    try {
      const next = PersonalSceneFileSchema.parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            await selected.arrayBuffer(),
          ),
        ),
      );
      if (!mounted.current) return;
      setFile(next);
      setSummary(`导入 ${next.scene.name} Workflow 文件`);
      await prepare(next);
    } catch {
      if (mounted.current)
        setError(
          '请选择 Workflow 打包工具生成的完整 JSON 文件。文件内容不符合包格式，请修正后重新导入。',
        );
    } finally {
      input.value = '';
      if (mounted.current) setBusy(false);
    }
  }

  async function prepareRestore(contentRef: string) {
    if (busy || uncertain) return;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    pending.current = null;
    props.writes.delete(key);
    setRestoreRef(contentRef);
    setFile(null);
    setPreview(null);
    setReceipt(null);
    setError('');
    setBusy(true);
    try {
      const next = PersonalSceneRestorePreviewSchema.parse(
        await personalSceneJson(`${base}/restore`, props.headers, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId: props.workspaceId,
            restoreContentRef: contentRef,
          }),
        }),
      );
      if (
        next.instanceId !== props.instanceId ||
        next.restoreContentRef !== contentRef
      )
        throw Error('target_changed');
      if (!controller.signal.aborted && mounted.current) {
        setPreview(next);
        setSummary(
          `恢复 ${next.file.scene.name} 的修订 ${next.restoreRevision}`,
        );
      }
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current)
        setError(
          cause instanceof PersonalSceneHttpError
            ? cause.message
            : '历史版本暂不可读取，请重新核对。',
        );
    } finally {
      if (!controller.signal.aborted && mounted.current) setBusy(false);
    }
  }

  async function save() {
    if (busy || receipt || (!pending.current && (!preview || !summary.trim())))
      return;
    let next = pending.current;
    if (!next) {
      if (!preview) return;
      if ('restoreContentRef' in preview) {
        if (!('skillPackage' in preview.file.procedure)) return;
        const bundle = preview.file.procedure.skillPackage.bundle;
        next = RestorePersonalSceneFileSchema.parse({
          workspaceId: props.workspaceId,
          requestId: crypto.randomUUID(),
          expectedRevision: preview.expectedRevision,
          expectedContentRef: preview.expectedContentRef,
          restoreContentRef: preview.restoreContentRef,
          sceneId: preview.file.scene.id,
          contentChecksum: bundle.contentChecksum,
          bundleChecksum: bundle.checksum,
          changeSummary: summary,
        });
      } else
        next = SavePersonalSceneSkillSchema.parse({
          workspaceId: props.workspaceId,
          requestId: crypto.randomUUID(),
          expectedRevision: preview.expectedRevision,
          expectedContentRef: preview.expectedContentRef,
          scene: {
            id: preview.file.scene.id,
            name: preview.file.scene.name,
            appliesWhen: preview.file.scene.appliesWhen,
          },
          procedure: preview.file.procedure,
          references: preview.file.references,
          changeSummary: summary,
        });
    }
    const known = props.writes.get(key)?.receipt;
    if (known?.requestId === next.requestId) {
      pending.current = null;
      setReceipt(known);
      setUncertain(false);
      setError('');
      return;
    }
    pending.current = next;
    const write = { input: next };
    props.writes.set(key, write);
    setBusy(true);
    setError('');
    try {
      const restoring = 'restoreContentRef' in next;
      const result = (await personalSceneJson(
        restoring ? `${base}/restore` : base,
        props.headers,
        {
          method: restoring ? 'PUT' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(next),
        },
      )) as { receipt?: unknown };
      const saved = PersonalSceneSkillSaveReceiptSchema.parse(result?.receipt);
      const bundle =
        'procedure' in next && 'skillPackage' in next.procedure
          ? next.procedure.skillPackage.bundle
          : null;
      if (
        saved.instanceId !== props.instanceId ||
        saved.sceneId !== ('scene' in next ? next.scene.id : next.sceneId) ||
        saved.contentChecksum !==
          ('contentChecksum' in next
            ? next.contentChecksum
            : bundle?.contentChecksum) ||
        saved.bundleChecksum !==
          ('bundleChecksum' in next ? next.bundleChecksum : bundle?.checksum) ||
        ('restoreContentRef' in next &&
          saved.contentRef === next.restoreContentRef) ||
        saved.revision <= next.expectedRevision
      )
        throw Error('receipt_mismatch');
      const confirmed = { ...saved, requestId: next.requestId };
      // Writes continue after a preview/reader unmount. Keep their outcome in
      // the original private scope; aborting a read never cancels this save.
      pending.current = null;
      const current = props.writes.get(key);
      if (
        !current ||
        current.input?.requestId === next.requestId ||
        current.receipt?.requestId === next.requestId
      )
        props.writes.set(key, { receipt: confirmed });
      if (mounted.current) {
        setReceipt(confirmed);
        setUncertain(false);
        void loadHistory();
      }
    } catch (cause) {
      if (cause instanceof PersonalSceneHttpError && cause.status < 500) {
        pending.current = null;
        const confirmed = props.writes.get(key)?.receipt;
        if (confirmed?.requestId === next.requestId) {
          if (mounted.current) {
            setReceipt(confirmed);
            setUncertain(false);
          }
          return;
        }
        if (props.writes.get(key) === write) props.writes.delete(key);
        if (!mounted.current) return;
        setUncertain(false);
        setPreview(null);
        setError(cause.message);
      } else {
        if (!mounted.current) return;
        setUncertain(true);
        setError(
          '保存结果尚不明确。保留了这次请求，请重试同一次保存以取得准确回执。',
        );
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <details
      className={css.panel}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (event.currentTarget.open && !history && !historyReading.current)
          void loadHistory();
      }}
    >
      <summary>本人 Workflow · 文件与修改记录</summary>
      {open && (
        <div className={css.body}>
          <p className={css.hint}>
            在自己的编辑器修改，使用 Workflow 打包工具生成
            JSON，导入后核对并保存。包内脚本只作为文件资源保存。
          </p>
          <label className={css.fileInput}>
            导入 Workflow 文件
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy || uncertain}
              onChange={(event) => void upload(event.currentTarget)}
            />
          </label>
          {busy && (
            <p role="status">
              {pending.current
                ? '正在保存并核对回执…'
                : '正在核对文件与当前目标…'}
            </p>
          )}
          {error && (
            <p role="alert" className={css.error}>
              {error}
            </p>
          )}
          {uncertain && !preview && pending.current && (
            <section aria-label="待核对的原保存请求" className={css.history}>
              <strong>
                尚未取得明确回执：
                {'scene' in pending.current
                  ? pending.current.scene.name
                  : '恢复历史 Workflow'}
              </strong>
              <p>{pending.current.changeSummary}</p>
              <p className={css.hint}>
                保留了原请求和入参。请重试同一次保存，核对服务端的准确回执。
              </p>
              <Button disabled={busy} onClick={() => void save()}>
                重试同一次保存
              </Button>
            </section>
          )}
          {preview && (
            <>
              {'restoreContentRef' in preview && (
                <p>
                  恢复来源：修订 {preview.restoreRevision}
                  。确认后追加新的当前修订，保留原记录和来源引用。
                </p>
              )}
              <PersonalSceneFileDiff preview={preview} />
              {!receipt && (
                <label>
                  本次修改说明
                  <textarea
                    aria-label="本次修改说明"
                    rows={2}
                    maxLength={1000}
                    value={summary}
                    disabled={busy || uncertain}
                    onChange={(event) => setSummary(event.target.value)}
                  />
                </label>
              )}
              {!receipt && (
                <Button
                  onClick={() => void save()}
                  disabled={busy || (!uncertain && !summary.trim())}
                >
                  {uncertain
                    ? '重试同一次保存'
                    : 'restoreContentRef' in preview
                      ? '确认恢复并生效'
                      : '确认修改并生效'}
                </Button>
              )}
            </>
          )}
          {file && !preview && !busy && !uncertain && (
            <Button variant="outline" onClick={() => void prepare(file)}>
              重新预览当前目标
            </Button>
          )}
          {restoreRef && !preview && !busy && !uncertain && !receipt && (
            <Button
              variant="outline"
              onClick={() => void prepareRestore(restoreRef)}
            >
              重新预览恢复目标
            </Button>
          )}
          {receipt && (
            <div role="status" className={css.receipt}>
              <strong>已保存并生效 · 修订 {receipt.revision}</strong>
              <details>
                <summary>查看准确回执</summary>
                <code>请求：{receipt.requestId}</code>
                <code>内容地址：{receipt.contentRef}</code>
                <code>正文：{receipt.contentChecksum}</code>
                <code>完整包：{receipt.bundleChecksum}</code>
              </details>
            </div>
          )}
          <section aria-label="Workflow 修改记录" className={css.history}>
            <div className={css.toolbar}>
              <h4>修改记录</h4>
              <Button variant="outline" onClick={() => void loadHistory()}>
                重新读取修改记录
              </Button>
            </div>
            {historyError && <p role="alert">{historyError}</p>}
            {!history && !historyError && (
              <p role="status">正在读取修改记录…</p>
            )}
            {history?.entries.length === 0 && (
              <p className={css.hint}>还没有保存过 Workflow 文件。</p>
            )}
            {history?.entries.map((entry) => (
              <article key={entry.contentRef} className={css.resource}>
                <strong>
                  {entry.name} · 修订 {entry.revision}
                </strong>
                <span>{entry.changeSummary}</span>
                <span className={css.hint}>
                  {new Date(entry.createdAt).toLocaleString()} ·{' '}
                  {entry.available ? '当前可读取' : '来源已撤销或当前不可读取'}
                </span>
                <details>
                  <summary>准确版本</summary>
                  <code>{entry.contentRef}</code>
                  {entry.contentChecksum && (
                    <code>正文：{entry.contentChecksum}</code>
                  )}
                  {entry.bundleChecksum && (
                    <code>完整包：{entry.bundleChecksum}</code>
                  )}
                </details>
                <Button
                  variant="outline"
                  disabled={busy || uncertain || !entry.available}
                  onClick={() => void prepareRestore(entry.contentRef)}
                >
                  预览恢复：{entry.name} · 修订 {entry.revision}
                </Button>
              </article>
            ))}
            {history?.nextBeforeRevision && (
              <Button
                variant="outline"
                onClick={() => void loadHistory(history.nextBeforeRevision!)}
              >
                更早的修改记录
              </Button>
            )}
          </section>
        </div>
      )}
    </details>
  );
}
