'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  Button,
  IconChevronDownOutlineRegular,
  IconPlusOutlineRegular,
  IconSettingsOutlineMedium,
  Input,
  Switch,
} from '@deepseek-ai/dsh-client-ui-primitives';
import {
  currentAppearance,
  reloadAppearance,
  setAppearance,
  subscribeAppearance,
} from '../../lib/theme/appearance';
import { ConnectedApps } from '../workspace/mcp/connected-apps';
import { SettingsPanel } from './dsh-upstream/settings/SettingsRoot';
import native from './dsh-upstream/settings/SettingsRoot.module.css';
import { MonthlyQuota } from './monthly-quota';
import { StorageUsage } from './storage-usage';
import { AccountPasswordSettings } from './account-password-settings';
import { ComputerSettings } from './computer-settings';
import { BridgeSettings } from './bridge-dialog';
import type { useBridge } from './use-bridge';
import type { useBridgeReleases } from './bridge-releases';
import { WorkAutomationSettings } from './work-automation-settings';
import type { useMonthlyQuota } from './use-monthly-quota';
import type { usePersonalPreferences } from './use-personal-preferences';
import styles from './sidebar-settings.module.css';
import preferenceStyles from './personal-preferences.module.css';

// DSH ui-theme's Appearance row: its three choices and copy.
const appearanceOptions = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
] as const;
const transcriptViewOptions = [
  { value: 'compact', label: '简洁' },
  { value: 'standard', label: '标准' },
  { value: 'detailed', label: '详细' },
  { value: 'verbose', label: '完全展开' },
] as const;
const collapseTimingOptions = [
  { value: 'completion', label: '回答结束后' },
  { value: 'next-input', label: '下次有新消息时' },
] as const;

export type SettingsSection =
  'preferences' | 'computer' | 'work' | 'apps' | 'account';

export function normalizeSettingsSection(
  section: string | null,
): SettingsSection | null {
  if (section === 'capabilities' || section === 'experience') return 'work';
  if (section === 'skills') return 'preferences';
  return section === 'preferences' ||
    section === 'computer' ||
    section === 'work' ||
    section === 'apps' ||
    section === 'account'
    ? section
    : null;
}

function PersonalPreferencesSettings({
  preferences,
}: {
  preferences: ReturnType<typeof usePersonalPreferences>;
}) {
  const id = useId();
  const [fontSizeDraft, setFontSizeDraft] = useState(
    String(preferences.value.fontSize),
  );
  const disabled = preferences.pending || !preferences.available;
  const expanded = preferences.value.transcriptView === 'verbose';
  // What the page shows: the saved choice, or one just picked and saving.
  const shown = useSyncExternalStore(
    subscribeAppearance,
    currentAppearance,
    () => null,
  );
  const appearance =
    appearanceOptions.find((option) => option.value === shown)?.value ??
    preferences.value.appearance;
  useEffect(() => {
    setFontSizeDraft(String(preferences.value.fontSize));
  }, [preferences.value.fontSize, preferences.scope, preferences.pending]);

  function saveFontSize(value: number) {
    if (disabled) return;
    const fontSize = Math.min(22, Math.max(10, value));
    setFontSizeDraft(String(fontSize));
    if (fontSize !== preferences.value.fontSize)
      void preferences.setPreferences({ fontSize });
  }
  function commitFontSize() {
    const fontSize = Number(fontSizeDraft);
    if (!fontSizeDraft.trim() || !Number.isInteger(fontSize)) {
      setFontSizeDraft(String(preferences.value.fontSize));
      return;
    }
    saveFontSize(fontSize);
  }
  function stepFontSize(direction: -1 | 1) {
    const draft = Number(fontSizeDraft);
    const current =
      fontSizeDraft.trim() && Number.isInteger(draft)
        ? Math.min(22, Math.max(10, draft))
        : preferences.value.fontSize;
    saveFontSize(current + direction);
  }

  return (
    <div className={preferenceStyles.root} aria-busy={preferences.pending}>
      <p className={preferenceStyles.lead}>调整对话的阅读和展示方式。</p>
      <div className={preferenceStyles.list}>
        <div className={preferenceStyles.row}>
          <div className={preferenceStyles.copy}>
            <h3>流式输出</h3>
            <p>实时显示文字和阶段性回复，关闭后统一展示。</p>
          </div>
          <Switch
            label="流式输出"
            checked={preferences.value.streamingOutput}
            disabled={disabled}
            onChange={(streamingOutput) => {
              if (streamingOutput !== preferences.value.streamingOutput)
                void preferences.setPreferences({ streamingOutput });
            }}
          />
        </div>
        <div className={preferenceStyles.row}>
          <div className={preferenceStyles.copy}>
            <h3>
              <label htmlFor={`${id}-appearance`}>外观</label>
            </h3>
          </div>
          <div className={preferenceStyles.select}>
            <select
              id={`${id}-appearance`}
              value={appearance}
              disabled={disabled}
              onChange={(event) => {
                const option = appearanceOptions.find(
                  (item) => item.value === event.target.value,
                );
                if (!option || option.value === appearance) return;
                // As DSH: switch this page now; if the save fails, go back to
                // what the server holds.
                const previous = appearance;
                setAppearance(option.value);
                void preferences
                  .setPreferences({ appearance: option.value })
                  .then((saved) => {
                    if (saved) return;
                    setAppearance(previous);
                    void reloadAppearance();
                  });
              }}
            >
              {appearanceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <IconChevronDownOutlineRegular size={12} />
          </div>
        </div>
        <div className={preferenceStyles.row}>
          <div className={preferenceStyles.copy}>
            <h3>
              <label htmlFor={`${id}-font-size`}>字号大小</label>
            </h3>
            <p id={`${id}-font-help`}>仅影响会话正文的字号。</p>
          </div>
          <div
            className={preferenceStyles.fontStepper}
            role="group"
            aria-label="会话正文字号"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={preferenceStyles.stepButton}
              aria-label="减小字号"
              disabled={disabled || preferences.value.fontSize <= 10}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => stepFontSize(-1)}
            >
              <span aria-hidden="true">−</span>
            </Button>
            <Input
              id={`${id}-font-size`}
              className={preferenceStyles.fontInput}
              type="number"
              inputMode="numeric"
              min={10}
              max={22}
              step={1}
              value={fontSizeDraft}
              aria-describedby={`${id}-font-help`}
              disabled={disabled}
              onChange={(event) => setFontSizeDraft(event.target.value)}
              onBlur={commitFontSize}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
            <span className={preferenceStyles.unit} aria-hidden="true">
              px
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={preferenceStyles.stepButton}
              aria-label="增大字号"
              disabled={disabled || preferences.value.fontSize >= 22}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => stepFontSize(1)}
            >
              <IconPlusOutlineRegular size={13} />
            </Button>
          </div>
        </div>
        <div className={preferenceStyles.row}>
          <div className={preferenceStyles.copy}>
            <h3>
              <label htmlFor={`${id}-transcript-view`}>工作步骤展示</label>
            </h3>
            <p id={`${id}-view-help`}>选择工具调用过程的详细程度。</p>
          </div>
          <div className={preferenceStyles.select}>
            <select
              id={`${id}-transcript-view`}
              aria-describedby={`${id}-view-help`}
              value={preferences.value.transcriptView}
              disabled={disabled}
              onChange={(event) => {
                const option = transcriptViewOptions.find(
                  (item) => item.value === event.target.value,
                );
                if (option && option.value !== preferences.value.transcriptView)
                  void preferences.setPreferences({
                    transcriptView: option.value,
                  });
              }}
            >
              {transcriptViewOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <IconChevronDownOutlineRegular size={12} />
          </div>
        </div>
        <div className={preferenceStyles.row}>
          <div className={preferenceStyles.copy}>
            <h3>
              <label htmlFor={`${id}-collapse-timing`}>工作步骤收起时机</label>
            </h3>
            <p id={`${id}-timing-help`}>
              {expanded
                ? '完全展开时，工作步骤保持展开。'
                : '选择何时自动收起已完成的步骤。'}
            </p>
          </div>
          <div className={preferenceStyles.select}>
            <select
              id={`${id}-collapse-timing`}
              aria-describedby={`${id}-timing-help`}
              value={preferences.value.collapseTiming}
              disabled={disabled || expanded}
              onChange={(event) => {
                const option = collapseTimingOptions.find(
                  (item) => item.value === event.target.value,
                );
                if (option && option.value !== preferences.value.collapseTiming)
                  void preferences.setPreferences({
                    collapseTiming: option.value,
                  });
              }}
            >
              {collapseTimingOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <IconChevronDownOutlineRegular size={12} />
          </div>
        </div>
      </div>
      {preferences.error ? (
        <div role="alert" className={preferenceStyles.error}>
          <span>{preferences.error}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={preferences.pending}
            onClick={() => void preferences.reload()}
          >
            重新读取
          </Button>
        </div>
      ) : (
        <p role="status" className={preferenceStyles.status}>
          {preferences.pending
            ? '正在同步偏好…'
            : preferences.available
              ? '自动保存，适用于你的所有 AI 员工。'
              : '个人偏好暂不可用。'}
        </p>
      )}
    </div>
  );
}

export function SidebarSettings({
  capabilities,
  collapsed,
  workspaceId,
  monthlyQuota,
  preferences,
  section,
  onSectionChange,
  onBridge,
  bridge,
  bridgeReleases,
  onCapabilitiesChange,
}: {
  experienceEnabled?: boolean;
  sessionId?: string;
  capabilities: (section: 'work' | 'computer') => ReactNode;
  collapsed: boolean;
  workspaceId: string;
  monthlyQuota: ReturnType<typeof useMonthlyQuota>;
  preferences: ReturnType<typeof usePersonalPreferences>;
  section: string | null;
  onSectionChange: (section: string | null) => void;
  onBridge: () => void;
  bridge: ReturnType<typeof useBridge>;
  bridgeReleases: ReturnType<typeof useBridgeReleases>;
  onCapabilitiesChange: () => void;
}) {
  const activeSection = normalizeSettingsSection(section);
  const [visited, setVisited] = useState(
    () => new Set<SettingsSection>(['preferences']),
  );
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const backButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (activeSection === 'computer' && bridge.bridgeOpen) {
      backButton.current?.focus();
      backButton.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeSection, bridge.bridgeOpen]);
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
  const rows: { id: SettingsSection; label: string }[] = [
    { id: 'preferences', label: '个人偏好' },
    { id: 'computer', label: '我的电脑' },
    { id: 'work', label: '工作方式' },
    { id: 'apps', label: '已链接应用' },
    { id: 'account', label: '账号与用量' },
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
          aria-expanded={activeSection !== null}
          onClick={() => {
            onSectionChange('preferences');
            void preferences.reload();
          }}
        >
          <IconSettingsOutlineMedium size={20} />
          {!collapsed && <span className={native.triggerLabel}>设置</span>}
        </button>
      </div>
      {activeSection !== null && (
        <SettingsPanel
          rows={rows}
          activeId={activeSection}
          onSelect={(id) => {
            const nextSection = normalizeSettingsSection(id);
            if (!nextSection) return;
            if (id === 'preferences') void preferences.reload();
            if (id === 'account') void monthlyQuota.reload();
            setVisited(
              (current) => new Set([...current, activeSection, nextSection]),
            );
            onSectionChange(nextSection);
          }}
          onClose={close}
          renderSlot={(name, _props, options) => {
            if (name === 'settings.header') return '设置';
            if (name === 'settings.close') return '关闭设置';
            if (name !== 'settings.section') return null;
            return rows
              .filter((row) => visited.has(row.id) || row.id === activeSection)
              .map((row) => (
                <div
                  key={row.id}
                  hidden={row.id !== options?.only}
                  className={
                    row.id === 'preferences'
                      ? preferenceStyles.section
                      : styles.section
                  }
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
                  {row.id === 'preferences' && (
                    <PersonalPreferencesSettings preferences={preferences} />
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
                  {row.id === 'work' && (
                    <WorkAutomationSettings
                      key={workspaceId}
                      workspaceId={workspaceId}
                      capabilities={capabilities('work')}
                      onCapabilitiesChange={onCapabilitiesChange}
                    />
                  )}
                  {row.id === 'computer' && (
                    <>
                      <div hidden={bridge.bridgeOpen}>
                        <ComputerSettings
                          workspaceId={workspaceId}
                          active={
                            activeSection === 'computer' && !bridge.bridgeOpen
                          }
                          onBridge={onBridge}
                          bridge={bridge}
                          capabilities={capabilities('computer')}
                          onCapabilitiesChange={onCapabilitiesChange}
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
