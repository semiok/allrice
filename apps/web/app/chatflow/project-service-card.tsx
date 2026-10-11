'use client';
import { useEffect, useRef, useState } from 'react';
import {
  ProjectServiceViewSchema,
  type ProjectServiceView,
} from '@allrice/contracts';
import { NativeHtmlPreview } from './native-html-preview';
/** Shared local/cloud identity, lease, stop and preview controls. */
export function ProjectServiceCard({
  service,
  workspaceId,
  tenantHeaders,
  onChanged,
  controlEndpoint,
}: {
  service: ProjectServiceView | null | undefined;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  onChanged: () => void;
  /** Server-defined private admin composition; ordinary callers keep the
   * existing endpoint and the same service/lease/preview presentation. */
  controlEndpoint?: string;
}) {
  const [busy, setBusy] = useState(false),
    busyRef = useRef(false),
    [error, setError] = useState(''),
    [liveSrc, setLiveSrc] = useState<string>();
  const identity = `${service?.id ?? ''}|${controlEndpoint ?? workspaceId}`;
  const currentIdentity = useRef(identity),
    mounted = useRef(false);
  currentIdentity.current = identity;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    busyRef.current = false;
    setBusy(false);
    setLiveSrc(undefined);
    setError('');
  }, [identity]);
  async function act(action: 'stop' | 'renew' | 'preview') {
    const project = service;
    if (!project || busyRef.current) return;
    const isCurrent = () =>
      mounted.current && currentIdentity.current === identity;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        controlEndpoint ??
          `/api/v1/runtime/project-services?workspaceId=${encodeURIComponent(workspaceId)}&serviceId=${project.id}`,
        {
          method: 'POST',
          headers: { ...tenantHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({
            action,
            ...(action === 'renew'
              ? { requestId: crypto.randomUUID(), leaseMs: 600000 }
              : {}),
          }),
        },
      );
      if (!response.ok) throw Error('服务已停止或暂不可用，请刷新状态。');
      const data = (await response.json()) as {
        service: unknown;
        previewUrl?: string;
      };
      ProjectServiceViewSchema.parse(data.service);
      if (!isCurrent()) return;
      if (action === 'preview') {
        if (!data.previewUrl) throw Error('预览地址不可用。');
        setLiveSrc(data.previewUrl);
      }
      if (action === 'stop') setLiveSrc(undefined);
      onChanged();
    } catch (e) {
      if (!isCurrent()) return;
      setError(e instanceof Error ? e.message : '操作未确认，请刷新状态。');
      onChanged();
    } finally {
      if (isCurrent()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  const project = service;
  const labels: Record<string, string> = {
    starting: '正在启动',
    ready: '预览已就绪',
    offline: project?.backend === 'cloud' ? '预览暂未连接' : '电脑暂未连接',
    stopping: '正在停止',
    stopped: '已停止',
    failed: '未能完成',
    unknown: '状态待核实',
  };
  const available = project?.state === 'ready' && !project.stopRequested;
  const stopLabels: Record<
    NonNullable<ProjectServiceView['stopReason']>,
    string
  > = {
    user_requested: '已按请求停止预览。',
    lease_expired: '预览租期已结束。',
    authority_changed: '运行权限或项目状态发生变化，预览已停止。',
    connection_lost: '预览连接中断，服务已停止。',
    control_timeout: '预览控制请求超时，服务已停止。',
    guard_lost: '预览运行保护已断开，服务已停止。',
    worker_shutdown: '运行服务已重启或关闭，预览已停止。',
    source_update_failed: '源码同步未能完成，预览已停止。',
    process_exited: '预览进程已退出。',
    unknown: '未记录具体停止原因。',
  };
  return (
    <section aria-label="项目实时预览">
      <p role="status">
        {project ? labels[project.state] : '正在准备预览'}
        {project &&
          ` · ${project.backend === 'local' ? '本地' : '云端'} · ${new Date(project.expiresAt).toLocaleTimeString()} 到期`}
      </p>
      {project && !project.stopped && !project.stopRequested && (
        <p>本轮回复结束后，预览在到期前继续运行。</p>
      )}
      {project?.stopReason && project.stopped && (
        <p>
          {stopLabels[project.stopReason]}
          {project.stopped &&
            ' 已保存的源码和成果仍可下载；需要预览时，可让 AI 从这个项目重新启动。'}
        </p>
      )}
      {project?.stopRequested && !project.stopped && (
        <p>已请求停止预览，正在等待运行环境确认。</p>
      )}
      <button
        type="button"
        disabled={busy || !available}
        onClick={() => void act('preview')}
      >
        {liveSrc ? '刷新预览' : '打开预览'}
      </button>
      <button
        type="button"
        disabled={busy || !project?.canRenew}
        onClick={() => void act('renew')}
      >
        继续 10 分钟
      </button>
      <button
        type="button"
        disabled={busy || !project || project.stopped || project.stopRequested}
        onClick={() => void act('stop')}
      >
        停止预览
      </button>
      {project?.updatePending && <p>正在同步最新源码…</p>}
      {liveSrc && available && (
        <div style={{ height: 480 }}>
          <NativeHtmlPreview liveSrc={liveSrc} />
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
