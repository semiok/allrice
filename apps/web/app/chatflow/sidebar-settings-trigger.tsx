import { IconSettingsOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives';
import native from './dsh-upstream/settings/SettingsRoot.module.css';

/** Existing employee settings entry; the owner supplies the employee settings page. */
export function SidebarSettingsTrigger({
  collapsed,
  expanded,
  onOpen,
}: {
  collapsed: boolean;
  expanded: boolean;
  onOpen: () => void;
}) {
  return (
    <div className={`${native.triggerRow} ${collapsed ? native.railRow : ''}`}>
      <SidebarSettingsButton
        collapsed={collapsed}
        expanded={expanded}
        onOpen={onOpen}
      />
    </div>
  );
}

/** The same employee button when the native shell already owns the row. */
export function SidebarSettingsButton({
  collapsed,
  expanded,
  onOpen,
}: {
  collapsed: boolean;
  expanded: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={`${native.trigger} ${collapsed ? native.rail : ''}`}
      aria-label="设置"
      title="设置"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={onOpen}
    >
      <IconSettingsOutlineMedium size={20} />
      {!collapsed && <span className={native.triggerLabel}>设置</span>}
    </button>
  );
}
