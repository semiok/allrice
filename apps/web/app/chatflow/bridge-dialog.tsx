'use client';

import { useState } from 'react';
import {
  IconBranchOutlineRegular,
  IconChevronDownOutlineRegular,
  IconCheckOutlineRegular,
  IconCodeOutlineRegular,
  IconCopyOutlineRegular,
  IconDownloadOutlineRegular,
  IconDeliverDocRegular,
  IconFolderOpenOutlineRegular,
  IconFollowsystemOutlineRegular,
  IconGlobeOutlineRegular,
  IconRefreshOutlineRegular,
  IconRightUpOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import {
  BridgeReleaseDownloads,
  BridgeVersionStatus,
  compareBridgeVersions,
  type useBridgeReleases,
} from './bridge-releases';
import type { useBridge } from './use-bridge';
import css from './bridge-dialog.module.css';
import {
  bridgeCapabilityRows,
  bridgeDeviceName,
  bridgeWorkspaceIssue,
  bridgePreparationLabel,
} from './bridge-view';

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
      : bridge.bridgeBusy || (!releases.releases && !releases.error)
        ? '检查中'
        : '待确认';
  const refreshControl = (
    <button
      data-computer-control
      className={css.refreshButton}
      disabled={bridge.bridgeBusy}
      aria-label="刷新状态"
      aria-busy={bridge.bridgeBusy}
      title="刷新电脑连接状态"
      onClick={() => {
        void bridge.loadBridgeDevices();
        void releases.reload();
      }}
      type="button"
    >
      <IconRefreshOutlineRegular size={16} />
    </button>
  );

  return (
    <div className={css.page} data-bridge-settings>
      {!devices.length && (
        <div className={css.emptyState}>
          <span role="status">
            {bridge.bridgeStatusKnown
              ? '还没有连接电脑'
              : bridge.bridgeRefreshError || '正在确认连接状态…'}
          </span>
          {refreshControl}
        </div>
      )}
      <div className={css.devices}>
        {devices.map((device) => {
          const online = bridge.bridgeStatusKnown && device.status === 'online';
          const workspaceIssue = bridgeWorkspaceIssue(device);
          const rows = bridgeCapabilityRows(device);
          const available = online
            ? rows.filter((row) => row.state === 'ready').length
            : 0;
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
                    <strong>{bridgeDeviceName(device.name)}</strong>
                    <div className={css.deviceMeta}>
                      <span>
                        {device.platform === 'macos-arm64'
                          ? 'M 芯片'
                          : 'Intel 芯片'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>AllRice 电脑端</span>
                      {bridge.bridgeStatusKnown &&
                        bridge.bridgeLastRefreshedAt && (
                          <span
                            className={css.refreshedAt}
                            data-bridge-refresh-status
                          >
                            ·{' '}
                            {new Date(
                              bridge.bridgeLastRefreshedAt,
                            ).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}{' '}
                            更新
                          </span>
                        )}
                    </div>
                  </div>
                  <div className={css.deviceActions}>
                    <span
                      className={css.connection}
                      data-online={online}
                      data-bridge-connection
                    >
                      <i aria-hidden="true" />
                      {!bridge.bridgeStatusKnown
                        ? '待确认'
                        : online
                          ? '已连接'
                          : '未连接'}
                    </span>
                    {refreshControl}
                  </div>
                </div>
                {online ? (
                  <div className={css.folderSection} data-bridge-folder>
                    <div
                      className={css.folder}
                      data-connected={
                        device.folderGrants.length > 0 && !workspaceIssue
                      }
                    >
                      <span className={css.computerIcon} aria-hidden="true">
                        <IconFolderOpenOutlineRegular size={20} />
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
                          {workspaceIssue ??
                            (device.folderGrants.length
                              ? '授权文件夹 · 员工仅可访问此文件夹。'
                              : '选择一个文件夹，授权员工访问。')}
                        </span>
                      </div>
                      {device.folderGrants.length && !workspaceIssue ? (
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
                          {workspaceIssue && device.folderGrants.length
                            ? '重新选择文件夹'
                            : '连接文件夹'}
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
                ) : (
                  <div className={css.folderSection} data-bridge-folder>
                    <div className={css.folder}>
                      <span className={css.computerIcon} aria-hidden="true">
                        <IconFolderOpenOutlineRegular size={20} />
                      </span>
                      <div className={css.folderCopy}>
                        <strong>授权文件夹</strong>
                        <span>
                          {bridge.bridgeStatusKnown
                            ? '电脑未连接，连接后可以管理文件夹。'
                            : '连接状态待确认，请刷新后管理文件夹。'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              {online &&
                device.preparation?.some((item) => item.stage !== 'ready') && (
                  <div
                    className={css.preparation}
                    aria-label="运行环境准备进度"
                    role="status"
                  >
                    {device.preparation.map((item) => (
                      <div key={item.component}>
                        <strong>
                          {
                            {
                              vm: '计算环境',
                              node: 'Node 运行包',
                              python: 'Python 运行包',
                            }[item.component]
                          }
                        </strong>
                        <span>{bridgePreparationLabel(item)}</span>
                        {item.stage === 'failed' && (
                          <small>
                            在 AllRice
                            电脑端的菜单里选择“重新检查并准备环境”继续，已下载的部分不用重新下载。
                          </small>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              {bridge.bridgeStatusKnown && device.readiness ? (
                <details
                  className={css.capabilities}
                  aria-label="电脑能力状态"
                  data-bridge-capabilities
                >
                  <summary>
                    <span>能力详情</span>
                    <small>
                      {online
                        ? `${available} 项可用 · ${rows.length - available} 项未就绪`
                        : '连接后检查'}
                    </small>
                    <IconChevronDownOutlineRegular size={16} />
                  </summary>
                  {rows.map((row) => {
                    const ready = online && row.state === 'ready';
                    const Icon =
                      row.capability === 'local.browser'
                        ? IconGlobeOutlineRegular
                        : row.capability === 'local.fs.read' ||
                            row.capability === 'local.fs.write'
                          ? IconFolderOpenOutlineRegular
                          : row.capability === 'local.git.status'
                            ? IconBranchOutlineRegular
                            : row.capability === 'local.preview'
                              ? IconRightUpOutlineRegular
                              : row.capability === 'local.office'
                                ? IconDeliverDocRegular
                                : IconCodeOutlineRegular;
                    return (
                      <div
                        key={row.capability}
                        className={css.capability}
                        data-ready={ready}
                      >
                        <div className={css.capabilityCopy}>
                          <strong>
                            <Icon size={16} />
                            {row.label}
                          </strong>
                          {!ready && (
                            <small>
                              {online
                                ? row.reason
                                : '请打开电脑上的 AllRice 电脑端。'}
                            </small>
                          )}
                        </div>
                        <span className={css.capabilityState}>
                          {ready && <IconCheckOutlineRegular size={14} />}
                          {online ? row.stateLabel : '未连接'}
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
                </details>
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
            ? '打开这台电脑上的 AllRice 电脑端，就能重新连接。'
            : '还没有连接电脑。安装 AllRice 电脑端后，输入配对码就能连接。'}
        </p>
      ) : null}
      {bridge.bridgeRecoveryActive && onlineDevices.length ? (
        <p className={css.notice} role="status">
          请在 Mac 弹出的窗口中选择文件夹，这里会自动更新。
        </p>
      ) : null}
      <details className={css.install} open={installOpen} data-bridge-install>
        <summary
          onClick={(event) => {
            event.preventDefault();
            setInstallExpanded(!installOpen);
          }}
        >
          <IconDownloadOutlineRegular size={18} />
          <span>下载与安装</span>
          <small data-bridge-update={versionHint === '有新版本'}>
            {versionHint}
          </small>
          <IconChevronDownOutlineRegular size={16} />
        </summary>
        <div className={css.installBody}>
          {devices.map((device) => (
            <p key={device.id} className={css.installedVersion}>
              <span>
                {devices.length > 1
                  ? bridgeDeviceName(device.name)
                  : 'AllRice 电脑端'}{' '}
                ·{' '}
              </span>
              <BridgeVersionStatus
                installed={device.clientVersion}
                release={releases.releases?.find(
                  (item) => item.platform === device.platform,
                )}
                online={bridge.bridgeStatusKnown && device.status === 'online'}
                compact
              />
            </p>
          ))}
          <BridgeReleaseDownloads
            releases={releases.releases}
            error={releases.error}
            onDownload={bridge.noteBridgeDownload}
          />
          <p>
            解压后双击打开里面的应用。升级前先退出旧版，原有配对和设置会保留。
          </p>
          <p>
            这是测试版。第一次打开时，macOS
            可能提示“无法验证开发者”，请到“系统设置 →
            隐私与安全性”里点“仍要打开”。
          </p>
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
              <p>
                请在 10 分钟内把配对码输入到 AllRice 电脑端，之后会自动连接。
              </p>
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
