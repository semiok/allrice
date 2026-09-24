'use client';
import type {
  WorkspaceCapabilityId,
  WorkspaceReadiness,
} from '@allrice/contracts';
import { workspaceCapabilityIds } from '@allrice/contracts';
import { DshDialog } from './dsh-upstream/Dialog';
import {
  capabilityLabels,
  capabilityReasons,
  capabilityStateLabels,
} from './capability-catalog';
import styles from './capability-panel.module.css';

export function CapabilityPanel({
  data,
  loading,
  error,
  busy,
  onClose,
  onRefresh,
  onBridge,
  onConnections,
  onCompose,
}: {
  data: WorkspaceReadiness | null;
  loading: boolean;
  error: string;
  busy: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onBridge: () => void;
  onConnections: () => void;
  onCompose: (id: WorkspaceCapabilityId) => void;
}) {
  return (
    <DshDialog
      ariaLabel="能力与环境"
      title="能力与环境"
      eyebrow="Rice 工作台"
      onClose={onClose}
      className={styles.dialog}
      bodyClassName={styles.body}
    >
      <p>
        当前员工可用的能力和环境。直接告诉员工你的任务；需要登录账号或选择本地文件时，会在任务中引导你完成。
      </p>
      <p>云端工作无需安装软件。处理电脑里的文件时，再连接 Bridge。</p>
      <div className={styles.refresh}>
        <button type="button" onClick={onRefresh} disabled={loading}>
          {loading ? '正在检查…' : '刷新能力状态'}
        </button>
        <small role="status">
          {error ||
            (data
              ? `核对时间 ${new Date(data.observedAt).toLocaleTimeString()} · 配置 ${data.employeeVersionId?.slice(0, 8) ?? '待配置'}`
              : '状态待确认，不代表可执行。')}
        </small>
      </div>
      <div className={styles.grid}>
        {workspaceCapabilityIds.map((id) => {
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
            <article
              key={id}
              data-capability={id}
              data-state={state}
              className={styles.card}
            >
              <header>
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
                          : capabilityStateLabels[state]}
                </span>
              </header>
              <p>{label.description}</p>
              <p>
                {capability
                  ? capabilityReasons[capability.reason]
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
                <button type="button" onClick={onConnections}>
                  已连接应用
                </button>
              )}
              {id === 'local_mcp' &&
                state !== 'ready' &&
                data?.capabilities.some(
                  (c) => c.id === 'cloud_mcp' && c.state === 'ready',
                ) && (
                  <button
                    type="button"
                    disabled={busy || loading}
                    onClick={() => onCompose('cloud_mcp')}
                  >
                    让员工连接在线应用
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
                        <li>{capabilityReasons[capability.reason]}</li>
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
            </article>
          );
        })}
      </div>
      <p>
        “准备任务”会把指引加入输入框，编辑后发送即可。打开时检查一次；完成连接后可手动刷新。具体写入和执行操作仍在任务中确认。
      </p>
    </DshDialog>
  );
}
