'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { DshDialog } from './dsh-upstream/Dialog';
import type { Attachment, PendingAttachment } from './chatflow-types';
import { readJson } from './chatflow-utils';
import styles from './dsh-saas.module.css';

function isImageAttachment(attachment: Attachment) {
  return attachment.mediaType.startsWith('image/');
}

export function MessageImageGallery({
  attachments,
  tenantHeaders,
}: {
  attachments: Attachment[];
  tenantHeaders: Record<string, string>;
}) {
  const images = attachments.filter(isImageAttachment);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Attachment | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all(
      images.map(async (image) => {
        const signed = await readJson<{ url: string }>(
          await fetch(`/api/v1/files/${image.id}/sign`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...tenantHeaders },
            body: JSON.stringify({ lifetimeSeconds: 900 }),
          }),
        );
        return [image.id, signed.url] as const;
      }),
    )
      .then((entries) => {
        if (active) setUrls(Object.fromEntries(entries));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [attachments, tenantHeaders]);

  if (!images.length) return null;
  return (
    <>
      <div
        className={styles.messageImages}
        data-variant={images.length === 1 ? 'single' : 'tile'}
      >
        {images.map((image) =>
          urls[image.id] ? (
            <button
              key={image.id}
              onClick={() => setPreview(image)}
              title={`查看 ${image.fileName}`}
              type="button"
            >
              <img alt={image.fileName} src={urls[image.id]} />
            </button>
          ) : (
            <span className={styles.imagePlaceholder} key={image.id}>
              正在加载图片…
            </span>
          ),
        )}
      </div>
      {preview && urls[preview.id] ? (
        <DshDialog
          ariaLabel={`预览 ${preview.fileName}`}
          bodyClassName={styles.attachmentPreviewBody}
          className={styles.attachmentPreviewDialog}
          onClose={() => setPreview(null)}
          title={preview.fileName}
        >
          <img alt={preview.fileName} src={urls[preview.id]} />
        </DshDialog>
      ) : null}
    </>
  );
}

export function PendingAttachmentRail({
  attachments,
  disabled,
  onOpen,
  onRemove,
  onRetry,
}: {
  attachments: PendingAttachment[];
  disabled: boolean;
  onOpen: (attachment: PendingAttachment) => void;
  onRemove: (attachment: PendingAttachment) => void;
  onRetry: (attachment: PendingAttachment) => void;
}) {
  const rail = useRef<HTMLDivElement | null>(null);
  const previousCount = useRef<number | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = useCallback(() => {
    const element = rail.current;
    if (!element) return;
    const left = element.scrollLeft > 1;
    const right =
      element.scrollLeft < element.scrollWidth - element.clientWidth - 1;
    setEdges((current) =>
      current.left === left && current.right === right
        ? current
        : { left, right },
    );
  }, []);

  useLayoutEffect(() => {
    const grew =
      previousCount.current !== null &&
      attachments.length > previousCount.current;
    previousCount.current = attachments.length;
    const element = rail.current;
    if (!element) return;
    if (grew) element.scrollLeft = element.scrollWidth - element.clientWidth;
    updateEdges();
  }, [attachments.length, updateEdges]);

  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(updateEdges);
    observer?.observe(element);
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      const scale =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? element.clientWidth
            : 1;
      event.preventDefault();
      element.scrollBy({
        left:
          event.deltaX !== 0
            ? event.deltaX * scale
            : Math.sign(event.deltaY) *
              Math.min(Math.abs(event.deltaY) * scale, 60),
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer?.disconnect();
      element.removeEventListener('wheel', onWheel);
    };
  }, [updateEdges]);

  const page = (direction: -1 | 1) => {
    const element = rail.current;
    if (!element) return;
    element.scrollBy({
      left: direction * Math.max(element.clientWidth - 64, 200),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    });
  };

  return (
    <div className={styles.pendingFiles}>
      {edges.left ? (
        <button
          aria-label="向左查看附件"
          className={`${styles.pendingFileArrow} ${styles.pendingFileArrowLeft}`}
          onClick={() => page(-1)}
          type="button"
        >
          ‹
        </button>
      ) : null}
      <div
        aria-label="待发送附件"
        className={styles.pendingFileRail}
        onScroll={updateEdges}
        ref={rail}
        role="group"
      >
        {attachments.map((attachment) => (
          <div className={styles.pendingFileItem} key={attachment.id}>
            {attachment.previewUrl ? (
              <button
                className={styles.pendingFileThumbnail}
                disabled={disabled}
                onClick={() => onOpen(attachment)}
                title={`查看 ${attachment.fileName}`}
                type="button"
              >
                <img alt={attachment.fileName} src={attachment.previewUrl} />
              </button>
            ) : (
              <div
                className={styles.pendingDocument}
                title={attachment.fileName}
              >
                <b aria-hidden="true">▧</b>
                <span>{attachment.fileName}</span>
              </div>
            )}
            {attachment.status === 'uploading' ? (
              <span className={styles.pendingFileState}>上传中</span>
            ) : null}
            {attachment.status === 'failed' ? (
              <button
                className={styles.pendingFileRetry}
                disabled={disabled}
                onClick={() => onRetry(attachment)}
                title={attachment.error ?? '上传失败'}
                type="button"
              >
                重试
              </button>
            ) : null}
            <button
              aria-label={`移除 ${attachment.fileName}`}
              className={styles.pendingFileRemove}
              disabled={disabled}
              onClick={() => onRemove(attachment)}
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 12 12">
                <path d="M3 3l6 6M9 3 3 9" />
              </svg>
            </button>
          </div>
        ))}
      </div>
      {edges.right ? (
        <button
          aria-label="向右查看附件"
          className={`${styles.pendingFileArrow} ${styles.pendingFileArrowRight}`}
          onClick={() => page(1)}
          type="button"
        >
          ›
        </button>
      ) : null}
    </div>
  );
}
