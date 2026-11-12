'use client';

import { Children, Fragment, useLayoutEffect, type ReactNode } from 'react';
import { DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives';
import { useProcessDisclosure } from './work-process-reading-state';
import styles from './dsh-saas.module.css';

/** Shared main/child process chrome. The caller supplies authorized facts;
 * this view owns only disclosure and container-responsive layout. */
export function WorkProcessStepView({
  id,
  icon,
  title,
  status,
  elapsedMs,
  running,
  failed,
  initialOpen = false,
  sharedQuestion = false,
  disclosureIds = [],
  reveal = false,
  details = [],
  children,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  status?: string;
  elapsedMs?: number;
  running?: boolean;
  failed?: boolean;
  initialOpen?: boolean;
  sharedQuestion?: boolean;
  disclosureIds?: readonly string[];
  reveal?: boolean;
  details?: readonly { label: string; value: ReactNode }[];
  children?: ReactNode;
}) {
  const keys = [...new Set([id, ...disclosureIds])].map((id) => `step:${id}`);
  const [manualOpen, setOpen] = useProcessDisclosure(
    disclosureIds.length ? keys : keys[0]!,
    initialOpen,
    sharedQuestion,
    disclosureIds.length > 0,
  );
  const expandable =
    details.length > 0 || Children.toArray(children).length > 0;
  const open = expandable && (reveal || manualOpen);
  useLayoutEffect(() => {
    if (reveal && !manualOpen) setOpen(true);
  });
  const tenths = elapsedMs !== undefined ? Math.round(elapsedMs / 100) : 0;
  const elapsed =
    elapsedMs !== undefined && Number.isFinite(elapsedMs) && elapsedMs >= 0
      ? `${tenths >= 600 ? `${Math.floor(tenths / 600)}分 ` : ''}${(tenths % 600) / 10}秒`
      : undefined;
  return (
    <div
      className={styles.processStep}
      data-step-id={id}
      data-status={status}
      data-failed={failed || undefined}
      data-running={running || undefined}
    >
      <DisclosureRow
        icon={icon}
        title={title}
        open={open}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => setOpen(!open)}
        rowClassName={styles.processStepRow}
        titleClassName={styles.processStepLabel}
        contentClassName={styles.processStepContent}
        contentLayoutClassName={styles.processStepText}
        headerAccessory={
          status || elapsed ? (
            <span className={styles.processStepStatus}>
              {[status, elapsed].filter(Boolean).join(' · ')}
            </span>
          ) : undefined
        }
        collapsedContent={
          <>
            {keys.map((key) => (
              <span key={key} aria-hidden data-process-control={key} />
            ))}
          </>
        }
      >
        <div
          className={styles.processStepDetails}
          data-process-content={`step:${id}:details`}
        >
          {details.length > 0 && (
            <dl className={styles.processDetailGrid}>
              {details.map((detail, index) => (
                <Fragment key={`${detail.label}:${index}`}>
                  <dt>{detail.label}</dt>
                  <dd data-process-content={`step:${id}:field:${index}`}>
                    {detail.value}
                  </dd>
                </Fragment>
              ))}
            </dl>
          )}
          {children}
        </div>
      </DisclosureRow>
    </div>
  );
}
