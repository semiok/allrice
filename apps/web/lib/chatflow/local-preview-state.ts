/** Presentation only; the service, frozen tool and live lease remain server-authoritative. */
export type LocalPreviewView = {
  workspaceId: string;
  endpointId: string;
  previewUrl: string;
  pending: boolean;
  operationId?: string;
};
export function localPreviewAvailability(
  input: {
    enabled: boolean;
    http: boolean;
    state: string;
    stopRequested: boolean;
    hardDeadlineAt: string;
    preview?: LocalPreviewView | null;
  },
  now = Date.now(),
) {
  const available =
    input.enabled &&
    input.http &&
    input.state === 'ready' &&
    !input.stopRequested &&
    Date.parse(input.hardDeadlineAt) > now;
  return {
    visible: input.enabled,
    canRequest: available && !input.preview?.operationId,
    label: input.preview ? '申请打开预览' : '准备项目预览',
    status: !available
      ? '服务未就绪、已停止或授权已过期，不能打开预览。'
      : input.preview?.operationId
        ? '预览导航已登记，请在浏览器工作台查看审批和执行状态。'
        : input.preview
          ? '独立浏览器正在准备；确认就绪后可申请打开预览。'
          : '只连接本次已授权服务，不开放本机端口或公共网址。',
  };
}
