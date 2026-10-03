'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Button,
  IconSettingsOutlineMedium,
  Switch,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { ConnectedApps } from '../workspace/mcp/connected-apps';
import { SettingsPanel } from './dsh-upstream/settings/SettingsRoot';
import native from './dsh-upstream/settings/SettingsRoot.module.css';
import { MonthlyQuota } from './monthly-quota';
import { StorageUsage } from './storage-usage';
import { AccountPasswordSettings } from './account-password-settings';
import { ExperiencePanel } from '../workspace/experience/experience-panel';
import { ComputerSettings } from './computer-settings';
import { BridgeSettings } from './bridge-dialog';
import type { useBridge } from './use-bridge';
import type { useBridgeReleases } from './bridge-releases';
import { WorkAutomationSettings } from './work-automation-settings';
import type { useMonthlyQuota } from './use-monthly-quota';
import type { usePersonalPreferences } from './use-personal-preferences';
import styles from './sidebar-settings.module.css';

export function SidebarSettings({
  experienceEnabled = false,
  sessionId,
  capabilities,
  collapsed,
  workspaceId,
  monthlyQuota,
  preferences,
  providerLabel,
  section,
  onSectionChange,
  onBridge,
  bridge,
  bridgeReleases,
}: {
  experienceEnabled?: boolean;
  sessionId?: string;
  capabilities: ReactNode;
  collapsed: boolean;
  workspaceId: string;
  monthlyQuota: ReturnType<typeof useMonthlyQuota>;
  preferences: ReturnType<typeof usePersonalPreferences>;
  providerLabel: string;
  section: string | null;
  onSectionChange: (section: string | null) => void;
  onBridge: () => void;
  bridge: ReturnType<typeof useBridge>;
  bridgeReleases: ReturnType<typeof useBridgeReleases>;
}) {
  const [visited, setVisited] = useState(() => new Set(['account']));
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const backButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (section === 'computer' && bridge.bridgeOpen) {
      backButton.current?.focus();
      backButton.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [section, bridge.bridgeOpen]);
  async function logout() {
    setLoggingOut(true);
    setLogoutError('');
    try {
      const response = await fetch('/api/v1/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error('logout_failed');
      window.location.replace('/login');
    } catch {
      setLogoutError('退出登录失败，请重试。');
      setLoggingOut(false);
    }
  }
  const rows = [
    { id: 'account', label: '账号与用量' },
    { id: 'work', label: '员工工作方式' },
    { id: 'capabilities', label: '能力与环境' },
    { id: 'apps', label: '已连接应用' },
    { id: 'computer', label: '我的电脑' },
    ...(experienceEnabled ? [{ id: 'experience', label: '记忆与经验' }] : []),
    { id: 'preferences', label: '个人偏好' },
  ];
  const close = () => onSectionChange(null);
  return (
    <>
      <div
        className={`${native.triggerRow} ${collapsed ? native.railRow : ''}`}
      >
        <button
          type="button"
          className={`${native.trigger} ${collapsed ? native.rail : ''}`}
          aria-label="设置"
          title="设置"
          aria-haspopup="dialog"
          aria-expanded={section !== null}
          onClick={() => {
            onSectionChange('account');
            void monthlyQuota.reload();
          }}
        >
          <IconSettingsOutlineMedium size={20} />
          {!collapsed && <span className={native.triggerLabel}>设置</span>}
        </button>
      </div>
      {section !== null && (
        <SettingsPanel
          rows={rows}
          activeId={section}
          onSelect={(id) => {
            if (id === 'preferences') void preferences.reload();
            setVisited((current) => new Set([...current, section, id]));
            onSectionChange(id);
          }}
          onClose={close}
          renderSlot={(name, _props, options) => {
            if (name === 'settings.header') return '设置';
            if (name === 'settings.close') return '关闭设置';
            if (name !== 'settings.section') return null;
            return rows
              .filter((row) => visited.has(row.id) || row.id === section)
              .map((row) => (
                <div
                  key={row.id}
                  hidden={row.id !== options?.only}
                  className={styles.section}
                >
                  {row.id === 'computer' && bridge.bridgeOpen ? (
                    <div className={styles.computerChildHeading}>
                      <button
                        data-computer-control
                        ref={backButton}
                        className={styles.computerBack}
                        type="button"
                        aria-label="返回我的电脑"
                        onClick={() => {
                          onSectionChange('computer');
                          requestAnimationFrame(() =>
                            document
                              .querySelector<HTMLButtonElement>(
                                '[data-computer-management-entry]',
                              )
                              ?.focus(),
                          );
                        }}
                      >
                        <span aria-hidden="true">←</span>
                      </button>
                      <h2>连接与管理电脑</h2>
                    </div>
                  ) : (
                    <h2
                      className={
                        row.id === 'computer'
                          ? styles.computerHeading
                          : undefined
                      }
                    >
                      {row.label}
                    </h2>
                  )}
                  {row.id === 'capabilities' && capabilities}
                  {row.id === 'preferences' && (
                    <>
                      <div className={styles.preferenceRow}>
                        <div>
                          <h3>流式输出</h3>
                          <p>实时展示文字和阶段性回复；关闭后统一展示。</p>
                        </div>
                        <Switch
                          label="流式输出"
                          checked={preferences.value.streamingOutput}
                          disabled={
                            preferences.pending || !preferences.available
                          }
                          onChange={(value) =>
                            void preferences.setStreamingOutput(value)
                          }
                        />
                      </div>
                      <p className={styles.preferenceHint}>
                        仅影响你的回复展示方式，所有员工通用。工作状态和用时始终实时更新。
                      </p>
                      <p role="status" className={styles.preferenceHint}>
                        {preferences.pending
                          ? '正在同步偏好…'
                          : `当前：${preferences.value.streamingOutput ? '流式输出' : '统一输出'}`}
                      </p>
                      {preferences.error && (
                        <p role="alert">
                          {preferences.error}
                          <button
                            type="button"
                            onClick={() => void preferences.reload()}
                          >
                            重新读取
                          </button>
                        </p>
                      )}
                    </>
                  )}
                  {row.id === 'account' && (
                    <>
                      <div className={styles.accountActions}>
                        <span
                          className={styles.accountAvatar}
                          aria-hidden="true"
                        >
                          {(monthlyQuota.data?.displayName ?? 'U')
                            .slice(0, 1)
                            .toUpperCase()}
                        </span>
                        <div className={styles.accountIdentity}>
                          <strong>
                            {monthlyQuota.data?.displayName ?? '当前账号'}
                          </strong>
                          <p>管理你的账号与使用情况</p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={loggingOut}
                          onClick={() => void logout()}
                        >
                          {loggingOut ? '正在退出…' : '退出登录'}
                        </Button>
                      </div>
                      {logoutError && <p role="alert">{logoutError}</p>}
                      <MonthlyQuota
                        expanded
                        providerLabel={providerLabel}
                        data={monthlyQuota.data}
                        failed={monthlyQuota.failed}
                        onRefresh={() => void monthlyQuota.reload()}
                      />
                      <AccountPasswordSettings />
                      <StorageUsage workspaceId={workspaceId} />
                    </>
                  )}
                  {/* Bridge 工具随客户端提供；应用设置只管理远端连接。 */}
                  {row.id === 'apps' && (
                    <ConnectedApps workspaceId={workspaceId} />
                  )}
                  {row.id === 'experience' && (
                    <ExperiencePanel
                      workspaceId={workspaceId}
                      sessionId={sessionId}
                      embedded
                    />
                  )}
                  {row.id === 'work' && (
                    <WorkAutomationSettings
                      key={workspaceId}
                      workspaceId={workspaceId}
                    />
                  )}
                  {row.id === 'computer' && (
                    <>
                      <div hidden={bridge.bridgeOpen}>
                        <ComputerSettings
                          workspaceId={workspaceId}
                          active={section === 'computer' && !bridge.bridgeOpen}
                          onBridge={onBridge}
                          bridge={bridge}
                        />
                      </div>
                      {bridge.bridgeOpen && (
                        <BridgeSettings
                          bridge={bridge}
                          releases={bridgeReleases}
                        />
                      )}
                    </>
                  )}
                </div>
              ));
          }}
        />
      )}
    </>
  );
}
