'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Button,
  DisclosureRow,
  IconChevronRightOutlineRegular,
  IconInfoOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { BrowserWorkspaceView } from '@allrice/database';
import type { BrowserAction } from '@allrice/contracts';
import styles from './browser-workspace-panel.module.css';
import {
  browserControlAvailability,
  browserWorkspacePollingRequired,
} from '../../lib/chatflow/browser-control-state';
import {
  browserActionSummary,
  browserControlsVisible,
  browserOperationStatusLabel,
  browserStateLabel,
  shortDateTime,
} from '../../lib/chatflow/browser-workspace-presenter';
const elementLabels: Record<string, string> = {
  a: '链接',
  button: '按钮',
  input: '输入框',
  textarea: '文本框',
  select: '下拉选择',
};
function Collapsible({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DisclosureRow
      icon={icon}
      title={title}
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => setOpen((value) => !value)}
      className={styles.disclosure}
    >
      {open && <div className={styles.disclosureBody}>{children}</div>}
    </DisclosureRow>
  );
}
export function BrowserWorkspacePanel({
  runId,
  workspaceId,
  tenantHeaders,
  runActive,
  refreshKey = 0,
}: {
  runId: string;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  runActive: boolean;
  refreshKey?: number;
}) {
  const [workspaces, setWorkspaces] = useState<BrowserWorkspaceView[]>([]),
    [error, setError] = useState(''),
    [loadError, setLoadError] = useState(''),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<string | null>(null),
    [revision, setRevision] = useState(0);
  const headersKey = JSON.stringify(tenantHeaders),
    api = `/api/v1/runtime/browser-workspaces?workspaceId=${workspaceId}&runId=${runId}`;
  const submitted = useRef(new Set<string>());
  const responses = useRef(
    new Map<string, { decision: 'approved' | 'rejected' }>(),
  );
  useEffect(() => {
    let live = true,
      pending = runActive,
      timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(api, {
          headers: JSON.parse(headersKey),
          cache: 'no-store',
          signal: abort.signal,
        });
        if (response.status === 404) {
          // Older/default-off servers do not have a browser control surface.
          // No state is invented and no error-poll loop is started.
          pending = false;
          if (live) {
            setWorkspaces([]);
            setLoadError('');
          }
          return;
        }
        if (!response.ok) throw Error('暂时读不到浏览器状态。');
        const result = await response.json();
        pending = browserWorkspacePollingRequired(runActive, result.workspaces);
        if (live) {
          setWorkspaces(result.workspaces);
          setLoadError('');
        }
      } catch (e) {
        if (live && !abort.signal.aborted)
          setLoadError(
            e instanceof Error ? e.message : '暂时读不到浏览器状态。',
          );
      } finally {
        if (live && pending) timer = setTimeout(() => void load(), 1000);
      }
    };
    void load();
    return () => {
      live = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, headersKey, runActive, revision, refreshKey]);
  async function post(body: unknown, path = api) {
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        ...tenantHeaders,
        'x-allrice-workspace-id': workspaceId,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw Error('操作结果待确认，请刷新状态查看，不要重复操作。');
    return response.json();
  }
  async function guarded(action: () => Promise<unknown>) {
    if (busy) return false;
    setBusy(true);
    setError('');
    try {
      await action();
      return true;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : '操作结果待确认，请刷新状态查看。',
      );
      return false;
    } finally {
      setBusy(false);
      setRevision((v) => v + 1);
    }
  }
  const control = (
    w: BrowserWorkspaceView,
    value: 'human' | 'agent' | 'paused' | 'closed',
  ) =>
    guarded(() =>
      post({
        kind: 'control',
        id: w.id,
        request: {
          requestId: crypto.randomUUID(),
          expectedFence: w.fence,
          control: value,
          observationId: w.observation?.id ?? null,
        },
      }),
    );
  const act = (w: BrowserWorkspaceView, action: BrowserAction) =>
    post({
      kind: 'act',
      requestId: crypto.randomUUID(),
      command: {
        version: 1,
        workspaceId: w.id,
        profileId: w.profileId,
        actor: 'human',
        fence: w.fence,
        observationId: w.observation?.id ?? null,
        action,
      },
    });
  async function openObject(objectId: string, view: boolean) {
    const signed = await post(
      { lifetimeSeconds: 60 },
      `/api/v1/files/${objectId}/sign`,
    );
    if (
      typeof signed.url !== 'string' ||
      !signed.url.startsWith(`/api/v1/files/${objectId}?`)
    )
      throw Error('文件暂时打不开，请稍后重试。');
    if (view) setPreview(signed.url);
    else {
      const a = document.createElement('a');
      a.href = signed.url;
      a.download = 'browser-download';
      a.rel = 'noopener';
      a.click();
    }
  }
  async function decide(
    op: BrowserWorkspaceView['operations'][number],
    decision: 'approved' | 'rejected',
  ) {
    const r = op.approval?.request;
    if (!r || submitted.current.has(r.approvalId)) return;
    submitted.current.add(r.approvalId);
    const previous = responses.current.get(r.approvalId);
    const body =
      previous?.decision === decision
        ? previous
        : {
            contractVersion: 1,
            direction: 'response',
            kind: 'action_approval',
            requestId: r.requestId,
            version: r.version,
            requestDigest: r.requestDigest,
            task: r.task,
            responseId: crypto.randomUUID(),
            respondedBy: r.respondentId,
            respondedAt: new Date().toISOString(),
            approvalId: r.approvalId,
            decision,
          };
    responses.current.set(r.approvalId, body);
    // A failed request may still have been recorded: the reload shows which,
    // and a retry resends this identical response, acknowledged at most once.
    if (
      !(await guarded(() =>
        post(body, `/api/v1/runtime/approvals/${r.approvalId}`),
      ))
    )
      submitted.current.delete(r.approvalId);
  }
  if (!workspaces.length && !error && !loadError) return null;
  return (
    <section className={styles.root} aria-label="浏览器">
      {preview && (
        <figure className={styles.preview}>
          <img
            src={preview}
            alt="当前页面截图（已隐去敏感内容）"
            onError={() => setPreview(null)}
          />
          <Button size="sm" variant="outline" onClick={() => setPreview(null)}>
            关闭截图
          </Button>
        </figure>
      )}
      {(error || loadError) && (
        <p role="alert" className={styles.alert}>
          <span>{error || loadError}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setError('');
              setRevision((v) => v + 1);
            }}
          >
            刷新状态
          </Button>
        </p>
      )}
      {workspaces.map((w) => {
        const controls = browserControlAvailability(w),
          human = controls.human;
        return (
          <article key={w.id} className={styles.card}>
            <header className={styles.header}>
              <h3>
                {w.preview
                  ? '本地项目预览'
                  : w.transport === 'local'
                    ? '本地浏览器'
                    : '云端浏览器'}
              </h3>
              <p role="status">{browserStateLabel(w.state)}</p>
            </header>
            {w.transport === 'local' && (
              <p className={styles.note}>
                在「{w.localDeviceName ?? '你的电脑'}
                」上用独立的浏览器打开，不使用你自己的 Chrome 登录。
                {w.persistLogin
                  ? '这次会保存登录状态，撤销授权后清除。'
                  : '这次不保存登录状态，结束后自动清除。'}
              </p>
            )}
            {w.preview && (
              <p className={styles.note}>
                预览你电脑上正在运行的项目，最迟到{' '}
                {shortDateTime(w.preview.hardDeadlineAt)}
                结束；项目停止或电脑断开后就看不到了。
              </p>
            )}
            {w.observation && (
              <p className={styles.page}>
                当前页面：
                <span title={w.observation.url}>
                  {w.observation.title || w.observation.url}
                </span>
                {shortDateTime(w.observation.capturedAt) &&
                  ` · ${shortDateTime(w.observation.capturedAt)}`}
              </p>
            )}
            {browserControlsVisible(w.state) && (
              <div className={styles.actions}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !controls.takeover}
                  onClick={() => void control(w, 'human')}
                >
                  我来操作
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !controls.resume}
                  onClick={() => void control(w, 'agent')}
                >
                  交还 Rice
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !w.available}
                  onClick={() => void control(w, 'paused')}
                >
                  暂停
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={
                    busy || ['unknown', 'close_pending'].includes(w.state)
                  }
                  onClick={() => void control(w, 'closed')}
                >
                  关闭浏览器
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || !controls.observe}
                  onClick={() =>
                    void guarded(() => act(w, { type: 'observe' }))
                  }
                >
                  刷新页面内容
                </Button>
              </div>
            )}
            {w.observation && browserControlsVisible(w.state) && (
              <Collapsible
                icon={<IconChevronRightOutlineRegular />}
                title="手动操作页面"
              >
                {w.observation.screenshotObjectId && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void guarded(() =>
                        openObject(w.observation!.screenshotObjectId!, true),
                      )
                    }
                  >
                    查看页面截图
                  </Button>
                )}
                <p className={styles.pageText}>{w.observation.text}</p>
                {w.observation.elements.map((e) => (
                  <form
                    key={`${w.observation!.id}:${e.id}`}
                    className={styles.element}
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = event.currentTarget,
                        field = form.elements.namedItem(
                          'value',
                        ) as HTMLInputElement | null;
                      const value = field?.value ?? '';
                      if (field) field.value = '';
                      void guarded(async () => {
                        if (e.inputType === 'file') {
                          const picker = form.elements.namedItem(
                              'upload',
                            ) as HTMLInputElement,
                            file = picker.files?.[0];
                          picker.value = '';
                          if (
                            !file ||
                            !w.profile.allowUploads ||
                            file.size > w.profile.maximumFileBytes ||
                            file.size === 0
                          )
                            throw Error('请选择允许大小内的合成或已授权文件');
                          const bytes = new Uint8Array(
                            await file.arrayBuffer(),
                          );
                          let binary = '';
                          for (let i = 0; i < bytes.length; i += 8192)
                            binary += String.fromCharCode(
                              ...bytes.subarray(i, i + 8192),
                            );
                          const uploaded = await post(
                            {
                              workspaceId,
                              category: 'uploads',
                              mediaType:
                                file.type || 'application/octet-stream',
                              contentBase64: btoa(binary),
                              visibility: 'private',
                              immutable: true,
                            },
                            '/api/v1/files',
                          );
                          bytes.fill(0);
                          binary = '';
                          await act(w, {
                            type: 'upload',
                            elementId: e.id,
                            objectId: uploaded.file.object.id,
                            checksum: uploaded.file.object.checksum,
                            fileName:
                              file.name
                                .replace(/[^A-Za-z0-9._-]/g, '_')
                                .slice(0, 100) || 'upload.bin',
                          });
                        } else if (e.sensitive) {
                          const input = await post({
                            kind: 'input',
                            id: w.id,
                            fence: w.fence,
                            observationId: w.observation!.id,
                            elementId: e.id,
                            value,
                          });
                          await act(w, {
                            type: 'sensitive_fill',
                            elementId: e.id,
                            inputId: input.inputId,
                          });
                        } else if (e.tag === 'input' || e.tag === 'textarea')
                          await act(w, {
                            type: 'fill',
                            elementId: e.id,
                            value,
                          });
                        else await act(w, { type: 'click', elementId: e.id });
                      });
                    }}
                  >
                    <label>
                      <span>
                        {e.label || elementLabels[e.tag] || '页面元素'}
                      </span>
                      {e.inputType === 'file' && (
                        <input
                          name="upload"
                          type="file"
                          disabled={!human || busy || !w.profile.allowUploads}
                        />
                      )}
                      {['input', 'textarea'].includes(e.tag) &&
                        e.inputType !== 'file' && (
                          <input
                            name="value"
                            type={e.sensitive ? 'password' : 'text'}
                            autoComplete="off"
                            disabled={
                              !human ||
                              busy ||
                              (e.sensitive && !w.profile.allowHumanCredentials)
                            }
                          />
                        )}
                    </label>
                    <Button
                      type="submit"
                      size="sm"
                      variant="outline"
                      disabled={
                        !human ||
                        busy ||
                        (e.inputType === 'file' && !w.profile.allowUploads) ||
                        (e.sensitive && !w.profile.allowHumanCredentials)
                      }
                    >
                      {e.inputType === 'file'
                        ? '上传到这个网站（需确认）'
                        : e.sensitive
                          ? '安全输入（不发给 Rice）'
                          : ['input', 'textarea'].includes(e.tag)
                            ? '填写'
                            : '点击'}
                    </Button>
                    {e.tag === 'a' && w.profile.allowDownloads && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={!human || busy}
                        onClick={() =>
                          void guarded(() =>
                            act(w, { type: 'download', elementId: e.id }),
                          )
                        }
                      >
                        保存为成果
                      </Button>
                    )}
                  </form>
                ))}
              </Collapsible>
            )}
            {w.operations.length > 0 && (
              <ol className={styles.operations} aria-label="浏览器操作记录">
                {w.operations.map((op) => {
                  const downloadObjectId =
                    op.result &&
                    typeof op.result === 'object' &&
                    'downloadObjectId' in op.result &&
                    typeof op.result.downloadObjectId === 'string' &&
                    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                      op.result.downloadObjectId,
                    )
                      ? op.result.downloadObjectId
                      : null;
                  const r = op.approval?.request,
                    can =
                      op.available &&
                      op.snapshot.status === 'waiting_user' &&
                      r &&
                      !op.approval?.response &&
                      !op.approval?.revokedAt &&
                      Date.parse(r.expiresAt) > Date.now() &&
                      !submitted.current.has(r.approvalId);
                  return (
                    <li
                      key={op.snapshot.binding.attempt.operationId}
                      id={`browser-operation-${op.snapshot.binding.attempt.operationId}`}
                    >
                      <span>{browserActionSummary(op.command.action)}</span>
                      <span className={styles.operationStatus}>
                        {browserOperationStatusLabel(op.snapshot.status)}
                      </span>
                      {can && (
                        <span className={styles.operationActions}>
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={busy}
                            onClick={() => void decide(op, 'approved')}
                          >
                            允许这一步
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void decide(op, 'rejected')}
                          >
                            拒绝
                          </Button>
                        </span>
                      )}
                      {downloadObjectId && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void guarded(() =>
                              openObject(downloadObjectId, false),
                            )
                          }
                        >
                          保存下载的文件
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
            <Collapsible icon={<IconInfoOutlineRegular />} title="技术详情">
              <dl className={styles.technical}>
                <dt>浏览器</dt>
                <dd>
                  {w.id} · {w.state}
                  {w.available ? '' : ' · 授权已失效'}
                </dd>
                <dt>可访问的网站</dt>
                <dd>
                  {w.profile.origins.length
                    ? w.profile.origins.join('、')
                    : '公开的 HTTPS 网站'}
                  ；页面内容按不可信的外部数据处理。
                </dd>
                {w.preview && (
                  <>
                    <dt>本地预览</dt>
                    <dd>
                      容器端口 {w.preview.port}；只支持 HTTP 页面，不支持
                      WebSocket、热更新和保存登录状态。
                    </dd>
                  </>
                )}
                {w.operations.map((op) => (
                  <div key={op.snapshot.binding.attempt.operationId}>
                    <dt>
                      {op.command.action.type} · {op.snapshot.status}
                      {op.available ? '' : ' · 授权已失效'}
                    </dt>
                    <dd>
                      <pre>{JSON.stringify(op.command.action, null, 2)}</pre>
                      {op.result != null && (
                        <pre>{JSON.stringify(op.result, null, 2)}</pre>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </Collapsible>
          </article>
        );
      })}
    </section>
  );
}
