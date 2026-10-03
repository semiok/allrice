'use client';

import type { ReactNode } from 'react';
import { AllriceMark } from '../allrice-mark';
import { AdminIcon, type AdminIconName } from './admin-ui';
import styles from './admin-ui.module.css';

export function AdminShell({
  items,
  children,
}: {
  items: {
    label: string;
    icon: AdminIconName;
    active: boolean;
    onSelect: () => void;
  }[];
  children: ReactNode;
}) {
  return (
    <main className={`${styles.theme} ${styles.shell}`} data-admin-theme="dark">
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <AllriceMark size={24} />
          <div>
            <strong>allrice</strong>
            <span>管理后台</span>
          </div>
        </div>
        <nav className={styles.navigation} aria-label="管理后台菜单">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              aria-current={item.active ? 'page' : undefined}
              onClick={item.onSelect}
            >
              <AdminIcon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className={styles.account}>
          <AdminIcon name="user" />
          <span>平台管理员</span>
        </div>
      </aside>
      <div className={styles.content}>{children}</div>
    </main>
  );
}
