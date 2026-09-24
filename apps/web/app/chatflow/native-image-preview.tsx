'use client';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  ZoomViewport,
  zoomSurfaceClass,
} from './dsh-upstream/document/zoom/ZoomViewport';
import {
  FIT_WIDTH,
  type ZoomPreference,
} from './dsh-upstream/document/zoom/types';
import styles from './workbench.module.css';
const labels = {
  controls: '文档缩放',
  menu: '选择缩放比例',
  out: '缩小',
  into: '放大',
  fitWidth: '适应宽度',
  value: (percent: number) => `${percent}%`,
};
const scrollport = () => {};

/** Allrice supplies existing rendered bytes; DSH owns fit-width, zoom and gestures. */
export function NativeImagePreview({ src, alt }: { src: string; alt: string }) {
  const [preference, setPreference] = useState<ZoomPreference>(FIT_WIDTH);
  const [width, setWidth] = useState<number>();
  const [failed, setFailed] = useState(false);
  const [lifetime, setLifetime] = useState(() => new AbortController());
  useEffect(() => {
    if (lifetime.signal.aborted) setLifetime(new AbortController());
    return () => lifetime.abort();
  }, [lifetime]);
  const loaded = useCallback((element: HTMLImageElement | null) => {
    if (element?.complete && element.naturalWidth)
      setWidth(element.naturalWidth);
  }, []);
  return (
    <div className={styles.zoomPreview}>
      <ZoomViewport
        preference={preference}
        intrinsicWidth={width}
        labels={labels}
        signal={lifetime.signal}
        scrollportRef={scrollport}
        onPreference={setPreference}
      >
        {failed ? (
          <p role="alert">图片预览加载失败，请下载查看。</p>
        ) : (
          <div
            className={zoomSurfaceClass}
            data-document-zoom-surface
            style={
              { '--document-zoom-width': `${width ?? 800}px` } as CSSProperties
            }
          >
            <img
              ref={loaded}
              src={src}
              alt={alt}
              style={{ width: '100%', maxWidth: 'none', height: 'auto' }}
              onLoad={(event) => setWidth(event.currentTarget.naturalWidth)}
              onError={() => setFailed(true)}
              draggable={false}
              referrerPolicy="no-referrer"
            />
          </div>
        )}
      </ZoomViewport>
    </div>
  );
}
