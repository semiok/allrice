import type {
  WorkspaceCapability,
  WorkspaceCapabilityId,
} from '@allrice/contracts';

export const capabilityLabels: Record<
  WorkspaceCapabilityId,
  { title: string; description: string; prompt?: string }
> = {
  report: {
    title: '报告与文件交付',
    description:
      '云端生成可审查、下载和追溯版本的报告、表格或文件。无需 Bridge。',
    prompt:
      '请围绕【填写研究主题或文件要求】完成研究。区分已核实事实与推断，注明来源和数据日期；使用已有 workspace.export.create 发布 Markdown 报告成果，发布成功后给出摘要与文件入口，失败则明确说明。不要把聊天草稿当作已交付文件。',
  },
  local_files: {
    title: '本地文件读取',
    description: '读取你明确选择的本地工作区；离线不会自动上传或交给云端代办。',
    prompt:
      '请只读检查我已授权的本地工作区，先列出文件和项目概况，不修改文件，不上传本地材料。',
  },
  changeset: {
    title: '文件修改与 Diff 审查',
    description:
      '先展示 Changeset 与 Diff，按你的工作方式自动应用或确认后保存。',
    prompt:
      '请针对【填写需要修改的文件与目标】生成 Changeset 和 Diff 供我审查；在获得这一次文件修改的明确批准前，不应用修改。发现版本冲突时停止并重新核对。',
  },
  local_command: {
    title: '本地沙箱命令',
    description:
      '在 Bridge 的独立 Linux 副本中验证项目，不是宿主机任意 Shell。',
    prompt:
      '请在已授权的 Bridge 沙箱副本中检查【填写项目与测试目标】，提交精确命令、输入文件版本和执行范围，按我的工作方式执行并交付退出码与输出。不要操作宿主 Shell。',
  },
  cloud_command: {
    title: '云端沙箱计算',
    description: '在已配置的云端隔离环境处理数据，无需本地设备在线。',
    prompt:
      '请在已授权的云端沙箱中完成【填写数据处理任务】，明确输入文件、脚本和输出文件，等待这一次执行批准后计算并交付结果。不要隐式上传本地文件。',
  },
  cloud_browser: {
    title: '云端浏览器工作区',
    description:
      '专属云端浏览器、按工作方式确认、证据与人工接管，不使用个人 Cookie。',
    prompt:
      '请使用已授权的云端浏览器访问【填写目标 URL】，核查【填写目标】，记录 URL、时间和证据并交付成果。涉及提交或修改时按我的工作方式执行；需要登录时交给我人工接管。',
  },
  local_browser: {
    title: '本地独立浏览器',
    description:
      '连接 Bridge 后自动准备独立浏览器，无需选择文件夹，不影响日常 Chrome。',
    prompt:
      '请使用已授权 Bridge 上的独立浏览器核查【填写 URL 与目标】，不要使用个人 Chrome。涉及提交或修改时按我的工作方式执行；设备离线时停止等待，不转交云端。',
  },
  cloud_mcp: {
    title: '应用连接',
    description:
      '告诉员工需要哪个应用，由员工连接并使用；私人账号需要你本人登录。',
    prompt:
      '请连接【填写应用名称或服务地址】并完成【填写业务任务】。优先复用我的已有连接；需要登录或填写凭据时，提供专用连接入口，完成后继续本任务。不要让我把密码或令牌发到聊天中。',
  },
  local_mcp: {
    title: '本地应用工具',
    description: '通过已连接的电脑使用本地安装的应用服务。',
    prompt:
      '请使用已授权的本地 MCP 工具完成【填写业务任务】，固定当前 Bridge、目录和版本，按我的工作方式执行；不要安装未知服务或迁移到云端。',
  },
  assistants: {
    title: '日常并行助手',
    description:
      '由 Rice 按任务需要安排有限助手，受父任务权限、并发与根预算约束。',
    prompt:
      '请完成【填写可拆分的任务】。如适合并行且我已允许助手，请安排有限助手并在本任务中汇总结果；不可扩大权限或预算。',
  },
  boost: {
    title: 'Boost · 深入攻关',
    description: '规划能力（MET-145），尚未开放；不是当前日常助手的别名。',
  },
  development: {
    title: '受控开发协作',
    description:
      'Rice 分派提案、候选版本沙箱测试与独立审查，汇总证据后交付；本地执行和写盘按工作方式确认，共享根任务预算。',
    prompt:
      '请在我已授权的本地工作区完成【填写开发目标及目录范围】，组织有限助手生成候选修改、在 Bridge 沙箱测试同一候选版本，并交给未参与编写的助手独立审查。测试命令和最终文件修改按我的工作方式执行，交付候选 SHA、真实测试结果与审查结论；设备离线时不要转交云端。',
  },
  teamwork: {
    title: 'Teamwork · 团队任务',
    description: '规划能力（MET-146），尚未开放；不会通过此入口启动团队模式。',
  },
};
export const capabilityStateLabels = {
  ready: '可用',
  preparing: '正在准备',
  needs_configuration: '需要配置',
  needs_authorization: '需要授权',
  device_offline: '设备离线',
  not_released: '暂未开放',
  unknown: '状态未知',
};
export const capabilityReasons: Record<WorkspaceCapability['reason'], string> =
  {
    ready: '已就绪，可以直接交给员工处理。',
    release_disabled: '当前部署尚未开放此能力；请联系平台管理员核对发布范围。',
    planned: '此能力仍在后续规划中，当前不可执行。',
    employee_missing:
      '当前没有可用的员工配置。可在左侧选择已派驻员工，或等待新的员工派驻。',
    employee_policy:
      '当前员工未提供或已停用此能力。可在左侧选择具备该能力的员工继续处理。',
    policy_missing: '当前员工的工作区配置尚未准备完成，请稍后重试。',
    policy_denied: '此操作已被工作区停用。其他已开启的能力仍可使用。',
    read_only: '当前角色不能发起执行，请向当前租户管理员申请权限。',
    provider_unsupported: '当前会话的模型暂不支持助手，可由当前员工继续处理。',
    bridge_missing:
      '连接电脑后即可处理本地任务。点击下方按钮下载并配对 Bridge。',
    bridge_offline:
      '没有在线的已配对设备；请启动 Bridge 后刷新，不自动转为云端执行。',
    folder_missing: '电脑已连接。选择需要交给员工处理的文件夹即可。',
    environment_preparing:
      'Bridge 正在自动准备环境，稍后刷新即可查看结果；其他已就绪能力可继续使用。',
    device_paused:
      '此能力已暂停。请在「设置 → 我的电脑」中开启；如果整台 Bridge 已暂停，请在本机恢复连接。',
    browser_unavailable:
      '独立浏览器暂未准备成功，请从 Bridge 菜单重新检查。缺少 Chrome 时，按提示安装后重试。',
    runner_missing:
      '本地计算环境暂不可用。通用计算可交给员工在云端完成；本地项目服务可从 Bridge 菜单重新检查并准备。',
    candidate_runner_missing:
      '当前设备未报告候选版本测试能力；请更新支持 changeset_candidate 的 Bridge，Bridge 会自动检查并准备独立沙箱。',
    target_missing: '尚未配置对应执行环境，请由平台管理员准备隔离运行环境。',
    target_unavailable: '所需执行目标不可用，请恢复对应环境后刷新。',
    grant_missing:
      '当前账号的环境使用关系已停用或尚未准备完成；已有撤销不会自动恢复。',
    connection_on_demand:
      '可让员工按需连接应用。具体应用的登录与连接状态可在“已连接应用”查看。',
    connection_missing: '还没有可用的应用连接。请告诉员工需要连接哪个应用。',
    connection_unverified:
      '应用尚未连接成功，可在「设置 → 已连接应用」查看状态并重试。',
    connection_grant_missing:
      '此应用尚不能由当前员工使用，可让员工检查连接是否就绪。',
    invalid_configuration:
      '配置无法通过校验；请联系管理员核对，不会按可用处理。',
  };
export function capabilitySettingsHref(
  action: WorkspaceCapability['action'],
  workspaceId: string,
) {
  const path =
    action === 'mcp_settings'
      ? '/workspace/mcp'
      : action === 'browser_settings'
        ? '/workspace/browser'
        : action === 'local_browser_settings'
          ? '/workspace/local-browser'
          : null;
  return path ? `${path}?workspaceId=${encodeURIComponent(workspaceId)}` : null;
}
