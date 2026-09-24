'use client';

import { useState } from 'react';
import Link from 'next/link';
import { IconSettingsOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives';
import type { SaasCapabilityManifest } from '@allrice/contracts';
import { McpSettings } from '../runtime-console/mcp-settings';
import { LocalMcpSettings } from '../runtime-console/local-mcp-settings';
import { BrowserControlSettings } from '../workspace/browser/settings';
import { LocalBrowserSettings } from '../workspace/local-browser/local-browser-settings';
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
}: {
  collapsed: boolean;
  manifest: SaasCapabilityManifest;
  workspaceId: string;
  monthlyQuota: ReturnType<typeof useMonthlyQuota>;
}) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState('account');
  const [visited, setVisited] = useState(() => new Set(['account']));
  const rows = [
    { id: 'account', label: '账号与用量' },
    ...(manifest.roles.includes('tenant_admin')
      ? [
          { id: 'mcp', label: 'MCP 连接' },
          { id: 'cloud-browser', label: '云端浏览器' },
          { id: 'local-browser', label: '本地浏览器' },
        ]
      : []),
    ...(manifest.surfaces.includes('platform_admin')
      ? [{ id: 'platform', label: '平台管理' }]
      : []),
  ];
  const close = () => setOpen(false);
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
          aria-expanded={open}
          onClick={() => {
            setOpen(true);
            void monthlyQuota.reload();
          }}
        >
          <IconSettingsOutlineMedium size={20} />
          {!collapsed && <span className={native.triggerLabel}>设置</span>}
        </button>
      </div>
      {open && (
        <SettingsPanel
          rows={rows}
          activeId={activeId}
          onSelect={(id) => {
            setActiveId(id);
            setVisited((current) => new Set([...current, id]));
          }}
          onClose={close}
          renderSlot={(name, _props, options) => {
            if (name === 'settings.header') return '设置';
            if (name === 'settings.close') return '关闭设置';
            if (name !== 'settings.section') return null;
            return rows
              .filter((row) => visited.has(row.id))
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
                  {row.id === 'mcp' && (
                    <>
                      <McpSettings workspaceId={workspaceId} />
                      <LocalMcpSettings workspaceId={workspaceId} />
                    </>
                  )}
                  {row.id === 'cloud-browser' && (
                    <BrowserControlSettings workspaceId={workspaceId} />
                  )}
                  {row.id === 'local-browser' && (
                    <LocalBrowserSettings workspaceId={workspaceId} embedded />
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
