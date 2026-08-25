import Link from 'next/link';
import type { ReactNode } from 'react';

export type AppNavKey = 'workspace' | 'automation' | 'employees';

interface AppNavigationProps {
  active: AppNavKey | null;
  actionsDisabled?: boolean;
  showEmployeeAdmin?: boolean;
  onFiles?: () => void;
  onMemory?: () => void;
  onNavigate?: (key: AppNavKey) => void;
}

interface AppSidebarProps extends AppNavigationProps {
  action: ReactNode;
  children?: ReactNode;
  className?: string;
  footer?: ReactNode;
}

function navClass(active: boolean) {
  return active ? 'primary-menu-active' : undefined;
}

export function AppNavigation({
  active,
  actionsDisabled,
  showEmployeeAdmin = false,
  onFiles,
  onMemory,
  onNavigate,
}: AppNavigationProps) {
  const destination = (key: AppNavKey, href: string, label: ReactNode) =>
    onNavigate ? (
      <button
        className={navClass(active === key)}
        type="button"
        onClick={() => onNavigate(key)}
      >
        {label}
      </button>
    ) : (
      <Link className={navClass(active === key)} href={href}>
        {label}
      </Link>
    );

  return (
    <nav className="primary-menu app-primary-menu" aria-label="主菜单">
      {onFiles ? (
        <button type="button" onClick={onFiles} disabled={actionsDisabled}>
          <span className="primary-menu-icon">▤</span>
          工作区文件
        </button>
      ) : (
        <Link href="/workspace#files">
          <span className="primary-menu-icon">▤</span>
          工作区文件
        </Link>
      )}
      {onMemory ? (
        <button type="button" onClick={onMemory} disabled={actionsDisabled}>
          <span className="primary-menu-icon">⌁</span>
          我的记忆
        </button>
      ) : (
        <Link href="/workspace#memory">
          <span className="primary-menu-icon">⌁</span>
          我的记忆
        </Link>
      )}
      {destination(
        'automation',
        '/automation',
        <>
          <span className="primary-menu-icon">◷</span>
          自动化
        </>,
      )}
      {showEmployeeAdmin
        ? destination(
            'employees',
            '/employees',
            <>
              <span className="primary-menu-icon">✦</span>
              AI员工配置
            </>,
          )
        : null}
    </nav>
  );
}

export function AppSidebar({
  active,
  actionsDisabled,
  action,
  children,
  className,
  footer,
  onFiles,
  onMemory,
  onNavigate,
  showEmployeeAdmin,
}: AppSidebarProps) {
  return (
    <aside className={`app-sidebar ${className ?? ''}`.trim()}>
      <div className="rice-brand">
        <span>R</span>
        <div>
          <strong>AllRice</strong>
          <small>你的 AI 工作台</small>
        </div>
      </div>
      {action}
      <AppNavigation
        active={active}
        actionsDisabled={actionsDisabled}
        onFiles={onFiles}
        onMemory={onMemory}
        onNavigate={onNavigate}
        showEmployeeAdmin={showEmployeeAdmin}
      />
      {children}
      {footer}
    </aside>
  );
}
