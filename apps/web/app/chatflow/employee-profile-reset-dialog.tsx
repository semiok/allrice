'use client';

import { useEffect, useRef } from 'react';
import {
  Button,
  IconWarningOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { DshDialog } from './dsh-upstream/Dialog';
import css from './employee-profile-reset-dialog.module.css';

interface EmployeeProfileResetDialogProps {
  /** A caller may select success only after matching the real write receipt and
   * reading the authorized effective profile. Unknown writes are deliberately
   * absent: their user-facing copy and production wiring remain unapproved. */
  phase: 'confirm' | 'pending' | 'rejected' | 'success';
  onConfirm: () => void;
  onCancel: () => void;
  onReturn: () => void;
}

/** Controlled presentation only; it neither writes nor invents platform defaults.
 * Mount one modal owner at a time, replacing the editor's dialog while active. */
export function EmployeeProfileResetDialog({
  phase,
  onConfirm,
  onCancel,
  onReturn,
}: EmployeeProfileResetDialogProps) {
  const callbacks = useRef({ phase, onCancel, onReturn });
  callbacks.current = { phase, onCancel, onReturn };
  const closeFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (closeFrame.current !== null) cancelAnimationFrame(closeFrame.current);
    },
    [],
  );
  const pending = phase === 'pending';
  const success = phase === 'success';
  const close = () => {
    if (pending || closeFrame.current !== null) return;
    // A mask mousedown's default focus action precedes this handoff. Let the
    // existing Dialog restore the editor trigger afterwards, without changing
    // shared Dialog behavior or installing a second focus trap.
    closeFrame.current = requestAnimationFrame(() => {
      closeFrame.current = null;
      const current = callbacks.current;
      if (current.phase !== 'pending')
        (current.phase === 'success' ? current.onReturn : current.onCancel)();
    });
  };

  return (
    <DshDialog
      ariaLabel={success ? '恢复完成' : '重置人设'}
      title={success ? '恢复完成' : '重置人设'}
      className={`${css.dialog} ${success ? css.success : css.confirmation}`}
      bodyClassName={css.body}
      showCloseButton={false}
      onClose={close}
      onBack={success ? onReturn : undefined}
      backLabel="返回编辑"
      closeDisabled={pending}
      initialFocusSelector={
        success
          ? '[data-reset-return]'
          : pending
            ? undefined
            : '[data-reset-cancel]'
      }
    >
      <div className={css.content}>
        {success ? (
          <div className={css.successContent}>
            <span className={css.successMark} aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path
                  d="m5 12 4 4L19 6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <h3>已恢复默认人设。</h3>
          </div>
        ) : (
          <>
            <p className={css.description}>
              人设重置后，记忆、技能和工作场景依然保留。
            </p>
            {pending ? (
              <div className={css.loading} role="status" aria-busy="true">
                <span className={css.spinner} aria-hidden="true" />
                <p>正在恢复…</p>
              </div>
            ) : phase === 'rejected' ? (
              <div className={css.error} role="alert">
                <IconWarningOutlineRegular size={16} aria-hidden="true" />
                <p>恢复失败，请重试。</p>
              </div>
            ) : null}
          </>
        )}
      </div>
      <footer className={css.actions}>
        {success ? (
          <Button
            type="button"
            variant="primary"
            data-reset-return
            onClick={onReturn}
          >
            返回编辑
          </Button>
        ) : pending ? (
          <Button type="button" variant="primary" disabled>
            恢复中
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              data-reset-cancel
              onClick={onCancel}
            >
              取消
            </Button>
            <Button type="button" variant="primary" onClick={onConfirm}>
              恢复默认
            </Button>
          </>
        )}
      </footer>
    </DshDialog>
  );
}
