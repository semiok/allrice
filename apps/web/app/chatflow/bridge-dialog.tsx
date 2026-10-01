'use client';

import { useState } from 'react';
import {
  IconChevronDownOutlineRegular,
  IconCopyOutlineRegular,
  IconDownloadOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { DshDialog } from './dsh-upstream/Dialog';
import {
  BridgeReleaseDownloads,
  BridgeVersionStatus,
  compareBridgeVersions,
  type useBridgeReleases,
} from './bridge-releases';
import type { useBridge } from './use-bridge';
import dialog from './compact-dialog.module.css';
import css from './bridge-dialog.module.css';
import { bridgeCapabilityRows } from './bridge-view';

export function BridgeDialog({
  bridge,
  releases,
  onClose,
}: {
  bridge: ReturnType<typeof useBridge>;
  releases: ReturnType<typeof useBridgeReleases>;
  onClose: () => void;
}) {
  const devices = bridge.bridgeDevices.filter(
    (device) => device.status !== 'revoked',
  );
  const onlineDevices = bridge.bridgeStatusKnown
    ? devices.filter((device) => device.status === 'online')
    : [];
  const [installExpanded, setInstallExpanded] = useState<boolean | null>(null);
  const installOpen =
    installExpanded ?? (bridge.bridgeStatusKnown && !onlineDevices.length);
  const comparisons = onlineDevices.map((device) => {
    const release = releases.releases?.find(
      (item) => item.platform === device.platform,
    );
    return device.clientVersion && release?.available && release.version
      ? compareBridgeVersions(device.clientVersion, release.version)
      : null;
  });
  const versionHint = comparisons.includes(-1)
    ? '有新版本'
    : comparisons.length && comparisons.every((value) => value === 0)
      ? '已是最新版'
      : '';

  return (
    <DshDialog
      ariaLabel="我的电脑"
      eyebrow="Rice Bridge"
      title="我的电脑"
      className={dialog.dialog}
      bodyClassName={dialog.body}
      onClose={onClose}
    >
      <p className={css.intro}>让员工处理你选择的本地文件。</p>
      <div className={css.devices}>
        {devices.map((device) => {
          const online = bridge.bridgeStatusKnown && device.status === 'online';
          return (
            <section
              key={device.id}
              aria-label={device.name}
              className={css.device}
            >
              <div className={css.deviceHeader}>
                <span className={css.computerIcon} aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none">
                    <rect x="3.5" y="4" width="17" height="12" rx="2" />
                    <path d="M8 20h8M12 16v4" />
                  </svg>
                </span>
                <div className={css.deviceCopy}>
                  <strong>{device.name.replace(/ · Rice Bridge$/, '')}</strong>
                  <div className={css.deviceMeta}>
                    <span>
                      {device.platform === 'macos-arm64'
                        ? 'M 芯片'
                        : 'Intel 芯片'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <BridgeVersionStatus
                      installed={device.clientVersion}
                      release={releases.releases?.find(
                        (item) => item.platform === device.platform,
                      )}
                      online={online}
                      compact
                    />
                  </div>
                </div>
                <span className={css.connection} data-online={online}>
                  <i aria-hidden="true" />
                  {!bridge.bridgeStatusKnown
                    ? '待确认'
                    : online
                      ? '已连接'
                      : '离线'}
                </span>
              </div>
              {bridge.bridgeStatusKnown && device.readiness ? (
                <div className={css.capabilities} aria-label="电脑能力状态">
                  {bridgeCapabilityRows(device).map((row) => (
                    <div key={row.capability} className={css.capability}>
                      <strong>{row.label}</strong>
                      <span>{row.stateLabel}</span>
                      <small>{row.reason}</small>
                      {row.version && (
                        <details className={css.capabilityVersion}>
                          <summary>版本信息</summary>
                          <small>{row.version}</small>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
              {online ? (
                <div className={css.folder}>
                  <span className={css.folderIcon} aria-hidden="true">
                    <IconFolderOpenOutlineRegular size={21} />
                  </span>
                  <div className={css.folderCopy}>
                    <strong>
                      {device.folderGrants.length
                        ? device.folderGrants
                            .map((grant) => grant.label)
                            .join('、')
                        : '尚未选择文件夹'}
                    </strong>
                    <span>
                      {device.folderGrants.length
                        ? '员工仅可访问你选择的文件夹'
                        : '选择员工需要处理的本地文件夹'}
                    </span>
                  </div>
                  {device.folderGrants.length ? (
                    <button
                      className={css.textButton}
                      disabled={bridge.bridgeBusy}
                      onClick={() =>
                        void bridge.disconnectBridgeWorkspace(device)
                      }
                      type="button"
                    >
                      断开
                    </button>
                  ) : (
                    <button
                      className={css.primaryButton}
                      disabled={bridge.bridgeBusy}
                      onClick={() =>
                        void bridge.requestBridgeWorkspaceSelection(device)
                      }
                      type="button"
                    >
                      选择文件夹
                    </button>
                  )}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      {!bridge.bridgeStatusKnown ? (
        <p className={css.notice}>暂时无法确认连接状态，请刷新重试。</p>
      ) : !onlineDevices.length ? (
        <p className={css.notice}>
          {devices.length
            ? '打开这台电脑上的 Rice Bridge 即可重新连接。'
            : '尚未连接电脑。安装 Bridge 后，输入配对码即可连接。'}
        </p>
      ) : null}
      {bridge.bridgeRecoveryActive && onlineDevices.length ? (
        <p className={css.notice} role="status">
          请在 Mac 弹出的窗口中选择文件夹，这里会自动更新。
        </p>
      ) : null}
      <details className={css.install} open={installOpen}>
        <summary
          onClick={(event) => {
            event.preventDefault();
            setInstallExpanded(!installOpen);
          }}
        >
          <IconDownloadOutlineRegular size={18} />
          <span>下载与安装</span>
          <small>{versionHint}</small>
          <IconChevronDownOutlineRegular size={16} />
        </summary>
        <div className={css.installBody}>
          <BridgeReleaseDownloads
            releases={releases.releases}
            error={releases.error}
            onDownload={bridge.noteBridgeDownload}
          />
          <p>
            解压后打开 Rice Bridge.app。升级前先退出旧版，原有配对和设置会保留。
          </p>
          <p>当前为开发版，尚未通过 Apple 公证。</p>
          <button
            className={css.secondaryButton}
            disabled={bridge.bridgePairingBusy}
            onClick={() => void bridge.createBridgePairing()}
            type="button"
          >
            {bridge.bridgePairingBusy
              ? '正在生成…'
              : bridge.bridgePairing
                ? '重新生成配对码'
                : '生成配对码'}
          </button>
          {bridge.bridgePairing ? (
            <div className={css.pairing}>
              <div className={css.pairingCode}>
                <code>{bridge.bridgePairing.code.replaceAll('-', '')}</code>
                <button
                  className={css.textButton}
                  aria-label="复制配对码"
                  onClick={() =>
                    void bridge.copyBridgePairingCode(
                      bridge.bridgePairing!.code,
                    )
                  }
                  type="button"
                >
                  <IconCopyOutlineRegular size={18} />
                </button>
              </div>
              <p>10 分钟内在 Bridge 中输入，之后会自动连接。</p>
            </div>
          ) : null}
        </div>
      </details>
      {bridge.bridgeFeedback ? (
        <p
          className={css.feedback}
          data-kind={bridge.bridgeFeedback.kind}
          role="status"
        >
          {bridge.bridgeFeedback.message}
        </p>
      ) : null}
      <footer className={dialog.footer}>
        <span role="status" data-bridge-refresh-status>
          {bridge.bridgeStatusKnown && bridge.bridgeLastRefreshedAt
            ? `已刷新 · ${new Date(bridge.bridgeLastRefreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : bridge.bridgeRefreshError || '正在确认连接状态…'}
        </span>
        <button
          className={css.textButton}
          disabled={bridge.bridgeBusy}
          onClick={() => {
            void bridge.loadBridgeDevices();
            void releases.reload();
          }}
          type="button"
        >
          <IconRefreshOutlineRegular size={15} />
          {bridge.bridgeBusy ? '正在刷新…' : '刷新状态'}
        </button>
      </footer>
    </DshDialog>
  );
}
