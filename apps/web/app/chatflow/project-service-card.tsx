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
}: {
  service: ProjectServiceView | null | undefined;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false),
    busyRef = useRef(false),
    [error, setError] = useState(''),
    [liveSrc, setLiveSrc] = useState<string>();
  useEffect(() => {
    setLiveSrc(undefined);
    setError('');
  }, [service?.id]);
  async function act(action: 'stop' | 'renew' | 'preview') {
    const project = service;
    if (!project || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
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
      if (action === 'preview') {
        if (!data.previewUrl) throw Error('预览地址不可用。');
        setLiveSrc(data.previewUrl);
      }
      if (action === 'stop') setLiveSrc(undefined);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未确认，请刷新状态。');
      onChanged();
    } finally {
      busyRef.current = false;
      setBusy(false);
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
  return (
    <section aria-label="项目实时预览">
      <p role="status">
        {project ? labels[project.state] : '正在准备预览'}
        {project &&
          ` · ${project.backend === 'local' ? '本地' : '云端'} · ${new Date(project.expiresAt).toLocaleTimeString()} 到期`}
      </p>
      {project && !project.stopped && (
        <p>本轮回复结束后，预览在到期前继续运行。</p>
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
