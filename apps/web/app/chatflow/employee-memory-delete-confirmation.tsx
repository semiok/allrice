'use client';

import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './employee-memory-sidebar.module.css';

/** Every memory delete entry freezes its target before opening this native
 * layer. Closing it restores the invoking list/detail control without a write. */
export function EmployeeMemoryDeleteConfirmation(props: {
  memory: { summary: string } | null;
  visible?: boolean;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <Modal
      open={props.visible !== false && props.memory !== null}
      onClose={() => {
        if (!props.busy) props.onCancel();
      }}
      headless
      title="确认删除这条记忆？"
      className={`${css.dialog} ${css.deleteDialog}`}
    >
      <header className={css.dialogHeader}>
        <h2>确认删除这条记忆？</h2>
      </header>
      <div className={css.dialogBody}>
        <p className={css.deleteSummary}>{props.memory?.summary}</p>
        {props.error && (
          <p role="alert" className={css.message}>
            {props.error}
          </p>
        )}
      </div>
      <footer className={css.footer}>
        <Button
          type="button"
          variant="outline"
          data-modal-autofocus
          disabled={props.busy}
          onClick={props.onCancel}
        >
          取消
        </Button>
        <Button
          type="button"
          variant="outline"
          className={css.deleteConfirm}
          disabled={props.busy}
          onClick={props.onDelete}
        >
          删除
        </Button>
      </footer>
    </Modal>
  );
}
