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
    description: '生成可下载、审查和追溯版本的报告、表格或文件。',
    prompt:
      '请围绕【填写研究主题或文件要求】完成研究。区分已确认的事实与推断，注明来源和数据日期；把报告保存为正式交付的 Markdown 文件，保存成功后给出摘要和下载入口，没保存成功就明确说明。不要把聊天草稿当作已交付文件。',
  },
  local_files: {
    title: '本地文件读取',
    description: '读取你已授权的本地文件夹，需要保持电脑连接。',
    prompt:
      '请只读检查我已授权的本地工作区，先列出文件和项目概况，不修改文件，不上传本地材料。',
  },
  changeset: {
    title: '文件修改与审查',
    description: '先展示文件修改，按你的工作方式自动应用或确认后保存。',
    prompt:
      '请针对【填写需要修改的文件与目标】，先读取原文，再把要改的内容做成逐个文件的改前改后对比，作为修改提案交给我审查（不是计划文档）。在我明确要求应用这一次修改之前，不要改动文件；如果文件在此期间被改过，停下来重新读取并确认。',
  },
  local_command: {
    title: '本地沙箱命令',
    description: '在电脑上的独立环境运行代码、验证项目和处理数据。',
    prompt:
      '请在我电脑上的隔离副本里检查【填写项目与测试目标】。直接提交要运行的准确命令和用到的文件，平台会按我的工作方式自动执行或请我确认，不用先在聊天里问我；最后按实际结果告诉我命令是否成功和输出内容，被拒绝、取消或超时也要如实说明。不要改用我电脑本机的终端。',
  },
  cloud_command: {
    title: '云端沙箱计算',
    description: '在已配置的云端隔离环境处理数据，无需本地设备在线。',
    prompt:
      '请在已授权的云端沙箱中完成【填写数据处理任务】，明确输入文件、脚本和输出文件，等待这一次执行批准后计算并交付结果。不要隐式上传本地文件。',
  },
  cloud_browser: {
    title: '云端浏览器',
    description: '使用专用云端浏览器访问网页，需要登录时由你接管。',
    prompt:
      '请使用已授权的云端浏览器访问【填写目标网址】，核查【填写目标】，记录网址、时间和证据并交付成果。涉及提交或修改时按我的工作方式执行；需要登录时交给我人工接管。',
  },
  local_browser: {
    title: '本地独立浏览器',
    description: '使用电脑上的专用浏览器访问网页，无需选择文件夹。',
    prompt:
      '请使用我电脑上的独立浏览器打开【填写网址】并核查【填写目标】，不要使用我个人的 Chrome。涉及提交或修改时按我的工作方式执行；电脑未连接时停下来告诉我，不要转到云端。',
  },
  cloud_mcp: {
    title: '在线应用',
    description:
      '使用 GitHub、Linear 等在线应用，不需要连接电脑。已有连接可直接复用，新增私人账号时由你本人登录。',
    prompt:
      '请连接【填写应用名称或服务地址】并完成【填写业务任务】。优先复用我的已有连接；需要登录或填写凭据时，提供专用连接入口，完成后继续本任务。不要让我把密码或令牌发到聊天中。',
  },
  local_mcp: {
    title: '电脑上的应用工具',
    description:
      '通过 AllRice 助手使用电脑上配置的应用服务，需要保持电脑连接。',
    prompt:
      '请使用我电脑上已授权的本地应用工具完成【填写业务任务】，全程固定在同一台电脑、同一个授权文件夹和同一版本的工具上，按我的工作方式自动执行或请我确认；不要安装来历不明的服务，也不要改到云端执行。',
  },
  assistants: {
    title: '子智能体协作',
    description: '按任务需要安排子智能体协作，遵循当前任务的授权与预算。',
    prompt:
      '请完成【填写可拆分的任务】。如适合并行且我已允许子智能体，请安排有限的子智能体并在本任务中汇总结果；不可扩大权限或预算。',
  },
  boost: {
    title: '深入攻关',
    description: '更深入的协作攻关方式，尚未开放。',
  },
  development: {
    title: '受控开发协作',
    description:
      '安排子智能体修改、测试和审查授权项目，按工作方式执行，共用当前任务预算。',
    prompt:
      '请在我已授权的本地工作区完成【填写开发目标及目录范围】：安排少量子智能体把修改做成候选修改提案（逐个文件的改前改后对比，不是计划文档），在我电脑上的隔离副本里测试这同一个候选版本，再交给没有参与编写的子智能体独立审查。测试命令和最终的文件修改按我的工作方式执行；最后告诉我这个候选版本的校验值、真实的测试结果和审查结论。电脑未连接时不要转到云端。',
  },
  teamwork: {
    title: '团队任务',
    description: '团队任务协作方式，尚未开放。',
  },
};
export const capabilityStateLabels = {
  ready: '可用',
  preparing: '正在准备',
  busy: '本机忙碌',
  paused: '已暂停',
  unsupported: '尚未就绪',
  needs_configuration: '需要配置',
  needs_authorization: '需要授权',
  device_offline: '电脑未连接',
  not_released: '暂未开放',
  unknown: '状态未知',
};
export const capabilityReasons: Record<WorkspaceCapability['reason'], string> =
  {
    ready: '已就绪，可以直接交给员工处理。',
    release_disabled: '这项能力还没有开放，需要的话请联系管理员。',
    planned: '此能力仍在后续规划中，当前不可执行。',
    employee_missing:
      '当前没有可用的员工配置。可在左侧选择已派驻员工，或等待新的员工派驻。',
    employee_policy:
      '当前员工未提供或已停用此能力。可在左侧选择具备该能力的员工继续处理。',
    policy_missing: '当前员工的工作区配置尚未准备完成，请稍后重试。',
    policy_denied: '此操作已被工作区停用。其他已开启的能力仍可使用。',
    read_only: '当前账号为历史只读授权，请联系平台管理员调整。',
    provider_unsupported: '当前对话暂不支持子智能体，可由当前员工继续处理。',
    bridge_missing:
      '连接电脑后就能处理电脑上的任务。点下方按钮下载 AllRice 助手并完成配对。',
    bridge_offline:
      '电脑未连接。请打开 AllRice 助手后刷新；不会自动改到云端执行。',
    folder_missing: '电脑已连接。选择需要交给员工处理的文件夹即可。',
    environment_preparing:
      'AllRice 助手正在自动准备环境，稍后刷新就能看到结果；其他已就绪的能力可以继续使用。',
    environment_busy: '本机正在处理已有任务，新任务等待本机释放资源。',
    runtime_unsupported:
      '当前电脑缺少此能力所需条件，可在「我的电脑」查看具体缺项。',
    device_paused:
      '此能力已暂停。请在「设置 → 我的电脑」中开启；如果 AllRice 助手整体暂停了，请在电脑上恢复。',
    browser_unavailable:
      '独立浏览器还没准备好。缺少 Chrome 时，点菜单栏的 AllRice 选择“安装或更新 Chrome…”；装好后按住 Option 键点菜单栏的 AllRice，在“开发者工具”里选择“重新检查并准备环境”。',
    runner_missing:
      '本地计算环境暂不可用。通用计算可交给员工在云端完成；本地项目服务可按住 Option 键点菜单栏的 AllRice，在“开发者工具”里选择“重新检查并准备环境”。',
    candidate_runner_missing:
      '这台电脑还不能测试修改方案。请更新 AllRice 助手，更新后会自动检查并准备独立的沙箱。',
    target_missing: '尚未配置对应执行环境，请由平台管理员准备隔离运行环境。',
    target_unavailable: '所需执行目标不可用，请恢复对应环境后刷新。',
    grant_missing:
      '当前账号的环境使用关系已停用或尚未准备完成；已有撤销不会自动恢复。',
    connection_on_demand:
      '可让员工按需连接应用。具体应用的登录与连接状态可在“已链接应用”查看。',
    connection_missing: '还没有可用的应用连接。请告诉员工需要连接哪个应用。',
    connection_unverified:
      '应用尚未连接成功，可在「设置 → 已链接应用」查看状态并重试。',
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

/** Intel Macs get no new versions (MET-214): advice that asks the computer to
 * update says what an Intel Mac's installed version cannot do instead, and
 * names the chips when Apple silicon and Intel Macs are both in use. */
const chipCapabilityReasons: Record<
  'intel' | 'mixed',
  Partial<Record<WorkspaceCapability['reason'], string>>
> = {
  intel: {
    candidate_runner_missing:
      'Intel 芯片的电脑不再提供新版本，现有版本不支持在隔离副本里测试修改方案。',
  },
  mixed: {
    candidate_runner_missing:
      '这台电脑还不能测试修改方案。Apple 芯片的电脑请更新 AllRice 助手，更新后会自动检查并准备独立的沙箱；Intel 芯片的电脑不再提供新版本，现有版本不支持在隔离副本里测试修改方案。',
  },
};
export function capabilityReason(
  reason: WorkspaceCapability['reason'],
  chips?: 'apple' | 'intel' | 'mixed' | null,
) {
  return (
    (chips === 'intel' || chips === 'mixed'
      ? chipCapabilityReasons[chips][reason]
      : undefined) ?? capabilityReasons[reason]
  );
}
