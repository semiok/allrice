'use client';
import type {
  WorkspaceCapability,
  WorkspaceCapabilityId,
  WorkspaceReadiness,
} from '@allrice/contracts';
import { IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  capabilityLabels,
  capabilityReason,
  capabilityStateLabels,
} from './capability-catalog';
import styles from './capability-panel.module.css';
const groups: Record<
  'work' | 'computer',
  { label: string; description?: string; ids: WorkspaceCapabilityId[] }
> = {
  work: {
    label: '云端与子智能体状态',
    ids: [
      'report',
      'cloud_command',
      'cloud_browser',
      'assistants',
      'boost',
      'teamwork',
    ],
  },
  computer: {
    label: '本地能力状态',
    description: '根据当前员工、电脑环境和已授权文件夹检查。',
    ids: [
      'local_files',
      'changeset',
      'local_command',
      'local_browser',
      'development',
    ],
  },
};

function summarizeCapabilities(
  ids: WorkspaceCapabilityId[],
  data: WorkspaceReadiness | null,
  loading: boolean,
  error: string,
) {
  if (loading) return { state: 'unknown', label: '正在检查' };
  const states = ids.map(
    (id) =>
      data?.capabilities.find((capability) => capability.id === id)?.state,
  );
  if (!data || error || states.some((state) => !state || state === 'unknown'))
    return { state: 'unknown', label: '状态未知' };
  const released = states.filter((state) => state !== 'not_released');
  if (released.length === 0)
    return { state: 'not_released', label: '暂未开放' };
  if (released.every((state) => state === 'ready'))
    return { state: 'ready', label: '已就绪' };
  if (released.some((state) => state === 'ready'))
    return { state: 'partial', label: '部分可用' };
  return { state: 'unavailable', label: '尚未就绪' };
}

function stateLabel(
  capability: WorkspaceCapability | undefined,
  loading: boolean,
) {
  if (!capability) return loading ? '正在检查' : capabilityStateLabels.unknown;
  if (capability.reason === 'employee_policy') return '员工未提供';
  if (capability.reason === 'bridge_missing') return '连接电脑';
  if (capability.reason === 'folder_missing') return '选择文件夹';
  if (capability.reason === 'device_paused') return '已暂停';
  return capabilityStateLabels[capability.state];
}

export function CapabilityContent({
  scope,
  data,
  loading,
  error,
  busy,
  onRefresh,
  onBridge,
  onCompose,
  intelComputer = false,
}: {
  scope: 'work' | 'computer';
  data: WorkspaceReadiness | null;
  loading: boolean;
  error: string;
  busy: boolean;
  onRefresh: () => void;
  onBridge: () => void;
  onCompose: (id: WorkspaceCapabilityId) => void;
  /** Only Intel Macs are paired: they get no new versions (MET-214). */
  intelComputer?: boolean;
}) {
  const group = groups[scope];
  const summary = summarizeCapabilities(group.ids, data, loading, error);
  return (
    <div className={styles.body} data-capability-scope={scope}>
      {scope === 'work' && <h3 className={styles.heading}>当前能力</h3>}
      <details className={styles.group}>
        <summary className={styles.groupTitle}>
          <span>{group.label}</span>
          <span className={styles.groupStatus} data-state={summary.state}>
            {summary.label}
          </span>
          <IconChevronRightOutlineRegular size={14} />
        </summary>
        <div className={styles.groupBody}>
          {group.description && (
            <p className={styles.groupDescription}>{group.description}</p>
          )}
          <div className={styles.refresh}>
            <button type="button" onClick={onRefresh} disabled={loading}>
              {loading ? '正在检查…' : '刷新能力状态'}
            </button>
            <small role="status">
              {data && !error
                ? `更新于 ${new Date(data.observedAt).toLocaleTimeString()}`
                : '状态待确认，不代表可执行。'}
            </small>
          </div>
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
                'runtime_unsupported',
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
                  <span>{stateLabel(capability, loading)}</span>
                </summary>
                <div className={styles.cardBody}>
                  <p>{label.description}</p>
                  <p>
                    {capability
                      ? capabilityReason(capability.reason, intelComputer)
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
                              按住 Option 键点菜单栏的
                              AllRice，在“开发者工具”里选择“重新检查并准备环境”，已有的独立沙箱会自动恢复。
                            </li>
                            <li>
                              通用计算可以直接让员工使用云端环境；涉及本地文件时，先在当前任务中选择所需文件。
                            </li>
                            <li>
                              本地项目服务仍需要电脑上的环境。保持电脑连接，准备完成后刷新这里查看实际状态。
                            </li>
                          </>
                        ) : (
                          <>
                            <li>
                              {capabilityReason(
                                capability.reason,
                                intelComputer,
                              )}
                            </li>
                            <li>
                              完成后点击“刷新能力状态”。其他可用能力可以继续使用。
                            </li>
                          </>
                        )}
                      </ol>
                      {['local_command', 'changeset', 'local_browser'].includes(
                        id,
                      ) && (
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
          <p className={styles.taskHint}>
            “准备任务”会将指引加入输入框，发送后开始。执行时遵循你的授权与工作方式。
          </p>
        </div>
      </details>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
