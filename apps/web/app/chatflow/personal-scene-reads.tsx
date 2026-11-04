'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  PersonalSceneSkillCatalogSchema,
  PersonalSceneSkillSchema,
  PersonalSceneSkillResourceSchema,
  PersonalSceneReadHistorySchema,
  type PersonalSceneSkill,
  type PersonalSceneReadHistory,
} from '@allrice/contracts';
import {
  personalSceneJson,
  PersonalSceneHttpError,
} from './personal-scene-files';
import { TechnicalDetails } from './technical-details';
import css from './personal-scene-files.module.css';

type Props = {
  scopeId: string;
  instanceId: string;
  workspaceId: string;
  headers: Record<string, string>;
};
type Catalog = ReturnType<typeof PersonalSceneSkillCatalogSchema.parse>;
type Resource = ReturnType<typeof PersonalSceneSkillResourceSchema.parse>;
const statusNames = {
  queued: '排队中',
  running: '执行中',
  waiting_approval: '等待确认',
  succeeded: '已完成',
  failed: '未完成',
  canceled: '已取消',
  needs_attention: '需要处理',
};
function readError(cause: unknown) {
  return cause instanceof PersonalSceneHttpError
    ? cause.message
    : '当前读取未完成，请重新读取。';
}
function resourceBytes(resource: Resource) {
  return Uint8Array.from(atob(resource.contentBase64), (character) =>
    character.charCodeAt(0),
  );
}
function resourceText(resource: Resource) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      resourceBytes(resource),
    );
  } catch {
    return null;
  }
}

export function PersonalSceneReadPanel(props: Props) {
  return (
    <ReadPanel
      key={`${props.scopeId}/${props.workspaceId}/${props.instanceId}`}
      {...props}
    />
  );
}
function ReadPanel(props: Props) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [history, setHistory] = useState<PersonalSceneReadHistory | null>(null);
  const [skill, setSkill] = useState<PersonalSceneSkill | null>(null);
  const [resource, setResource] = useState<Resource | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [contentError, setContentError] = useState('');
  const [loading, setLoading] = useState(false);
  const catalogRequest = useRef<AbortController | null>(null);
  const historyRequest = useRef<AbortController | null>(null);
  const contentRequest = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const base = `/api/v1/employee-instances/${encodeURIComponent(props.instanceId)}/scene-skills`;
  const workspaceQuery = `workspaceId=${encodeURIComponent(props.workspaceId)}`;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      catalogRequest.current?.abort();
      historyRequest.current?.abort();
      contentRequest.current?.abort();
    };
  }, []);
  function clearPrivatePreview() {
    contentRequest.current?.abort();
    contentRequest.current = null;
    setSkill(null);
    setResource(null);
    setContentError('');
    setLoading(false);
  }
  function invalidateDeniedRead(cause: unknown, audit = false) {
    if (
      !(cause instanceof PersonalSceneHttpError) ||
      ![401, 403, 404].includes(cause.status)
    )
      return;
    clearPrivatePreview();
    // Current content can be withdrawn while the owner still has audit access.
    // A denial of the audit scope or session invalidates both metadata requests.
    if (audit || cause.status === 401) {
      catalogRequest.current?.abort();
      historyRequest.current?.abort();
      setCatalog(null);
      setHistory(null);
      setCatalogError(readError(cause));
      setHistoryError(readError(cause));
    }
  }
  async function directory() {
    catalogRequest.current?.abort();
    const controller = new AbortController();
    catalogRequest.current = controller;
    setCatalogError('');
    setCatalog(null);
    try {
      const next = PersonalSceneSkillCatalogSchema.parse(
        await personalSceneJson(`${base}?${workspaceQuery}`, props.headers, {
          signal: controller.signal,
        }),
      );
      if (next.instanceId !== props.instanceId) throw Error('target_changed');
      if (!controller.signal.aborted && mounted.current) setCatalog(next);
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) {
        invalidateDeniedRead(cause);
        setCatalogError(readError(cause));
      }
    }
  }
  async function reads(
    cursor?: NonNullable<PersonalSceneReadHistory['nextCursor']>,
  ) {
    historyRequest.current?.abort();
    const controller = new AbortController();
    historyRequest.current = controller;
    setHistoryError('');
    if (!cursor) setHistory(null);
    const after = cursor
      ? `&beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}&beforeRunId=${cursor.runId}`
      : '';
    try {
      const next = PersonalSceneReadHistorySchema.parse(
        await personalSceneJson(
          `${base}/reads?${workspaceQuery}${after}`,
          props.headers,
          { signal: controller.signal },
        ),
      );
      if (next.instanceId !== props.instanceId) throw Error('target_changed');
      if (!controller.signal.aborted && mounted.current)
        setHistory((previous) =>
          cursor && previous
            ? { ...next, runs: [...previous.runs, ...next.runs] }
            : next,
        );
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) {
        invalidateDeniedRead(cause, true);
        setHistory(null);
        setHistoryError(readError(cause));
      }
    }
  }
  async function inspect(sceneId: string, contentRef?: string) {
    contentRequest.current?.abort();
    const controller = new AbortController();
    contentRequest.current = controller;
    setSkill(null);
    setResource(null);
    setContentError('');
    setLoading(true);
    try {
      const next = PersonalSceneSkillSchema.parse(
        await personalSceneJson(
          contentRef
            ? `${base}/content?${workspaceQuery}&contentRef=${encodeURIComponent(contentRef)}`
            : `${base}?${workspaceQuery}&sceneId=${sceneId}`,
          props.headers,
          { signal: controller.signal },
        ),
      );
      if (
        next.sceneId !== sceneId ||
        (contentRef && next.contentRef !== contentRef)
      )
        throw Error('target_changed');
      if (!controller.signal.aborted && mounted.current) setSkill(next);
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) {
        invalidateDeniedRead(cause);
        setContentError(readError(cause));
      }
    } finally {
      if (!controller.signal.aborted && mounted.current) setLoading(false);
    }
  }
  async function inspectResource(selected: PersonalSceneSkill, path: string) {
    contentRequest.current?.abort();
    const controller = new AbortController();
    contentRequest.current = controller;
    setResource(null);
    setContentError('');
    setLoading(true);
    try {
      const next = PersonalSceneSkillResourceSchema.parse(
        await personalSceneJson(
          `${base}?${workspaceQuery}&contentRef=${encodeURIComponent(selected.contentRef)}&resourcePath=${encodeURIComponent(path)}`,
          props.headers,
          { signal: controller.signal },
        ),
      );
      const descriptor = selected.resources.find((item) => item.path === path);
      if (
        !descriptor ||
        next.contentRef !== selected.contentRef ||
        next.path !== path ||
        next.checksum !== descriptor.checksum ||
        next.bundleChecksum !== selected.bundleChecksum ||
        next.byteLength !== descriptor.byteLength ||
        next.mediaType !== descriptor.mediaType
      )
        throw Error('resource_changed');
      if (!controller.signal.aborted && mounted.current) setResource(next);
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) {
        invalidateDeniedRead(cause);
        setContentError(readError(cause));
        // A failed current authorization must not leave an old preview behind.
        setSkill(null);
      }
    } finally {
      if (!controller.signal.aborted && mounted.current) setLoading(false);
    }
  }
  return (
    <details
      className={css.panel}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (event.currentTarget.open && !catalogRequest.current) {
          void directory();
          void reads();
        }
      }}
    >
      <summary>本人 Workflow · 目录与读取记录</summary>
      {open && (
        <div className={css.body}>
          <section aria-label="当前可用 Workflow 目录" className={css.history}>
            <div className={css.toolbar}>
              <h4>当前可用目录</h4>
              <Button variant="outline" onClick={() => void directory()}>
                重新读取目录
              </Button>
            </div>
            <p className={css.hint}>
              目录表示当前可读取。这里查看文件不计为模型实际读取。
            </p>
            {catalogError && <p role="alert">{catalogError}</p>}
            {!catalog && !catalogError && (
              <p role="status">正在读取当前目录…</p>
            )}
            {catalog?.skills.length === 0 && (
              <p>当前没有可读取的本人 Workflow。</p>
            )}
            {catalog?.skills.map((entry) => (
              <article className={css.resource} key={entry.sceneId}>
                <strong>{entry.name}</strong>
                <span>{entry.description}</span>
                <code>/{entry.nativeName}</code>
                <Button
                  variant="outline"
                  onClick={() => void inspect(entry.sceneId)}
                >
                  查看当前包：{entry.name}
                </Button>
              </article>
            ))}
          </section>
          {loading && <p role="status">正在核验当前权限并读取…</p>}
          {contentError && <p role="alert">{contentError}</p>}
          {skill && (
            <section aria-label="本人包与精确资源" className={css.history}>
              <h4>
                {skill.name} · 修订 {skill.revision}
              </h4>
              <p className={css.hint}>
                本人查看 · 文件版本 {skill.bundleVersion}
              </p>
              <div
                className={css.columns}
                style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}
              >
                <section aria-label="查看的 Workflow 正文">
                  <pre>{skill.content}</pre>
                </section>
              </div>
              <TechnicalDetails
                rows={[
                  ['内容地址', <code key="ref">{skill.contentRef}</code>],
                  ['正文哈希', <code key="body">{skill.contentChecksum}</code>],
                  [
                    '完整包哈希',
                    <code key="bundle">{skill.bundleChecksum}</code>,
                  ],
                ]}
              />
              {skill.sources.map((source) => (
                <p key={source.reference.revisionId}>
                  {source.title || '来源引用'}{' '}
                  <code>{source.reference.digest}</code>
                </p>
              ))}
              {skill.resources.map((entry) => (
                <div key={entry.path} className={css.resource}>
                  <span>
                    {entry.path} · {entry.byteLength} bytes
                  </span>
                  <code>{entry.checksum}</code>
                  <Button
                    variant="outline"
                    onClick={() => void inspectResource(skill, entry.path)}
                  >
                    读取资源：{entry.path}
                  </Button>
                </div>
              ))}
            </section>
          )}
          {resource && (
            <section aria-label="已核验的资源文件" className={css.history}>
              <strong>{resource.path}</strong>
              <code>{resource.checksum}</code>
              <div
                className={css.columns}
                style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}
              >
                <section>
                  <pre>
                    {resourceText(resource) ?? '二进制资源，可下载文件核对。'}
                  </pre>
                </section>
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([new Uint8Array(resourceBytes(resource)).buffer], {
                      type: resource.mediaType,
                    }),
                  );
                  const anchor = document.createElement('a');
                  anchor.href = url;
                  anchor.download = resource.path.split('/').at(-1)!;
                  anchor.click();
                  setTimeout(() => URL.revokeObjectURL(url), 0);
                }}
              >
                下载资源文件
              </Button>
            </section>
          )}
          <section aria-label="模型实际读取记录" className={css.history}>
            <div className={css.toolbar}>
              <h4>模型实际读取记录</h4>
              <Button variant="outline" onClick={() => void reads()}>
                重新读取工作记录
              </Button>
            </div>
            <p className={css.hint}>
              只展示已提交的读取事实。当前记录未提供准确注入或原生调用关联，读取不表示已遵循。
            </p>
            {historyError && historyError !== catalogError && (
              <p role="alert">{historyError}</p>
            )}
            {!history && !historyError && (
              <p role="status">正在读取工作记录…</p>
            )}
            {history?.runs.length === 0 && <p>还没有这位员工的工作记录。</p>}
            {history?.runs.map((run) => (
              <article key={run.runId} className={css.resource}>
                <div className={css.toolbar}>
                  <strong>
                    {new Date(run.createdAt).toLocaleString()} ·{' '}
                    {statusNames[run.status]}
                  </strong>
                  <a
                    className={css.link}
                    href={`/chatflow?session=${run.sessionId}#message-${run.messageId}`}
                  >
                    回到原工作记录
                  </a>
                </div>
                {run.error && (
                  <p role="status">
                    {run.error.message}
                    {run.error.code && <code>{run.error.code}</code>}
                  </p>
                )}
                {!run.reads.length && (
                  <p className={css.hint}>
                    这次工作没有已提交的 Workflow 读取记录。
                  </p>
                )}
                {run.reads.map((read) => (
                  <section
                    key={read.receiptId}
                    aria-label="准确读取回执"
                    className={css.resource}
                  >
                    <p>
                      {read.contentRead ? '已记录正文读取' : '未记录正文读取'} ·
                      已读资源 {read.resources.length} 项
                    </p>
                    <TechnicalDetails
                      rows={[
                        ['Run', <code key="run">{run.runId}</code>],
                        [
                          '读取回执',
                          <code key="receipt">{read.receiptId}</code>,
                        ],
                        ['首次读取时间', read.readAt],
                        ['内容地址', <code key="ref">{read.contentRef}</code>],
                        [
                          '正文哈希',
                          <code key="body">{read.contentChecksum}</code>,
                        ],
                        [
                          '完整包哈希',
                          <code key="bundle">{read.bundleChecksum}</code>,
                        ],
                        [
                          '来源代际',
                          <code key="generation">{read.generationId}</code>,
                        ],
                      ]}
                    />
                    {read.resources.map((entry) => (
                      <p key={entry.path}>
                        {entry.path}
                        <code>{entry.checksum}</code>
                      </p>
                    ))}
                    <Button
                      variant="outline"
                      onClick={() =>
                        void inspect(read.sceneId, read.contentRef)
                      }
                    >
                      查看这次读取的包
                    </Button>
                  </section>
                ))}
              </article>
            ))}
            {history?.nextCursor && (
              <Button
                variant="outline"
                onClick={() => void reads(history.nextCursor!)}
              >
                更早的工作记录
              </Button>
            )}
          </section>
        </div>
      )}
    </details>
  );
}
