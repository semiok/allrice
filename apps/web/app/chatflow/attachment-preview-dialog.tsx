'use client';

import type { PendingAttachment } from './chatflow-types';
import { DshDialog } from './dsh-upstream/Dialog';
import styles from './dsh-saas.module.css';

interface AttachmentPreviewDialogProps {
  attachment: PendingAttachment | null;
  onClose: () => void;
}

export function AttachmentPreviewDialog({
  attachment,
  onClose,
}: AttachmentPreviewDialogProps) {
  if (!attachment?.previewUrl) return null;

  return (
    <DshDialog
      ariaLabel={`预览 ${attachment.fileName}`}
      bodyClassName={styles.attachmentPreviewBody}
      className={styles.attachmentPreviewDialog}
      onClose={onClose}
      title={attachment.fileName}
    >
      <img alt={attachment.fileName} src={attachment.previewUrl} />
    </DshDialog>
  );
}
