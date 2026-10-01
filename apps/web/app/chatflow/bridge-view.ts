import type { BridgeDevice } from './chatflow-types';

const readinessLabels = {
  unsupported: '尚未就绪',
  preparing: '准备中',
  ready: '可用',
  busy: '忙碌',
  paused: '已暂停',
  offline: '离线',
};
const readinessReasons: Record<string, string> = {
  ready: '已通过当前环境检查。',
  local_busy: '等待本机已有任务完成。',
  runtime_preparing: '正在准备运行环境，新任务等待本机。',
  settings_pending: '正在应用电脑能力设置。',
  folder_missing: '需要选择文件夹。',
  folder_unavailable: '所选文件夹已移动或无法访问。',
  folder_read_only: '所选文件夹不可写。',
  git_missing: '尚未检测到 Git。',
  device_paused: 'Bridge 已暂停。',
  capability_paused: '此能力已暂停。',
  bridge_offline: '请打开本机 Bridge。',
  browser_unavailable: '独立浏览器未通过检查。',
  sandbox_not_installed: '本机计算环境尚未安装。',
  sandbox_unavailable: '本机计算环境未通过检查。',
  local_mcp_disabled: '本机应用运行环境尚未启用。',
  office_not_implemented: '本地 Office 执行尚未交付；现有云端 Office 可用。',
  readiness_not_reported: '此客户端未报告能力状态。',
  legacy_ready: '旧客户端报告可用，详细版本尚未提供。',
  legacy_unavailable: '旧客户端报告环境不可用。',
  legacy_preparing: '旧客户端正在准备环境。',
  legacy_paused: '旧客户端已暂停此能力。',
  legacy_unreported: '旧客户端未报告此运行环境。',
};

export function bridgeCapabilityRows(device: BridgeDevice) {
  const names = [
    ['local.fs.read', '文件读取'],
    ['local.fs.write', '文件修改'],
    ['local.git.status', 'Git 读取'],
    ['local.browser', '独立浏览器'],
    ['local.process', '本机沙箱计算'],
    ['local.development', '项目开发'],
    ['local.preview', '项目预览'],
    ['local.mcp', '本机应用'],
    ['local.office', '本地 Office'],
  ] as const;
  return names.flatMap(([capability, label]) => {
    const report = device.readiness?.find(
      (item) => item.capability === capability,
    );
    return report
      ? [
          {
            capability,
            label,
            stateLabel: readinessLabels[report.state],
            reason:
              readinessReasons[report.reason] ??
              `环境检查未通过（${report.reason}）`,
            version: Object.entries(report.versions)
              .map(([name, version]) => `${name} ${version}`)
              .join(' · '),
          },
        ]
      : [];
  });
}

export type BridgeConnectionState = 'online' | 'offline' | 'unknown';

/** Connection presence and folder authorization are independent states. */
export function projectBridgeView(devices: BridgeDevice[], statusKnown = true) {
  const active = statusKnown
    ? devices.filter((device) => device.status !== 'revoked')
    : [];
  const onlineBridgeDevice = active.find(
    (device) => device.status === 'online',
  );
  const selectedBridgeDevice =
    active.find(
      (device) => device.status === 'online' && device.folderGrants.length > 0,
    ) ?? active.find((device) => device.folderGrants.length > 0);
  const localWorkspaceOnline = selectedBridgeDevice?.status === 'online';
  return {
    onlineBridgeDevice,
    selectedBridgeDevice,
    localWorkspaceOnline,
    // A remembered offline grant is not a currently connected local workspace.
    localWorkspaceLabel: localWorkspaceOnline
      ? selectedBridgeDevice?.folderGrants[0]?.label
      : undefined,
    bridgeConnectionState: (statusKnown
      ? onlineBridgeDevice
        ? 'online'
        : 'offline'
      : 'unknown') as BridgeConnectionState,
  };
}

export function bridgeComposerStatus(
  connection: BridgeConnectionState,
  localWorkspaceOnline: boolean,
  localWorkspaceLabel?: string,
) {
  if (connection === 'unknown') {
    return {
      label: 'Bridge 状态待确认',
      ariaLabel: 'Bridge 状态待确认',
      title: '尚未取得最新状态，请刷新确认；上次状态不代表当前连接',
      online: false,
    };
  }
  if (connection === 'offline') {
    return {
      label: 'Bridge 离线',
      ariaLabel: 'Bridge 离线',
      title: '服务器未收到近期 Bridge 心跳，请确认本地 Bridge 正在运行',
      online: false,
    };
  }
  if (localWorkspaceOnline && localWorkspaceLabel) {
    return {
      label: localWorkspaceLabel,
      ariaLabel: `本地工作区 ${localWorkspaceLabel}`,
      title: `Rice Bridge 在线，本地工作区已连接：${localWorkspaceLabel}`,
      online: true,
    };
  }
  return {
    label: 'Bridge 在线 · 未选择工作区',
    ariaLabel: 'Bridge 在线 · 未选择工作区',
    title: 'Rice Bridge 在线；选择并授权本地文件夹后，才能连接本地工作区',
    online: true,
  };
}
