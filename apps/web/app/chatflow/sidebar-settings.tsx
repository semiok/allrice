'use client';

import { useState } from 'react';
import Link from 'next/link';
import { IconSettingsOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives';
import type { SaasCapabilityManifest } from '@allrice/contracts';
import { ConnectedApps } from '../workspace/mcp/connected-apps';
import { SettingsPanel } from './dsh-upstream/settings/SettingsRoot';
import native from './dsh-upstream/settings/SettingsRoot.module.css';
import { MonthlyQuota } from './monthly-quota';
import type { useMonthlyQuota } from './use-monthly-quota';
import styles from './sidebar-settings.module.css';

export function SidebarSettings({
  collapsed,
  manifest,
  workspaceId,
  monthlyQuota,
  section,
  onSectionChange,
  onBridge,
}: {
  collapsed: boolean;
  manifest: SaasCapabilityManifest;
  workspaceId: string;
  monthlyQuota: ReturnType<typeof useMonthlyQuota>;
  section: string | null;
  onSectionChange: (section: string | null) => void;
  onBridge: () => void;
}) {
  const [visited, setVisited] = useState(() => new Set(['account']));
  const rows = [
    { id: 'account', label: '账号与用量' },
    { id: 'apps', label: '已连接应用' },
    { id: 'computer', label: '我的电脑' },
    ...(manifest.surfaces.includes('platform_admin')
      ? [{ id: 'platform', label: '平台管理' }]
      : []),
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
                  <h2>{row.label}</h2>
                  {row.id === 'account' && (
                    <MonthlyQuota
                      expanded
                      data={monthlyQuota.data}
                      failed={monthlyQuota.failed}
                      onRefresh={() => void monthlyQuota.reload()}
                    />
                  )}
                  {row.id === 'apps' && (
                    <ConnectedApps workspaceId={workspaceId} />
                  )}
                  {row.id === 'computer' && (
                    <>
                      <p>
                        处理电脑里的文件时，安装并连接
                        Bridge，再选择需要交给员工的文件夹。浏览器和计算环境会自动准备。
                      </p>
                      <p>
                        云端工作无需连接电脑。你可以随时在 Bridge 中暂停或断开。
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          close();
                          onBridge();
                        }}
                      >
                        连接与管理电脑
                      </button>
                    </>
                  )}
                  {row.id === 'platform' && (
                    <Link href="/runtime-console?view=governance">
                      打开平台管理
                    </Link>
                  )}
                </div>
              ));
          }}
        />
      )}
    </>
  );
}
