'use client';

import { useCallback, useEffect, useState } from 'react';

import type { BridgeDevice, Workspace } from './chatflow-types';
import { readJson } from './chatflow-utils';

type UseBridgeOptions = {
  setError: (message: string) => void;
  tenantHeaders: Record<string, string>;
  workspace: Workspace | null;
};

export function useBridge({
  setError,
  tenantHeaders,
  workspace,
}: UseBridgeOptions) {
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const [bridgeDevices, setBridgeDevices] = useState<BridgeDevice[]>([]);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [bridgeRecoveryActive, setBridgeRecoveryActive] = useState(false);

  const loadBridgeDevices = useCallback(
    async (open = false, quiet = false) => {
      if (!workspace) return;
      if (!quiet) setBridgeBusy(true);
      try {
        const result = await readJson<{ devices: BridgeDevice[] }>(
          await fetch(
            `/api/v1/bridge/devices?workspaceId=${workspace.workspaceId}`,
            { cache: 'no-store', headers: tenantHeaders },
          ),
        );
        setBridgeDevices(result.devices);
        if (
          result.devices.some(
            (device) =>
              device.status === 'online' && device.folderGrants.length > 0,
          )
        ) {
          setBridgeRecoveryActive(false);
        }
        if (open) setBridgeOpen(true);
      } catch (cause) {
        if (!quiet) {
          setError(
            cause instanceof Error ? cause.message : '本地电脑状态加载失败',
          );
        }
      } finally {
        if (!quiet) setBridgeBusy(false);
      }
    },
    [setError, tenantHeaders, workspace],
  );

  const disconnectBridgeWorkspace = useCallback(
    async (device: BridgeDevice) => {
      if (!workspace) return;
      setBridgeBusy(true);
      try {
        await Promise.all(
          device.folderGrants.map(async (grant) => {
            await readJson(
              await fetch(
                `/api/v1/bridge/grants/${grant.id}?workspaceId=${workspace.workspaceId}`,
                { method: 'DELETE', headers: tenantHeaders },
              ),
            ).catch((cause) => {
              if (cause instanceof SyntaxError) return null;
              throw cause;
            });
          }),
        );
        setBridgeRecoveryActive(false);
        await loadBridgeDevices();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '工作区断开失败');
      } finally {
        setBridgeBusy(false);
      }
    },
    [loadBridgeDevices, setError, tenantHeaders, workspace],
  );

  const requestBridgeWorkspaceSelection = useCallback(
    async (device: BridgeDevice) => {
      if (!workspace) return;
      setBridgeBusy(true);
      setBridgeRecoveryActive(true);
      try {
        await readJson(
          await fetch(
            `/api/v1/bridge/devices/${device.id}/workspace-selection?workspaceId=${workspace.workspaceId}`,
            { method: 'POST', headers: tenantHeaders },
          ),
        );
      } catch (cause) {
        setBridgeRecoveryActive(false);
        setError(
          cause instanceof Error ? cause.message : '无法打开本地文件夹选择器',
        );
      } finally {
        setBridgeBusy(false);
      }
    },
    [setError, tenantHeaders, workspace],
  );

  const downloadBridgeClient = useCallback(async () => {
    setBridgeBusy(true);
    try {
      const response = await fetch('/api/v1/bridge/client/macos-arm64', {
        headers: tenantHeaders,
      });
      if (!response.ok) await readJson(response);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'RiceBridge-v0.2.zip';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'RiceBridge 下载失败');
    } finally {
      setBridgeBusy(false);
    }
  }, [setError, tenantHeaders]);

  useEffect(() => {
    if (!workspace) {
      setBridgeDevices([]);
      return;
    }
    void loadBridgeDevices(false, true);
    const timer = window.setInterval(() => {
      void loadBridgeDevices(false, true);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [loadBridgeDevices, workspace]);

  useEffect(() => {
    if (!bridgeRecoveryActive || !workspace) return;
    const timer = window.setInterval(() => {
      void loadBridgeDevices(false, true);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [bridgeRecoveryActive, loadBridgeDevices, workspace]);

  return {
    bridgeBusy,
    bridgeDevices,
    bridgeOpen,
    bridgeRecoveryActive,
    disconnectBridgeWorkspace,
    downloadBridgeClient,
    loadBridgeDevices,
    requestBridgeWorkspaceSelection,
    setBridgeOpen,
  };
}
