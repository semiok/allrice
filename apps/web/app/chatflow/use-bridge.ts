'use client';

import { useCallback, useEffect, useState } from 'react';

import type { BridgeDevice, Workspace } from './chatflow-types';
import { readJson } from './chatflow-utils';

type UseBridgeOptions = {
  setError: (message: string) => void;
  tenantHeaders: Record<string, string>;
  workspace: Workspace | null;
};

type BridgePairing = {
  id: string;
  code: string;
  deviceName: string;
  expiresAt: string;
};

type BridgeFeedback = {
  kind: 'info' | 'error';
  message: string;
};

export function useBridge({
  setError,
  tenantHeaders,
  workspace,
}: UseBridgeOptions) {
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const [bridgeDevices, setBridgeDevices] = useState<BridgeDevice[]>([]);
  const [bridgePairing, setBridgePairing] = useState<BridgePairing | null>(
    null,
  );
  const [bridgePairingBusy, setBridgePairingBusy] = useState(false);
  const [bridgeFeedback, setBridgeFeedback] = useState<BridgeFeedback | null>(
    null,
  );
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

  const createBridgePairing = useCallback(async () => {
    if (!workspace) return;
    setBridgePairingBusy(true);
    setBridgeFeedback({ kind: 'info', message: '正在生成租户专属配对码…' });
    try {
      const result = await readJson<{ pairing: BridgePairing }>(
        await fetch('/api/v1/bridge/pairings', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...tenantHeaders },
          body: JSON.stringify({
            workspaceId: workspace.workspaceId,
            deviceName: 'Rice Bridge',
          }),
        }),
      );
      setBridgePairing(result.pairing);
      setBridgeFeedback({
        kind: 'info',
        message: '配对码已生成，10 分钟内有效。',
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '配对码生成失败';
      setBridgeFeedback({ kind: 'error', message });
      setError(message);
    } finally {
      setBridgePairingBusy(false);
    }
  }, [setError, tenantHeaders, workspace]);

  const noteBridgeDownload = useCallback((label: string) => {
    setBridgeFeedback({
      kind: 'info',
      message: `${label}下载已开始，请查看浏览器下载列表。`,
    });
  }, []);

  const copyBridgePairingCode = useCallback(
    async (code: string) => {
      const compactCode = code.replaceAll('-', '');
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(compactCode);
        } else {
          const input = document.createElement('textarea');
          input.value = compactCode;
          input.style.position = 'fixed';
          input.style.opacity = '0';
          document.body.append(input);
          input.select();
          const copied = document.execCommand('copy');
          input.remove();
          if (!copied) throw new Error('copy_failed');
        }
        setBridgeFeedback({ kind: 'info', message: '配对码已复制。' });
      } catch {
        const message = '复制失败，请手动选择配对码';
        setBridgeFeedback({ kind: 'error', message });
        setError(message);
      }
    },
    [setError],
  );

  useEffect(() => {
    if (!workspace) {
      setBridgeDevices([]);
      setBridgePairing(null);
      setBridgeFeedback(null);
      return;
    }
    void loadBridgeDevices(false, true);
    const timer = window.setInterval(() => {
      void loadBridgeDevices(false, true);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [loadBridgeDevices, workspace]);

  useEffect(() => {
    setBridgePairing(null);
    setBridgeFeedback(null);
  }, [workspace?.workspaceId]);

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
    bridgeFeedback,
    bridgeOpen,
    bridgePairing,
    bridgePairingBusy,
    bridgeRecoveryActive,
    copyBridgePairingCode,
    createBridgePairing,
    disconnectBridgeWorkspace,
    loadBridgeDevices,
    noteBridgeDownload,
    requestBridgeWorkspaceSelection,
    setBridgeOpen,
  };
}
