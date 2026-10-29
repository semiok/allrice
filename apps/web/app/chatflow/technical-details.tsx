'use client';
import type { ReactNode } from 'react';
import { useProcessDisclosure } from './work-process-reading-state';
import {
  DisclosureRow,
  IconInfoOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import styles from './technical-details.module.css';

/** Raw records for troubleshooting, collapsed until someone asks for them. */
export function TechnicalDetails({
  rows = [],
  children,
}: {
  rows?: [string, ReactNode][];
  children?: ReactNode;
}) {
  const [open, setOpen] = useProcessDisclosure('technical', false);
  return (
    <DisclosureRow
      icon={<IconInfoOutlineRegular />}
      title={<span data-process-control="technical">技术详情</span>}
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => setOpen((value) => !value)}
      className={styles.disclosure}
    >
      <div className={styles.body}>
        {rows.length > 0 && (
          <dl>
            {rows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {children}
      </div>
    </DisclosureRow>
  );
}
