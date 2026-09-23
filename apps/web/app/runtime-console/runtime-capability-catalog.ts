export type RuntimeCapabilitySource = 'allrice' | 'blocked';

export interface RuntimeCapabilityCatalogItem {
  id: string;
  name: string;
  packageName?: string;
  detail: string;
  policy: string;
}

export interface RuntimeCapabilityCatalogGroup {
  source: RuntimeCapabilitySource;
  title: string;
  badge: string;
  description: string;
  items: readonly RuntimeCapabilityCatalogItem[];
}

export const runtimeCapabilityCatalog: readonly RuntimeCapabilityCatalogGroup[] =
  [
    {
      source: 'allrice',
      title: 'AllRice 执行能力说明',
      badge: '接入说明',
      description:
        '以下说明各能力的接入方式；实际开启与发布状态以上方实时数据为准。',
      items: [
        {
          id: 'subagent',
          name: '并行助手与开发协作',
          packageName: '@deepseek-ai/dsh-subagent',
          detail:
            '复用原生助手派发与消息，已接通父子任务、共享预算、候选测试和独立审查。',
          policy: '员工配置后按租户试用与发布',
        },
        {
          id: 'chatflow',
          name: 'ChatFlow 3.0',
          detail: '管理多租户 Session、Run、原生事件流、恢复和 Harness 路由。',
          policy: 'AllRice 核心基建',
        },
        {
          id: 'tool-broker',
          name: 'AllRice Tool Broker',
          detail: '冻结能力快照，执行租户权限校验、审批、代理与审计。',
          policy: '服务端授权边界',
        },
        {
          id: 'native-tool-adapter',
          name: 'DSH Native Tool Adapter',
          detail:
            '把审核后的 AllRice Tool 注册为真正的 DSH Tool，而非提示词占位。',
          policy: '白名单注册',
        },
        {
          id: 'rice-bridge',
          name: 'Rice Bridge',
          detail:
            '提供授权目录读写、Git 只读、独立浏览器与沙箱命令；支持在隔离副本测试候选修改。',
          policy: '设备授权目录内受控读写；覆盖需校验 SHA-256',
        },
        {
          id: 'codex-search',
          name: 'Codex 托管联网搜索',
          detail: '使用平台 Codex 订阅执行受控的 web.search，并输出引用。',
          policy: '平台托管搜索 Tool',
        },
        {
          id: 'employee-assembly',
          name: 'AI 员工能力装配',
          detail: '按员工绑定 Skill、Workflow、Knowledge、模型与安全策略。',
          policy: '下一次 Run 冻结生效',
        },
      ],
    },
    {
      source: 'blocked',
      title: '原生工具与 AllRice 执行方式',
      badge: '按环境选择',
      description:
        '原生主机工具可在独立 Lab 中探索。租户侧通过已接入的 Bridge、沙箱和连接器执行，以下列出对应方式。',
      items: [
        {
          id: 'bash',
          name: 'Shell / 持久终端',
          packageName:
            '@deepseek-ai/dsh-tool-bash · @deepseek-ai/dsh-tool-bash-persistent',
          detail:
            'DSH 原生工具面向主机终端；AllRice 已提供本地和云端沙箱命令。',
          policy: '使用沙箱命令',
        },
        {
          id: 'host-fs',
          name: '宿主文件系统工具',
          packageName:
            '@deepseek-ai/dsh-tool-fs · @deepseek-ai/dsh-tool-fs-search',
          detail:
            '直接读取 Worker 文件系统；本地文件必须改走 Rice Bridge 授权目录。',
          policy: '由 Tool Broker 替代',
        },
        {
          id: 'mcp',
          name: 'MCP 连接器',
          detail:
            'AllRice 已接通云端与本地 MCP，可发现工具、配置连接并绑定员工版本。',
          policy: '在租户连接器中配置',
        },
        {
          id: 'dynamic-plugin',
          name: '动态插件安装',
          detail: '运行时下载或启用未审核代码会绕过固定版本准入和发布流程。',
          policy: '仅允许审核后发布',
        },
        {
          id: 'host-browser',
          name: '宿主浏览器与桌面自动化',
          detail:
            '这里禁止的是读取宿主桌面状态的浏览器；受控的 SaaS Managed Browser 是独立能力。',
          policy: '宿主能力默认禁止',
        },
      ],
    },
  ];
