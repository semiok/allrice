'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { BridgeRefreshCoordinator } from './bridge-refresh';
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
  const [bridgeSnapshot, setBridgeSnapshot] = useState<{
    scope: string;
    devices: BridgeDevice[];
    known: boolean;
    refreshedAt: string | null;
    error: string | null;
  } | null>(null);
  const refresh = useRef(new BridgeRefreshCoordinator());
  const workspaceId = workspace?.workspaceId;
  const scope = JSON.stringify([
    workspaceId ?? null,
    Object.entries(tenantHeaders).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ]);
  const currentSnapshot =
    bridgeSnapshot?.scope === scope ? bridgeSnapshot : null;
  const bridgeDevices = currentSnapshot?.devices ?? [];
  const bridgeStatusKnown = currentSnapshot?.known ?? false;
  const bridgeLastRefreshedAt = currentSnapshot?.refreshedAt ?? null;
  const bridgeRefreshError = currentSnapshot?.error ?? null;
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
      if (!workspaceId) return;
      const request = refresh.current.start(scope, !quiet);
      if (!request) return;
      if (open) setBridgeOpen(true);
      if (!quiet) setBridgeBusy(true);
      const timeout = window.setTimeout(
        () => request.controller.abort(),
        20_000,
      );
      try {
        const result = await readJson<{ devices: BridgeDevice[] }>(
          await fetch(`/api/v1/bridge/devices?workspaceId=${workspaceId}`, {
            cache: 'no-store',
            headers: tenantHeaders,
            signal: request.controller.signal,
          }),
        );
        if (!refresh.current.isCurrent(request)) return;
        setBridgeSnapshot({
          scope,
          devices: result.devices,
          known: true,
          refreshedAt: new Date().toISOString(),
          error: null,
        });
        if (
          result.devices.some(
            (device) =>
              device.status === 'online' && device.folderGrants.length > 0,
          )
        ) {
          setBridgeRecoveryActive(false);
        }
      } catch (cause) {
        if (!refresh.current.isCurrent(request)) return;
        const message = request.controller.signal.aborted
          ? 'Bridge 状态刷新超时，请重试'
          : cause instanceof Error
            ? cause.message
            : '本地电脑状态加载失败';
        setBridgeSnapshot((previous) => ({
          scope,
          devices: previous?.scope === scope ? previous.devices : [],
          known: false,
          refreshedAt: previous?.scope === scope ? previous.refreshedAt : null,
          error: message,
        }));
      } finally {
        window.clearTimeout(timeout);
        if (refresh.current.isCurrent(request)) {
          if (!quiet) setBridgeBusy(false);
          refresh.current.finish(request);
        }
      }
    },
    [scope, tenantHeaders, workspaceId],
  );

  const disconnectBridgeWorkspace = useCallback(
    async (device: BridgeDevice) => {
      if (!workspace) return;
      const inScope = refresh.current.capture(scope);
      if (!inScope) return;
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
        if (!inScope()) return;
        setBridgeRecoveryActive(false);
        await loadBridgeDevices();
      } catch (cause) {
        if (!inScope()) return;
        setError(cause instanceof Error ? cause.message : '工作区断开失败');
      } finally {
        if (inScope()) setBridgeBusy(false);
      }
    },
    [loadBridgeDevices, scope, setError, tenantHeaders, workspace],
  );

  const requestBridgeWorkspaceSelection = useCallback(
    async (device: BridgeDevice) => {
      if (!workspace) return;
      const inScope = refresh.current.capture(scope);
      if (!inScope) return;
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
        if (!inScope()) return;
        setBridgeRecoveryActive(false);
        setError(
          cause instanceof Error ? cause.message : '无法打开本地文件夹选择器',
        );
      } finally {
        if (inScope()) setBridgeBusy(false);
      }
    },
    [scope, setError, tenantHeaders, workspace],
  );

  const createBridgePairing = useCallback(async () => {
    if (!workspace) return;
    const inScope = refresh.current.capture(scope);
    if (!inScope) return;
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
      if (!inScope()) return;
      setBridgePairing(result.pairing);
      setBridgeFeedback({
        kind: 'info',
        message: '配对码已生成，10 分钟内有效。',
      });
    } catch (cause) {
      if (!inScope()) return;
      const message = cause instanceof Error ? cause.message : '配对码生成失败';
      setBridgeFeedback({ kind: 'error', message });
      setError(message);
    } finally {
      if (inScope()) setBridgePairingBusy(false);
    }
  }, [scope, setError, tenantHeaders, workspace]);

  const noteBridgeDownload = useCallback((label: string) => {
    setBridgeFeedback({
      kind: 'info',
      message: `${label}下载已开始，请查看浏览器下载列表。`,
    });
  }, []);

  const copyBridgePairingCode = useCallback(
    async (code: string) => {
      const inScope = refresh.current.capture(scope);
      if (!inScope) return;
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
        if (inScope())
          setBridgeFeedback({ kind: 'info', message: '配对码已复制。' });
      } catch {
        if (!inScope()) return;
        const message = '复制失败，请手动选择配对码';
        setBridgeFeedback({ kind: 'error', message });
        setError(message);
      }
    },
    [scope, setError],
  );

  useEffect(() => {
    refresh.current.reset(scope);
    setBridgeBusy(false);
    if (!workspaceId) {
      setBridgeSnapshot(null);
      setBridgePairing(null);
      setBridgeFeedback(null);
      return;
    }
    void loadBridgeDevices(false, true);
    const timer = window.setInterval(() => {
      void loadBridgeDevices(false, true);
    }, 15_000);
    const coordinator = refresh.current;
    return () => {
      window.clearInterval(timer);
      coordinator.reset(null);
    };
  }, [loadBridgeDevices, scope, workspaceId]);

  useEffect(() => {
    setBridgePairing(null);
    setBridgeFeedback(null);
    setBridgePairingBusy(false);
    setBridgeRecoveryActive(false);
  }, [scope]);

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
    bridgeStatusKnown,
    bridgeLastRefreshedAt,
    bridgeRefreshError,
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
