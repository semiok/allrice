import type { BridgeDevice } from './chatflow-types';
import type { BridgePreparationProgress } from '@allrice/contracts';

export function bridgePreparationLabel(progress: BridgePreparationProgress) {
  const phases = {
    preparing: '正在准备',
    downloading: '正在下载',
    verifying: '正在校验',
    retrying: '正在重试',
    installing: '正在安装',
    ready: '可用',
    failed: '准备未完成',
  };
  const bytes = progress.expectedBytes
    ? ` · ${(progress.receivedBytes / 1024 ** 2).toFixed(1)} / ${(progress.expectedBytes / 1024 ** 2).toFixed(1)} MB`
    : '';
  const failures: Record<string, string> = {
    RUNTIME_DOWNLOAD_STALLED: '下载长时间没有进展',
    RUNTIME_DOWNLOAD_BUDGET_EXCEEDED: '本次下载等待时间已用尽',
    RUNTIME_DOWNLOAD_CONNECTION_FAILED: '下载连接中断',
    RUNTIME_DOWNLOAD_UNAVAILABLE: '暂时无法下载',
    RUNTIME_CHECKSUM_MISMATCH: '下载校验未通过',
    RUNTIME_DISK_SPACE_REQUIRED: '需要更多可用空间',
    RUNTIME_DOWNLOAD_RANGE_INVALID: '下载响应不完整',
  };
  return `${progress.stage === 'failed' ? (failures[progress.reason ?? ''] ?? phases.failed) : phases[progress.stage]}${progress.stage === 'ready' ? '' : bytes}${progress.attempt > 1 ? ` · 第 ${progress.attempt} 次尝试` : ''}${progress.resumed && progress.stage === 'downloading' ? ' · 续传中' : ''}`;
}

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
  git_missing: '电脑上还没有安装 Git。',
  device_paused: 'AllRice 助手已暂停。',
  capability_paused: '此能力已暂停。',
  bridge_offline: '请打开电脑上的 AllRice 助手。',
  browser_unavailable: '独立浏览器未通过检查。',
  sandbox_not_installed: '本机计算环境尚未安装。',
  sandbox_unavailable: '本机计算环境未通过检查。',
  local_mcp_disabled: '本机应用运行环境尚未启用。',
  office_not_implemented:
    '暂不支持在电脑上处理 Office 文件，可以先用云端处理。',
  readiness_not_reported: '当前版本没有提供这项状态，请更新 AllRice 助手。',
  legacy_ready: '可用。更新 AllRice 助手后能看到更详细的状态。',
  legacy_unavailable: '暂不可用，请更新 AllRice 助手后再试。',
  legacy_preparing: '正在准备环境。',
  legacy_paused: '此能力已暂停。',
  legacy_unreported:
    'AllRice 助手版本较旧，没有提供这项状态，请更新到最新版本。',
};

/** Pairing names end in the app name (old pairings: Rice Bridge); people see their computer. */
export function bridgeDeviceName(name: string) {
  // r1-exempt(display): strips the app suffix the client adds to its default device name; only the shown name changes
  const computer = name.replace(/ · (?:Rice Bridge|AllRice 助手)$/, '');
  // r1-exempt(display): a name that is only the app name is shown as this computer; nothing else depends on it
  return computer.replace(/^(?:Rice Bridge|AllRice 助手)$/, '这台电脑');
}

export function bridgeCapabilityRows(device: BridgeDevice) {
  // Settings presentation only; capability reports and grants stay unchanged.
  const names = [
    ['local.fs.read', '文件读取'],
    ['local.fs.write', '文件修改'],
    ['local.git.status', '查看项目改动'],
    ['local.browser', '独立浏览器'],
    ['local.process', '本机沙箱计算'],
    ['local.development', '项目开发'],
    ['local.preview', '项目预览'],
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
            state: report.state,
            stateLabel: readinessLabels[report.state],
            reason:
              readinessReasons[report.reason] ??
              '环境检查没有通过，请刷新状态，或重新打开 AllRice 助手。',
            version: Object.entries(report.versions)
              .map(
                ([name, version]) =>
                  `${name === 'bridge' ? 'AllRice 助手' : name} ${version}`,
              )
              .join(' · '),
          },
        ]
      : [];
  });
}

export type BridgeConnectionState = 'online' | 'offline' | 'unknown';

/** A server grant is remembered authority, not proof the client can access it. */
export function bridgeWorkspaceIssue(device: BridgeDevice) {
  const read = device.readiness?.find(
    (item) => item.capability === 'local.fs.read',
  );
  if (!read || read.state === 'ready' || read.state === 'busy') return null;
  if (read.reason === 'folder_missing' && device.folderGrants.length)
    return '此电脑未保存目录授权，请重新选择文件夹。';
  if (read.reason === 'folder_unavailable')
    return '所选文件夹已移动或无法访问，请重新选择。';
  return readinessReasons[read.reason] ?? '本地文件夹暂不可访问，请刷新状态。';
}

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
      (device) =>
        device.status === 'online' &&
        device.folderGrants.length > 0 &&
        !bridgeWorkspaceIssue(device),
    ) ?? active.find((device) => device.folderGrants.length > 0);
  const localWorkspaceOnline =
    selectedBridgeDevice?.status === 'online' &&
    !bridgeWorkspaceIssue(selectedBridgeDevice);
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

/** The composer's computer status. Not connected is a normal state: neutral,
 * never red, and worded for people who never heard of Bridge. Each accessible
 * name starts with the visible words, so speaking them finds the button. */
export function bridgeComposerStatus(
  connection: BridgeConnectionState,
  localWorkspaceOnline: boolean,
  localWorkspaceLabel?: string,
) {
  if (connection === 'unknown') {
    return {
      // Also shown while status requests keep failing, so not "checking…".
      label: '电脑连接状态待确认',
      ariaLabel: '电脑连接状态待确认，点击查看电脑',
      title: '暂时没有拿到最新的连接状态，点击查看或刷新。',
      online: false,
    };
  }
  if (connection === 'offline') {
    return {
      label: '电脑未连接',
      ariaLabel: '电脑未连接，点击查看如何连接',
      title: '需要处理你电脑上的文件时，点击这里连接电脑。',
      online: false,
    };
  }
  if (localWorkspaceOnline && localWorkspaceLabel) {
    return {
      label: localWorkspaceLabel,
      ariaLabel: `电脑已连接，文件夹 ${localWorkspaceLabel}`,
      title: `电脑已连接，可以处理文件夹「${localWorkspaceLabel}」里的文件。`,
      online: true,
    };
  }
  return {
    label: '电脑已连接 · 未选文件夹',
    ariaLabel: '电脑已连接 · 未选文件夹，点击选择文件夹',
    title: '电脑已连接。选择并允许一个文件夹后，就能处理里面的文件。',
    online: true,
  };
}
