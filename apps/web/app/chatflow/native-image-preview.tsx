'use client';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from 'react';
import {
  ZoomViewport,
  zoomSurfaceClass,
} from './dsh-upstream/document/zoom/ZoomViewport';
import {
  FIT_WIDTH,
  type ZoomPreference,
} from './dsh-upstream/document/zoom/types';
import styles from './workbench.module.css';
import {
  ImageBody,
  imageMediaType,
} from './dsh-upstream/document/image/ImageBody';
import { zh } from './dsh-upstream/document/image/locales';
import { previewBytes, previewLocale } from './native-document-module';
const imageLocale = previewLocale(zh);
const retain = () => {};

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
  const data = useMemo(
    () => previewBytes(src.slice(src.indexOf(',') + 1)),
    [src],
  );
  const [preference, setPreference] = useState<ZoomPreference>(FIT_WIDTH);
  const [lifetime, setLifetime] = useState(() => new AbortController());
  useEffect(() => {
    if (lifetime.signal.aborted) setLifetime(new AbortController());
    return () => lifetime.abort();
  }, [lifetime]);
  const mime = src.slice(5, src.indexOf(';'));
  const suffix =
    ['png', 'jpg', 'gif', 'webp', 'bmp', 'ico', 'svg'].find(
      (ext) => imageMediaType(`file.${ext}`) === mime,
    ) ?? 'png';
  return (
    <div className={styles.zoomPreview}>
      <ImageBody
        content={{ kind: 'bytes', data }}
        resourceAddress={`${alt}.${suffix}`}
        useTabInfo={() => ({ tab: { id: 'image', signal: lifetime.signal } })}
        useStore={(select) => select({ byTab: { image: preference } })}
        actions={{ zoom: (_id, value) => setPreference(value) }}
        retainTab={retain}
        scrollportRef={scrollport}
        t={imageLocale}
      />
    </div>
  );
}

/** One native scroll/zoom viewport for all pages, including pointer-anchored zoom. */
export function NativeImagePages({
  images,
  paper = false,
}: {
  images: { src: string; alt: string }[];
  paper?: boolean;
}) {
  const [preference, setPreference] = useState<ZoomPreference>(FIT_WIDTH);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const knownWidths = Object.values(widths);
  const width = knownWidths.length ? Math.max(...knownWidths) : undefined;
  const [lifetime, setLifetime] = useState(() => new AbortController());
  useEffect(() => {
    if (lifetime.signal.aborted) setLifetime(new AbortController());
    return () => lifetime.abort();
  }, [lifetime]);
  const loaded = useCallback((element: HTMLImageElement) => {
    const key = element.alt,
      value = element.naturalWidth;
    if (value)
      setWidths((current) =>
        current[key] === value ? current : { ...current, [key]: value },
      );
  }, []);
  return (
    <div className={paper ? styles.documentPages : styles.zoomPreview}>
      <ZoomViewport
        preference={preference}
        intrinsicWidth={width}
        horizontalInset={paper ? 48 : 0}
        labels={labels}
        signal={lifetime.signal}
        scrollportRef={scrollport}
        onPreference={setPreference}
      >
        <div className={paper ? styles.documentCanvas : undefined}>
          {images.map(({ src, alt }) =>
            failed[alt] ? (
              <p key={alt} role="alert">
                {alt}加载失败，请下载查看。
              </p>
            ) : (
              <div
                key={alt}
                className={`${zoomSurfaceClass} ${paper ? styles.documentPaper : ''}`}
                data-document-zoom-surface
                style={
                  {
                    '--document-zoom-width': `${widths[alt] ?? width ?? 800}px`,
                  } as CSSProperties
                }
              >
                <img
                  ref={(element) => {
                    if (element?.complete) loaded(element);
                  }}
                  src={src}
                  alt={alt}
                  style={{
                    display: 'block',
                    width: '100%',
                    maxWidth: 'none',
                    height: 'auto',
                  }}
                  onLoad={(event) => loaded(event.currentTarget)}
                  onError={() =>
                    setFailed((current) => ({ ...current, [alt]: true }))
                  }
                  draggable={false}
                  referrerPolicy="no-referrer"
                />
              </div>
            ),
          )}
        </div>
      </ZoomViewport>
    </div>
  );
}
