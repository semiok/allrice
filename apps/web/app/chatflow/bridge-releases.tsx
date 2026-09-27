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
  return (
    <section className={styles.bridgeReleaseSection} aria-label="Bridge 下载">
      <div className={styles.bridgeDownloads}>
        {(['macos-arm64', 'macos-x64'] as const).map((platform) => {
          const release = releases?.find((item) => item.platform === platform);
          const label =
            platform === 'macos-arm64' ? 'M 芯片版' : 'Intel 芯片版';
          if (release && !release.available)
            return (
              <span key={platform} className={styles.bridgeDownloadUnavailable}>
                {label}暂未提供
              </span>
            );
          return (
            <a
              key={platform}
              className={styles.bridgeClientDownload}
              href={`/api/v1/bridge/client/${platform}`}
              download={
                platform === 'macos-arm64'
                  ? 'RiceBridge-M.zip'
                  : 'RiceBridge-Intel.zip'
              }
              onClick={() => onDownload(label)}
            >
              下载 {label}
              {release?.version ? ` · v${release.version}` : ''}
            </a>
          );
        })}
      </div>
      {error ? (
        <small role="status">版本信息暂不可用，请刷新重试。</small>
      ) : !releases ? (
        <small role="status">正在检查最新版本…</small>
      ) : releases.some((item) => item.available && !item.version) ? (
        <small>部分安装包的版本尚未确认。</small>
      ) : null}
    </section>
  );
}
