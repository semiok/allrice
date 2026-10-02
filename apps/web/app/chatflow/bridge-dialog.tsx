'use client';

import { useState } from 'react';
import {
  IconChevronDownOutlineRegular,
  IconCheckOutlineRegular,
  IconCodeOutlineRegular,
  IconCopyOutlineRegular,
  IconDownloadOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconFollowsystemOutlineRegular,
  IconGlobeOutlineRegular,
  IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import {
  BridgeReleaseDownloads,
  BridgeVersionStatus,
  compareBridgeVersions,
  type useBridgeReleases,
} from './bridge-releases';
import type { useBridge } from './use-bridge';
import css from './bridge-dialog.module.css';
import { bridgeCapabilityRows } from './bridge-view';

export function BridgeSettings({
  bridge,
  releases,
}: {
  bridge: ReturnType<typeof useBridge>;
  releases: ReturnType<typeof useBridgeReleases>;
}) {
  const devices = bridge.bridgeDevices.filter(
    (device) => device.status !== 'revoked',
  );
  const onlineDevices = bridge.bridgeStatusKnown
    ? devices.filter((device) => device.status === 'online')
    : [];
  const [installExpanded, setInstallExpanded] = useState<boolean | null>(null);
  const [disconnectId, setDisconnectId] = useState<string | null>(null);
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
  const refreshControl = (
    <div className={css.refreshRow}>
      <span role="status" data-bridge-refresh-status>
        {bridge.bridgeStatusKnown && bridge.bridgeLastRefreshedAt
          ? `已刷新 · ${new Date(bridge.bridgeLastRefreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : bridge.bridgeRefreshError || '正在确认连接状态…'}
      </span>
      <button
        data-computer-control
        className={css.textButton}
        disabled={bridge.bridgeBusy}
        onClick={() => {
          void bridge.loadBridgeDevices();
          void releases.reload();
        }}
        type="button"
      >
        <IconRefreshOutlineRegular size={16} />
        {bridge.bridgeBusy ? '正在刷新…' : '刷新状态'}
      </button>
    </div>
  );

  return (
    <div className={css.page} data-bridge-settings>
      {!devices.length && refreshControl}
      <div className={css.devices}>
        {devices.map((device, index) => {
          const online = bridge.bridgeStatusKnown && device.status === 'online';
          const rows = bridgeCapabilityRows(device);
          const available = rows.filter((row) => row.state === 'ready').length;
          return (
            <section
              key={device.id}
              aria-label={device.name}
              className={css.device}
            >
              <div className={css.deviceCard}>
                <div className={css.deviceHeader}>
                  <span className={css.computerIcon} aria-hidden="true">
                    <IconFollowsystemOutlineRegular size={20} />
                  </span>
                  <div className={css.deviceCopy}>
                    <strong>
                      {device.name.replace(/ · Rice Bridge$/, '')}
                    </strong>
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
                {index === 0 && refreshControl}
                {online ? (
                  <div className={css.folderSection}>
                    <h3>授权文件夹</h3>
                    <div
                      className={css.folder}
                      data-connected={device.folderGrants.length > 0}
                    >
                      <span className={css.folderIcon} aria-hidden="true">
                        <IconFolderOpenOutlineRegular size={17} />
                      </span>
                      <div className={css.folderCopy}>
                        <strong>
                          {device.folderGrants.length
                            ? device.folderGrants
                                .map((grant) => grant.label)
                                .join('、')
                            : '未连接文件夹'}
                        </strong>
                        <span>
                          {device.folderGrants.length
                            ? '员工仅可访问你选择的文件夹。'
                            : '选择一个文件夹，授权员工访问。'}
                        </span>
                      </div>
                      {device.folderGrants.length ? (
                        <button
                          data-computer-control
                          className={css.folderActionButton}
                          disabled={bridge.bridgeBusy}
                          aria-expanded={disconnectId === device.id}
                          onClick={() => setDisconnectId(device.id)}
                          type="button"
                        >
                          断开连接
                        </button>
                      ) : (
                        <button
                          data-computer-control
                          className={css.folderActionButton}
                          disabled={bridge.bridgeBusy}
                          onClick={() =>
                            void bridge.requestBridgeWorkspaceSelection(device)
                          }
                          type="button"
                        >
                          连接文件夹
                        </button>
                      )}
                    </div>
                    {disconnectId === device.id &&
                      device.folderGrants.length > 0 && (
                        <div className={css.disconnectConfirmation}>
                          <p>断开后，员工将无法访问这个文件夹。</p>
                          <div className={css.confirmActions}>
                            <button
                              data-computer-control
                              className={css.secondaryButton}
                              type="button"
                              onClick={() => setDisconnectId(null)}
                            >
                              取消
                            </button>
                            <button
                              data-computer-control
                              className={css.primaryButton}
                              type="button"
                              disabled={bridge.bridgeBusy}
                              onClick={() => {
                                setDisconnectId(null);
                                void bridge.disconnectBridgeWorkspace(device);
                              }}
                            >
                              确认断开
                            </button>
                          </div>
                        </div>
                      )}
                  </div>
                ) : null}
              </div>
              {bridge.bridgeStatusKnown && device.readiness ? (
                <section className={css.capabilities} aria-label="电脑能力状态">
                  <div className={css.capabilityHeading}>
                    <h3>电脑能力</h3>
                    <span>
                      {available} 项可用 · {rows.length - available} 项未就绪
                    </span>
                  </div>
                  {rows.map((row) => {
                    const Icon =
                      row.capability === 'local.browser'
                        ? IconGlobeOutlineRegular
                        : row.capability === 'local.fs.read' ||
                            row.capability === 'local.fs.write'
                          ? IconFolderOpenOutlineRegular
                          : IconCodeOutlineRegular;
                    return (
                      <div
                        key={row.capability}
                        className={css.capability}
                        data-ready={row.state === 'ready'}
                      >
                        <div className={css.capabilityCopy}>
                          <strong>
                            <Icon size={17} />
                            {row.label}
                          </strong>
                          {row.state !== 'ready' && <small>{row.reason}</small>}
                        </div>
                        <span className={css.capabilityState}>
                          {row.state === 'ready' && (
                            <IconCheckOutlineRegular size={15} />
                          )}
                          {row.stateLabel}
                        </span>
                      </div>
                    );
                  })}
                  {rows.some((row) => row.version) && (
                    <details className={css.capabilityVersion}>
                      <summary>版本信息</summary>
                      <dl>
                        {rows
                          .filter((row) => row.version)
                          .map((row) => (
                            <div key={row.capability}>
                              <dt>{row.label}</dt>
                              <dd>{row.version}</dd>
                            </div>
                          ))}
                      </dl>
                    </details>
                  )}
                </section>
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
            data-computer-control
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
                  data-computer-control
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
    </div>
  );
}
