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
  capabilitySettingsHref,
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
  onCompose,
}: {
  data: WorkspaceReadiness | null;
  loading: boolean;
  error: string;
  busy: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onBridge: () => void;
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
        入口可见不等于获得授权。这里显示下一项任务的配置，不改变正在运行的任务；具体操作仍走原有审批与预算检查。
      </p>
      <p>
        Bridge
        非必装。云端任务可独立执行；本地设备离线不会隐式上传文件或迁移在途操作。
      </p>
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
          const href =
            capability && data?.canAdminister
              ? capabilitySettingsHref(capability.action, data.workspaceId)
              : null;
          const state = capability?.state ?? 'unknown';
          return (
            <article
              key={id}
              data-capability={id}
              data-state={state}
              className={styles.card}
            >
              <header>
                <h3>{label.title}</h3>
                <span>{capabilityStateLabels[state]}</span>
              </header>
              <p>{label.description}</p>
              <p>
                {capability
                  ? capabilityReasons[capability.reason]
                  : '尚未取得当前状态，请刷新确认。'}
              </p>
              {capability && (
                <small>
                  下一步由
                  {capability.responsibleRole === 'platform_admin'
                    ? '平台管理员'
                    : capability.responsibleRole === 'tenant_admin'
                      ? '当前租户管理员'
                      : '你'}
                  处理。
                  {capability.authorization === 'per_action'
                    ? '执行仍需对精确动作逐次审批。'
                    : capability.authorization === 'root_budget'
                      ? '助手仍共用父任务预算。'
                      : ''}
                </small>
              )}
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
              ) : capability?.action === 'bridge' ? (
                <button type="button" onClick={onBridge}>
                  打开 Bridge 下载与配对
                </button>
              ) : href ? (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  打开配置（新标签页）
                </a>
              ) : null}
              {capability && state !== 'ready' && (
                <details>
                  <summary>查看处理步骤</summary>
                  <ol>
                    {capability.reason === 'runner_missing' ? (
                      <>
                        <li>
                          打开 Bridge
                          的“诊断与日志”，核对平台、工作区、沙箱状态与最近报告。
                        </li>
                        <li>
                          由设备所有者与管理员按已验收的 Bridge
                          沙箱安装流程配置独立 Linux 环境和匹配工具链；安装
                          Bridge 本身不会安装沙箱。
                        </li>
                        <li>
                          显式启用沙箱后保持 Bridge
                          在线，回到这里刷新；不要为了通过检查开放宿主 Shell。
                        </li>
                      </>
                    ) : (
                      <>
                        <li>{capabilityReasons[capability.reason]}</li>
                        <li>
                          {data?.canAdminister
                            ? '在对应租户设置核对；若没有配置入口，联系平台管理员处理部署或员工发布。'
                            : '向当前租户管理员提供上面的能力名称和原因；不需要进入平台后台。'}
                        </li>
                        <li>
                          配置完成后返回并刷新。只有状态核实后才准备任务，批准计划或查看
                          Diff 不等于授权执行。
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
                      查看 Bridge 与工作区
                    </button>
                  )}
                </details>
              )}
            </article>
          );
        })}
      </div>
      <p>
        “准备任务”只把可编辑指引加入输入框，不会自动发送、安装环境或授予权限。打开此面板时检查一次；配置完成后，点击“刷新能力状态”更新。
      </p>
    </DshDialog>
  );
}
