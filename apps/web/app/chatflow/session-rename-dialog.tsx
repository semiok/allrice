'use client';

import { useState } from 'react';
import { DshDialog } from './dsh-upstream/Dialog';
import dialog from './compact-dialog.module.css';
import form from './employee-create.module.css';

export function SessionRenameDialog({
  title,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  title: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (title: string) => Promise<void>;
}) {
  const [value, setValue] = useState(title);
  return (
    <DshDialog
      ariaLabel="重命名会话"
      title="重命名会话"
      className={dialog.dialog}
      bodyClassName={dialog.body}
      initialFocusSelector="#session-title"
      onClose={onClose}
    >
      <form
        className={form.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && value.trim()) void onSubmit(value.trim());
        }}
      >
        <label className={form.nameLabel} htmlFor="session-title">
          会话名称
        </label>
        <input
          id="session-title"
          className={form.nameInput}
          maxLength={160}
          required
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
        />
        {error ? <p role="alert">{error}</p> : null}
        <div className={form.actions}>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" disabled={busy || !value.trim()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </DshDialog>
  );
}
