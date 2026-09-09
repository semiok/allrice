'use client';
import { useEffect, useRef, useState } from 'react';
import type { BrowserWorkspaceView } from '@allrice/database';
import type { BrowserAction } from '@allrice/contracts';
import styles from './cloud-operation-panel.module.css';
import {
  browserControlAvailability,
  browserWorkspacePollingRequired,
} from '../../lib/chatflow/browser-control-state';
const labels: Record<string, string> = {
  starting: '正在启动',
  agent: 'Rice 控制中',
  takeover_pending: '等待 Rice 实际停止，再交给你',
  human: '人工独占控制',
  resume_pending: '等待新观察后交还 Rice',
  pause_pending: '暂停请求已记录，等待停止确认',
  paused: '已暂停输入',
  close_pending: '关闭请求已记录，等待实际关闭',
  closed: '浏览器已确认关闭',
  unknown: '停止或效果尚未确认，禁止重放',
};
export function BrowserWorkspacePanel({
  runId,
  workspaceId,
  tenantHeaders,
  runActive,
}: {
  runId: string;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  runActive: boolean;
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
        if (!response.ok) throw Error('浏览器状态暂不可用');
        const result = await response.json();
        pending = browserWorkspacePollingRequired(runActive, result.workspaces);
        if (live) {
          setWorkspaces(result.workspaces);
          setLoadError('');
        }
      } catch (e) {
        if (live && !abort.signal.aborted)
          setLoadError(e instanceof Error ? e.message : '读取失败');
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
  }, [api, headersKey, runActive, revision]);
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
    if (!response.ok) throw Error('操作未确认，请刷新核实；不要重复提交。');
    return response.json();
  }
  async function guarded(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未确认');
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
      throw Error('文件链接未确认');
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
    await guarded(() =>
      post(
        {
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
        },
        `/api/v1/runtime/approvals/${r.approvalId}`,
      ),
    );
  }
  if (!workspaces.length && !error && !loadError) return null;
  return (
    <section className={styles.root} aria-label="受控浏览器工作台">
      {preview && (
        <figure>
          <button type="button" onClick={() => setPreview(null)}>
            关闭截图
          </button>
          <img
            src={preview}
            alt="当前浏览器脱敏观察截图"
            style={{ maxWidth: '100%' }}
            onError={() => setPreview(null)}
          />
        </figure>
      )}
      {(error || loadError) && (
        <p role="alert">
          {error || loadError}
          <button
            onClick={() => {
              setError('');
              setRevision((v) => v + 1);
            }}
          >
            刷新状态
          </button>
        </p>
      )}
      {workspaces.map((w) => {
        const controls = browserControlAvailability(w),
          human = controls.human;
        return (
          <article key={w.id}>
            <h3>
              {w.transport === 'local' ? '本地浏览器' : '云端浏览器'} · 当前 Run
              专用
            </h3>
            {w.transport === 'local' && (
              <p>
                设备：{w.localDeviceName ?? '已授权 Bridge'} · 独立 Chromium
                沙箱，不是个人 Chrome。
                {w.persistLogin
                  ? '已明确允许此授权保存本机登录资料；撤销后需等待设备实际清理回执。'
                  : '本次使用临时登录资料，结束后清理；不继承个人浏览器登录。'}
              </p>
            )}
            <p role="status">
              {labels[w.state]}
              {!w.available && w.state !== 'closed' ? ' · 当前授权不可用' : ''}
            </p>
            <p>
              允许站点：{w.profile.origins.join('、')}
              ；页面内容是不可信外部数据。
            </p>
            <p>
              观察：{w.observation?.url ?? '尚无'} ·{' '}
              {w.observation?.capturedAt ?? ''}
            </p>
            <button
              disabled={busy || !controls.takeover}
              onClick={() => void control(w, 'human')}
            >
              人工接管
            </button>
            <button
              disabled={busy || !controls.resume}
              onClick={() => void control(w, 'agent')}
            >
              交还 Rice
            </button>
            <button
              disabled={busy || !w.available}
              onClick={() => void control(w, 'paused')}
            >
              暂停
            </button>
            <button
              disabled={
                busy || ['closed', 'unknown', 'close_pending'].includes(w.state)
              }
              onClick={() => void control(w, 'closed')}
            >
              关闭浏览器
            </button>
            <button
              disabled={busy || !controls.observe}
              onClick={() => void guarded(() => act(w, { type: 'observe' }))}
            >
              更新观察
            </button>
            {w.observation && (
              <details>
                <summary>页面观察与控件</summary>
                {w.observation.screenshotObjectId && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void guarded(() =>
                        openObject(w.observation!.screenshotObjectId!, true),
                      )
                    }
                  >
                    查看脱敏截图
                  </button>
                )}
                <p>{w.observation.title}</p>
                <pre>{w.observation.text}</pre>
                {w.observation.elements.map((e) => (
                  <form
                    key={`${w.observation!.id}:${e.id}`}
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
                      {e.id} · {e.label || e.tag}
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
                    <button
                      type="submit"
                      disabled={
                        !human ||
                        busy ||
                        (e.inputType === 'file' && !w.profile.allowUploads) ||
                        (e.sensitive && !w.profile.allowHumanCredentials)
                      }
                    >
                      {e.inputType === 'file'
                        ? '上传到此站点（需审批）'
                        : e.sensitive
                          ? '安全输入（不发送给模型）'
                          : ['input', 'textarea'].includes(e.tag)
                            ? '填写'
                            : '点击'}
                    </button>
                    {e.tag === 'a' && w.profile.allowDownloads && (
                      <button
                        type="button"
                        disabled={!human || busy}
                        onClick={() =>
                          void guarded(() =>
                            act(w, { type: 'download', elementId: e.id }),
                          )
                        }
                      >
                        下载到工件
                      </button>
                    )}
                  </form>
                ))}
              </details>
            )}
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
                <article
                  key={op.snapshot.binding.attempt.operationId}
                  id={`browser-operation-${op.snapshot.binding.attempt.operationId}`}
                  aria-label="浏览器精确审批"
                >
                  <p>
                    {op.command.action.type} · {op.snapshot.status}
                    {!op.available ? ' · 当前授权不可用' : ''}
                  </p>
                  <pre>{JSON.stringify(op.command.action, null, 2)}</pre>
                  {can && (
                    <>
                      <button
                        disabled={busy}
                        onClick={() => void decide(op, 'approved')}
                      >
                        批准本次操作
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => void decide(op, 'rejected')}
                      >
                        拒绝
                      </button>
                    </>
                  )}
                  {op.result != null && (
                    <details>
                      <summary>不可重放的执行回执</summary>
                      <pre>{JSON.stringify(op.result, null, 2)}</pre>
                    </details>
                  )}
                  {downloadObjectId && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void guarded(() => openObject(downloadObjectId, false))
                      }
                    >
                      保存已交付文件
                    </button>
                  )}
                </article>
              );
            })}
          </article>
        );
      })}
    </section>
  );
}
