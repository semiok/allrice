'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BridgeClientRelease } from '../../lib/bridge/client-releases';
import { readJson } from './chatflow-utils';
import styles from './bridge-dialog.module.css';

export function useBridgeReleases(
  active: boolean,
  headers: Record<string, string>,
) {
  const [releases, setReleases] = useState<BridgeClientRelease[] | null>(null);
  const [error, setError] = useState(false);
  const request = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError(false);
    try {
      const result = await readJson<{ releases: BridgeClientRelease[] }>(
        await fetch('/api/v1/bridge/client/releases', {
          cache: 'no-store',
          headers,
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        }),
      );
      if (!controller.signal.aborted) setReleases(result.releases);
    } catch {
      if (!controller.signal.aborted) {
        setReleases(null);
        setError(true);
      }
    }
  }, [headers]);
  useEffect(() => {
    if (!active) return;
    void reload();
    return () => request.current?.abort();
  }, [active, reload]);
  return { releases, error, reload };
}

/** Only compare version formats actually published by Bridge. Unknown reported
 * versions never produce a misleading update or downgrade recommendation. */
export function compareBridgeVersions(installed: string, downloadable: string) {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/.exec(value);
    return match
      ? [
          BigInt(match[1]!),
          BigInt(match[2]!),
          BigInt(match[3]!),
          match[4] === undefined ? null : BigInt(match[4]),
        ]
      : null;
  };
  const a = parse(installed),
    b = parse(downloadable);
  if (!a || !b) return null;
  for (let i = 0; i < 4; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === null) return 1;
    if (b[i] === null) return -1;
    return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

export function BridgeVersionStatus({
  installed,
  release,
  online,
  compact = false,
}: {
  installed?: string | null;
  release?: BridgeClientRelease;
  online: boolean;
  compact?: boolean;
}) {
  const comparison =
    installed && release?.available && release.version
      ? compareBridgeVersions(installed, release.version)
      : null;
  return (
    <small data-bridge-version>
      {installed
        ? `${online ? (compact ? '' : '当前版本 ') : '上次上报版本 '}v${installed}`
        : '当前版本尚未上报'}
      {!compact && comparison === -1
        ? ` · 可更新至 v${release!.version}`
        : !compact && comparison === 0
          ? ' · 已是最新版本'
          : ''}
    </small>
  );
}

export function BridgeReleaseDownloads({
  releases,
  error,
  onDownload,
}: {
  releases: BridgeClientRelease[] | null;
  error: boolean;
  onDownload: (label: string) => void;
}) {
  // Only the Apple silicon build is published (MET-214).
  const release = releases?.find((item) => item.platform === 'macos-arm64');
  const label = 'AllRice 助手（Apple 芯片）';
  return (
    <section
      className={styles.bridgeReleaseSection}
      aria-label="下载 AllRice 助手"
    >
      <div className={styles.bridgeDownloads}>
        {release && !release.available ? (
          <span className={styles.bridgeDownloadUnavailable}>
            {label}暂未提供下载
          </span>
        ) : (
          <a
            className={styles.bridgeClientDownload}
            href="/api/v1/bridge/client/macos-arm64"
            download="AllRice-Assistant.zip"
            onClick={() => onDownload(label)}
          >
            下载 {label}
            {release?.version ? ` · v${release.version}` : ''}
          </a>
        )}
      </div>
      {error ? (
        <small role="status">版本信息暂不可用，请刷新重试。</small>
      ) : !releases ? (
        <small role="status">正在检查最新版本…</small>
      ) : release?.available && !release.version ? (
        <small>安装包的版本尚未确认。</small>
      ) : null}
    </section>
  );
}
