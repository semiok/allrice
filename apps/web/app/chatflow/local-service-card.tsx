'use client';
import { useEffect, useRef, useState } from 'react';
import {
  canonicalRuntimeBridgeJson,
  type RuntimeLocalServiceConfig,
  type RuntimeLocalServiceRequest,
} from '@allrice/contracts';
import {
  localPreviewAvailability,
  type LocalPreviewView,
} from '../../lib/chatflow/local-preview-state';
export interface LocalServiceView {
  processId: string;
  attemptId: string;
  state: string;
  hardDeadlineAt: string;
  containerId: string | null;
  visibility: string;
  stopRequested: boolean;
  previewEnabled?: boolean;
  preview?: LocalPreviewView | null;
  requests: {
    request: RuntimeLocalServiceRequest;
    submitted: boolean;
    delivered: boolean;
  }[];
}
const states: Record<string, string> = {
  starting: '正在启动',
  ready: '服务已就绪（仅容器内部）',
  waiting_input: '等待明确的进程输入',
  stopping: '正在请求停止，尚未确认',
  stopped: '已确认停止',
  failed: '服务未成功',
  unknown: '执行结果待核实，不会自动重启',
};
export function LocalServiceCard({
  config,
  service,
  runId,
  workspaceId,
  tenantHeaders,
  onChanged,
}: {
  config: RuntimeLocalServiceConfig;
  service: LocalServiceView | null | undefined;
  runId: string;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  onChanged: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [previewIntent, setPreviewIntent] = useState<LocalPreviewView | null>(
    null,
  );
  useEffect(() => {
    setPreviewIntent(null);
  }, [service?.processId]);
  const previewState = localPreviewAvailability({
    enabled: service?.previewEnabled === true,
    http: config.readiness.kind === 'http',
    state: service?.state ?? 'starting',
    stopRequested: service?.stopRequested ?? true,
    hardDeadlineAt: service?.hardDeadlineAt ?? '',
    preview: service?.preview ?? previewIntent,
  });
  const lastInput = useRef<{ key: string; input: unknown } | null>(null);
  const request = service?.requests.find(
    (x) =>
      !x.submitted &&
      !x.delivered &&
      Date.parse(x.request.expiresAt) > Date.now(),
  )?.request;
  useEffect(() => {
    setText('');
    lastInput.current = null;
  }, [request?.requestId]);
  async function act(
    action: 'stop' | 'input' | 'preview',
    kind: 'text' | 'eof' = 'text',
  ) {
    if (!service || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      let input: unknown;
      if (action === 'input') {
        if (!request) throw Error('输入请求已过期，请刷新状态');
        const value = kind === 'eof' ? '' : text;
        if (new TextEncoder().encode(value).length > request.maxBytes)
          throw Error(`输入不能超过 ${request.maxBytes} 字节`);
        const hash = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(
            canonicalRuntimeBridgeJson({ kind, text: value }),
          ),
        );
        const digest = `sha256:${Array.from(new Uint8Array(hash), (x) => x.toString(16).padStart(2, '0')).join('')}`;
        const candidate = {
          inputId: crypto.randomUUID(),
          requestId: request.requestId,
          sequence: request.sequence,
          expiresAt: request.expiresAt,
          digest,
          kind,
          text: value,
        };
        const key = canonicalRuntimeBridgeJson({
          requestId: request.requestId,
          kind,
          text: value,
        });
        if (lastInput.current?.key !== key)
          lastInput.current = { key, input: candidate };
        input = lastInput.current.input;
      }
      const response = await fetch(
        `/api/v1/runtime/local-services?workspaceId=${encodeURIComponent(workspaceId)}&runId=${encodeURIComponent(runId)}&processId=${encodeURIComponent(service.processId)}`,
        {
          method: 'POST',
          headers: { ...tenantHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...(input ? { input } : {}) }),
        },
      );
      if (!response.ok)
        throw Error(
          '请求未确认：可能已过期、已停止或已在其他页面处理，请刷新状态。',
        );
      if (action === 'input') setText('');
      if (action === 'preview')
        setPreviewIntent((await response.json()) as LocalPreviewView);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
      onChanged(); // A response may be lost after durable acceptance; refresh before another intent.
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return (
    <section aria-label="有限后台服务">
      <p>
        有限后台服务：最多 {Math.ceil(config.durationMs / 1000)} 秒，归属于本次
        Run；Run 结束、断线失去授权或达到期限时停止。端口{' '}
        {config.readiness.port}{' '}
        仅隔离容器内可达。启用项目预览后也不发布本机端口或公共网址。
      </p>
      <p>
        输入模式：
        {config.stdin.mode === 'none'
          ? '不接受输入'
          : '只接受进程通过专用协议明确请求的有限文本或 EOF；不是交互式终端'}
      </p>
      <p>
        就绪检查：{config.readiness.kind.toUpperCase()}{' '}
        {config.readiness.kind === 'http' ? config.readiness.path : ''}，最多{' '}
        {config.readiness.timeoutMs / 1000} 秒。
        {config.stdin.mode === 'requests-v1' &&
          `最多 ${config.stdin.maxRequests} 次输入，每次 ${config.stdin.maxBytes} 字节，单次等待 ${config.stdin.requestTimeoutMs / 1000} 秒；过期将停止服务。`}
      </p>
      {service && (
        <>
          <p role="status">
            {states[service.state] ?? service.state} · 截止{' '}
            {new Date(service.hardDeadlineAt).toLocaleTimeString()}
          </p>
          <small>Process：{service.processId}</small>
          {previewState.visible && (
            <section aria-label="项目预览">
              <p>{previewState.status}</p>
              <p>
                预览在独立受控浏览器内呈现，截图和操作在下方浏览器工作台审查；不会在
                AllRice 主站执行项目
                HTML，不继承主站身份。服务停止或授权失效后预览一并失效，不自动改由云端运行。
              </p>
              <button
                type="button"
                disabled={busy || !previewState.canRequest}
                onClick={() => void act('preview')}
              >
                {previewState.label}
              </button>
            </section>
          )}
          {!['stopped', 'failed', 'unknown'].includes(service.state) && (
            <button
              type="button"
              disabled={busy || service.stopRequested}
              onClick={() => void act('stop')}
            >
              停止此服务
            </button>
          )}
          {service.requests.map((x) => (
            <p key={x.request.requestId}>
              进程输入 #{x.request.sequence + 1}：
              {x.delivered
                ? '已写入输入管道（不代表应用已消费）'
                : x.submitted
                  ? ['stopping', 'stopped', 'failed', 'unknown'].includes(
                      service.state,
                    )
                    ? '投递结果未确认；服务已停止或待核对，不会自动重试'
                    : '已提交，等待投递确认'
                  : Date.parse(x.request.expiresAt) <= Date.now()
                    ? '已过期'
                    : '待用户输入'}
            </p>
          ))}
          {request &&
            !service.stopRequested &&
            !['stopping', 'stopped', 'failed', 'unknown'].includes(
              service.state,
            ) &&
            Date.parse(service.hardDeadlineAt) > Date.now() && (
              <div>
                <label>
                  进程请求（不是 Rice 的聊天提问）：{request.prompt}
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    maxLength={request.maxBytes}
                    disabled={busy}
                  />
                </label>
                <p>
                  只发送给这个请求对应的进程，不提交密码或凭证。截止{' '}
                  {new Date(request.expiresAt).toLocaleTimeString()}。
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act('input')}
                >
                  发送进程输入
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act('input', 'eof')}
                >
                  结束输入（EOF）
                </button>
              </div>
            )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
