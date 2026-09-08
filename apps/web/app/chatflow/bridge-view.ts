import type { BridgeDevice } from './chatflow-types';

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
