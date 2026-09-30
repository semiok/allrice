'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { ImageGallery } from './dsh-upstream/images/MessageImage';
import type { MessageImageSource } from './message-image-cache';
import type { Attachment, PendingAttachment } from './chatflow-types';
import styles from './dsh-saas.module.css';

const imageLabels = {
  image: '图片',
  open: '查看原图',
  openNamed: (name: string) => `查看 ${name}`,
  loading: '正在加载图片…',
  loadFailed: '图片加载失败，点击重试',
  lightbox: { dialog: '图片预览', close: '关闭' },
};

export function MessageImageGallery({
  attachments,
  source,
}: {
  attachments: Attachment[];
  source: MessageImageSource;
}) {
  const images = useMemo(
    () =>
      attachments
        .filter((a) => a.mediaType.startsWith('image/'))
        .map((attachment) =>
          attachment.previewUrl
            ? {
                preview: {
                  url: attachment.previewUrl,
                  name: attachment.fileName,
                  width: attachment.width,
                  height: attachment.height,
                },
              }
            : { attachment: source.reference(attachment) },
        ),
    [attachments, source],
  );
  return (
    <ImageGallery
      images={images}
      load={source.load}
      align="end"
      labels={imageLabels}
    />
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
