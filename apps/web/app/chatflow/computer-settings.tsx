'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  IconChevronRightOutlineRegular,
  Switch,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type {
  BridgeDevice,
  BridgeSettings,
  BridgeEnvironment,
} from '@allrice/contracts';
import styles from './sidebar-settings.module.css';
import { BrowserLoginSettings } from './browser-login-settings';
import { projectBridgeView } from './bridge-view';
import type { useBridge } from './use-bridge';

type Computer = {
  device: BridgeDevice;
  settings: BridgeSettings;
  environment: BridgeEnvironment | null;
  revision: number;
  pending: boolean;
  supported: boolean;
};
const choices = [
  {
    key: 'localCommand',
    title: '本地沙箱命令',
    description: '在独立环境运行代码和处理数据。',
    state: 'sandbox',
  },
  {
    key: 'localBrowser',
    title: '本地独立浏览器',
    description: '使用独立浏览器访问网页，不影响日常浏览器。',
    state: 'browser',
  },
  {
    key: 'development',
    title: '受控开发协作',
    description:
      '允许员工安排助手修改、测试和审查项目。需要本地沙箱和已选择的文件夹。',
    state: 'development',
  },
] as const;
async function read<T>(response: Response): Promise<T> {
  const value = await response.json();
  if (!response.ok)
    throw Error(value.error?.message ?? '电脑设置更新失败，请重试');
  return value as T;
}
export function ComputerSettings({
  workspaceId,
  active,
  onBridge,
  bridge,
}: {
  workspaceId: string;
  active: boolean;
  onBridge: () => void;
  bridge: ReturnType<typeof useBridge>;
}) {
  const [computers, setComputers] = useState<Computer[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const generation = useRef(0);
  const { loadBridgeDevices } = bridge;
  const view = projectBridgeView(
    bridge.bridgeDevices,
    bridge.bridgeStatusKnown,
  );
  useEffect(() => {
    if (active) void loadBridgeDevices(false, true);
  }, [active, loadBridgeDevices]);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const current = ++generation.current;
      const { devices } = await read<{ devices: BridgeDevice[] }>(
        await fetch(`/api/v1/bridge/devices?workspaceId=${workspaceId}`, {
          cache: 'no-store',
          signal,
        }),
      );
      const next = await Promise.all(
        devices.map(async (device) =>
          read<Computer>(
            await fetch(
              `/api/v1/bridge/devices/${device.id}/settings?workspaceId=${workspaceId}`,
              { cache: 'no-store', signal },
            ),
          ),
        ),
      );
      if (!signal?.aborted && current === generation.current)
        setComputers(next);
    },
    [workspaceId],
  );
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void refresh(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, [active, refresh]);
  useEffect(() => {
    if (
      !active ||
      busy !== null ||
      !computers?.some(
        (c) =>
          c.pending ||
          choices.some(
            (choice) => c.environment?.[choice.state] === 'preparing',
          ),
      )
    )
      return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void refresh(controller.signal).catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    }, 1500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, busy, computers, refresh]);
  async function toggle(
    computer: Computer,
    capability: keyof BridgeSettings,
    enabled: boolean,
  ) {
    if (busy) return;
    ++generation.current;
    setBusy(computer.device.id);
    setError('');
    try {
      const next = await read<Computer>(
        await fetch(
          `/api/v1/bridge/devices/${computer.device.id}/settings?workspaceId=${workspaceId}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ capability, enabled }),
          },
        ),
      );
      setComputers(
        (old) =>
          old?.map((c) => (c.device.id === next.device.id ? next : c)) ?? [
            next,
          ],
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '设置未保存，请重试');
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className={styles.computerPage}>
      <p className={styles.computerIntro}>设置员工的本地权限和浏览器偏好。</p>
      <button
        data-computer-control
        data-computer-management-entry
        type="button"
        className={styles.computerManagementEntry}
        onClick={onBridge}
        aria-label="连接与管理电脑"
      >
        <span className={styles.computerManagementCopy}>
          <span>连接与管理电脑</span>
          <small>设备、授权文件夹和安装更新</small>
        </span>
        <span className={styles.computerStatuses} aria-live="polite">
          <span>
            <span>Bridge</span>
            <span data-ready={view.bridgeConnectionState === 'online'}>
              {view.bridgeConnectionState === 'unknown'
                ? '待确认'
                : view.bridgeConnectionState === 'online'
                  ? '在线'
                  : '离线'}
            </span>
          </span>
          <span>
            <span>文件夹</span>
            <span data-ready={view.localWorkspaceOnline === true}>
              {view.bridgeConnectionState === 'unknown'
                ? '待确认'
                : view.localWorkspaceOnline
                  ? '已连接'
                  : '未连接'}
            </span>
          </span>
        </span>
        <IconChevronRightOutlineRegular size={16} />
      </button>
      {error && <p role="alert">{error}</p>}
      {!computers && !error && <p role="status">正在读取电脑状态…</p>}
      {computers?.length === 0 && (
        <p className={styles.preferenceRow}>
          还没有连接电脑。安装并配对 Bridge 后，可在这里管理 Bridge 能力。
        </p>
      )}
      {computers?.map((computer) => (
        <section
          key={computer.device.id}
          className={styles.computerPermissions}
          aria-label={computer.device.name}
        >
          <h3>
            {computers.length > 1 ? computer.device.name : '员工使用权限'}
          </h3>
          {computer.pending && (
            <p role="status">
              {computer.device.status === 'online'
                ? '正在同步到电脑…'
                : '设置已保存，电脑上线后自动同步。'}
            </p>
          )}
          {!computer.supported && <p>请更新 Bridge 后使用这些开关。</p>}
          {!computer.pending && computer.environment?.paused && (
            <p>Bridge 已整体暂停，请在本机恢复连接。</p>
          )}
          {choices.map((choice) => {
            const state = computer.environment?.[choice.state];
            const status = !computer.settings[choice.key]
              ? '已关闭'
              : computer.pending
                ? '等待同步'
                : computer.device.status !== 'online'
                  ? '电脑离线'
                  : computer.environment?.paused
                    ? 'Bridge 已暂停'
                    : choice.key === 'development' &&
                        !computer.settings.localCommand
                      ? '需要开启本地沙箱命令'
                      : state === 'ready'
                        ? '可用'
                        : state === 'preparing'
                          ? '正在准备'
                          : state === 'unavailable'
                            ? '环境尚未就绪'
                            : '已开启';
            return (
              <div key={choice.key} className={styles.capabilitySetting}>
                <div>
                  <strong>{choice.title}</strong>
                  <p>{choice.description}</p>
                  <small>{status}</small>
                </div>
                <Switch
                  label={choice.title}
                  checked={computer.settings[choice.key]}
                  disabled={busy !== null || !computer.supported}
                  onChange={(enabled) =>
                    void toggle(computer, choice.key, enabled)
                  }
                />
              </div>
            );
          })}
          {computer.environment?.browserDefaultsVersion === 1 ? (
            <BrowserLoginSettings
              workspaceId={workspaceId}
              deviceId={computer.device.id}
              active={active}
            />
          ) : (
            <p>
              更新 Bridge
              后，浏览器将默认保留登录，文件和运行时长使用平台统一规则。
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
