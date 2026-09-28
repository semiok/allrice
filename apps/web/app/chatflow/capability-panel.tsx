'use client';
import type {
  WorkspaceCapabilityId,
  WorkspaceReadiness,
} from '@allrice/contracts';
import {
  capabilityLabels,
  capabilityReasonLabel,
  capabilityStateLabels,
} from './capability-catalog';
import styles from './capability-panel.module.css';
import { OnlineAppConnections } from './online-app-connections';

const groups: { label: string; ids: WorkspaceCapabilityId[] }[] = [
  {
    label: '云端能力',
    ids: ['report', 'cloud_command', 'cloud_browser', 'cloud_mcp'],
  },
  {
    label: '本地能力',
    ids: [
      'local_files',
      'changeset',
      'local_command',
      'local_browser',
      'local_mcp',
      'development',
    ],
  },
  { label: '助手协作', ids: ['assistants', 'boost', 'teamwork'] },
];
export function CapabilityContent({
  data,
  loading,
  error,
  busy,
  onRefresh,
  onBridge,
  onConnections,
  onCompose,
}: {
  data: WorkspaceReadiness | null;
  loading: boolean;
  error: string;
  busy: boolean;
  onRefresh: () => void;
  onBridge: () => void;
  onConnections: () => void;
  onCompose: (id: WorkspaceCapabilityId) => void;
}) {
  return (
    <div className={styles.body}>
      <p>查看当前员工的能力。需要连接账号或选择文件夹时，员工会引导你完成。</p>
      <div className={styles.refresh}>
        <button type="button" onClick={onRefresh} disabled={loading}>
          {loading ? '正在检查…' : '刷新能力状态'}
        </button>
        <small role="status">
          {error ||
            (data
              ? `更新于 ${new Date(data.observedAt).toLocaleTimeString()}`
              : '状态待确认，不代表可执行。')}
        </small>
      </div>
      <div className={styles.grid}>
        {groups.map((group) => (
          <details
            className={styles.group}
            key={group.label}
            open={group.label === '云端能力'}
          >
            <summary className={styles.groupTitle}>
              {group.label}
              <span>{group.ids.length} 项</span>
            </summary>
            {group.ids.map((id) => {
              const label = capabilityLabels[id],
                capability = data?.capabilities.find((c) => c.id === id);
              const state = capability?.state ?? 'unknown';
              const localSetup =
                capability &&
                [
                  'bridge_missing',
                  'bridge_offline',
                  'folder_missing',
                  'device_paused',
                  'browser_unavailable',
                  'runner_missing',
                  'candidate_runner_missing',
                ].includes(capability.reason);
              return (
                <details
                  key={id}
                  data-capability={id}
                  data-state={state}
                  className={styles.card}
                >
                  <summary className={styles.cardTitle}>
                    <h3>{label.title}</h3>
                    <span>
                      {capability?.reason === 'employee_policy'
                        ? '员工未提供'
                        : capability?.reason === 'bridge_missing'
                          ? '连接电脑'
                          : capability?.reason === 'folder_missing'
                            ? '选择文件夹'
                            : capability?.reason === 'device_paused'
                              ? '已暂停'
                              : id === 'local_mcp' &&
                                  capability?.reason === 'connection_missing'
                                ? '未配置本地服务'
                                : capabilityStateLabels[state]}
                    </span>
                  </summary>
                  <div className={styles.cardBody}>
                    <p>{label.description}</p>
                    <p>
                      {capability
                        ? capabilityReasonLabel(capability)
                        : '尚未取得当前状态，请刷新确认。'}
                    </p>
                    {capability?.action === 'compose' &&
                    state === 'ready' &&
                    label.prompt ? (
                      <button
                        type="button"
                        disabled={busy || loading}
                        onClick={() => onCompose(id)}
                      >
                        准备{label.title}任务
                      </button>
                    ) : localSetup ? (
                      <button type="button" onClick={onBridge}>
                        {capability.reason === 'folder_missing'
                          ? '选择工作文件夹'
                          : '连接与管理电脑'}
                      </button>
                    ) : null}
                    {id === 'cloud_mcp' && data && (
                      <>
                        <OnlineAppConnections
                          key={`${data.organizationId}/${data.workspaceId}/${data.viewerId}`}
                          workspaceId={data.workspaceId}
                          organizationId={data.organizationId}
                          refreshKey={data.observedAt}
                        />
                        <button type="button" onClick={onConnections}>
                          已连接应用
                        </button>
                      </>
                    )}
                    {id === 'local_mcp' && data && (
                      <button type="button" onClick={onConnections}>
                        查看已连接应用
                      </button>
                    )}
                    {capability?.reason === 'runner_missing' &&
                      id === 'local_command' &&
                      data?.capabilities.some(
                        (c) => c.id === 'cloud_command' && c.state === 'ready',
                      ) && (
                        <button
                          type="button"
                          disabled={busy || loading}
                          onClick={() => onCompose('cloud_command')}
                        >
                          改用云端计算
                        </button>
                      )}
                    {capability && state !== 'ready' && (
                      <details>
                        <summary>查看处理步骤</summary>
                        <ol>
                          {capability.reason === 'runner_missing' ? (
                            <>
                              <li>
                                在 Bridge
                                菜单选择“重新检查并准备环境”，已有独立沙箱会自动恢复。
                              </li>
                              <li>
                                通用计算可以直接让员工使用云端环境；涉及本地文件时，先在当前任务中选择所需文件。
                              </li>
                              <li>
                                本地项目服务仍需要本机环境。保持 Bridge
                                在线，准备完成后刷新这里查看实际状态。
                              </li>
                            </>
                          ) : (
                            <>
                              <li>{capabilityReasonLabel(capability)}</li>
                              <li>
                                完成后点击“刷新能力状态”。其他可用能力可以继续使用。
                              </li>
                            </>
                          )}
                        </ol>
                        {[
                          'local_command',
                          'local_mcp',
                          'changeset',
                          'local_browser',
                        ].includes(id) && (
                          <button type="button" onClick={onBridge}>
                            连接与管理电脑
                          </button>
                        )}
                      </details>
                    )}
                  </div>
                </details>
              );
            })}
          </details>
        ))}
      </div>
      <p>
        “准备任务”会将指引加入输入框，发送后开始。执行时遵循你的授权与工作方式。
      </p>
    </div>
  );
}
