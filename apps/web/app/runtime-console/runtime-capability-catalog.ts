export type RuntimeCapabilitySource = 'dsh-plugin' | 'allrice' | 'blocked';

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

/**
 * Components that form the always-loaded Restricted Runtime skeleton. They are
 * deliberately kept separate from optional DSH enhancements and employee
 * business Skills so the console does not present three different concepts as
 * one catalog.
 */
export const dshRuntimeCoreComponents: readonly RuntimeCapabilityCatalogItem[] =
  [
    {
      id: 'credentials',
      name: '凭证存储',
      packageName: '@deepseek-ai/dsh-credentials-local',
      detail:
        '在平台私有目录中保存并刷新模型 Provider 凭证，不把密钥写入 Employee、Run 或租户数据。',
      policy: '基础组件 · 持续运行',
    },
    {
      id: 'authorization',
      name: 'Provider 授权',
      packageName: '@deepseek-ai/dsh-authorization',
      detail:
        '处理 Codex 等 Provider 的授权生命周期，并把授权状态提供给受限 Runtime。',
      policy: '基础组件 · 按需授权',
    },
    {
      id: 'attachments',
      name: '附件规范化',
      packageName: '@deepseek-ai/dsh-attachment-local',
      detail:
        '校验并规范化传给模型的图片附件，限制单图大小、总大小、像素和尺寸。',
      policy: '基础组件 · 有附件时工作',
    },
    {
      id: 'provider-router',
      name: '模型 Provider 路由',
      packageName: '@deepseek-ai/dsh-llm-pi-ai · @deepseek-ai/dsh-llm-deepseek',
      detail:
        '按照冻结的 Employee 模型策略选择 Codex、DeepSeek 或兼容 API 路线，并保持 Provider 协议一致。',
      policy: '基础组件 · 每轮必经',
    },
    {
      id: 'agent-loop',
      name: 'Agent Loop',
      packageName: '@deepseek-ai/dsh-agent-spine-demo',
      detail:
        '驱动一次完整工作循环：理解请求、选择 Tool 或 Skill、处理结果，直到形成最终回答。',
      policy: '基础组件 · 每轮必经',
    },
    {
      id: 'skill-registry',
      name: 'Skill 注册机制',
      packageName: '@deepseek-ai/dsh-skill',
      detail:
        '接收 AllRice 为当前 Employee 冻结的 Skill 快照；不会自动扫描 DSH Home 或加载手动安装内容。',
      policy: '基础组件 · 受控注入',
    },
    {
      id: 'skill-tool',
      name: 'Skill 调用机制',
      packageName: '@deepseek-ai/dsh-tool-skill',
      detail:
        '让 Agent 在当前 Turn 中选择并加载已发布 Skill 的完整说明，但不会扩大 Tool 或租户权限。',
      policy: '基础组件 · 匹配任务时工作',
    },
    {
      id: 'session-persistence',
      name: 'Session 持久化',
      packageName: '@deepseek-ai/dsh-session-persistence-jsonl',
      detail:
        '为每个 AllRice Session 保存独立的 DSH 原生会话，使多轮工作和 Worker 恢复能够继续。',
      policy: '基础组件 · 每个 Session',
    },
    {
      id: 'session-checkpoints',
      name: 'Session 检查点策略',
      packageName: '@deepseek-ai/dsh-session-checkpoint-policy',
      detail:
        '维护 DSH 会话检查点边界，并与 AllRice 的持久化上下文恢复机制协作。',
      policy: '基础组件 · 恢复时工作',
    },
    {
      id: 'session-projection',
      name: 'Session 事件投影',
      packageName: '@deepseek-ai/dsh-session-projection',
      detail:
        '把 DSH 原生 Context、Think、Tool、Todo 等事件整理为 ChatFlow 可安全展示的事件流。',
      policy: '基础组件 · 每轮持续工作',
    },
    {
      id: 'token-meter',
      name: 'Token 与上下文计量',
      packageName: '@deepseek-ai/dsh-token-meter',
      detail:
        '记录模型输入、缓存输入和输出用量，并向 AllRice 提供上下文压力数据。',
      policy: '基础组件 · 每次模型调用',
    },
    {
      id: 'compaction-basic',
      name: '基础上下文压缩',
      packageName: '@deepseek-ai/dsh-compaction-basic',
      detail:
        '上下文达到阈值时压缩历史内容，降低溢出风险，并保留恢复所需的关键信息。',
      policy: '基础组件 · 达到阈值时工作',
    },
  ];

export const runtimeCapabilityCatalog: readonly RuntimeCapabilityCatalogGroup[] =
  [
    {
      source: 'dsh-plugin',
      title: '已准入的 DSH Runtime 增强插件',
      badge: '固定版本启用',
      description:
        '这些是经过多租户安全审核后编入 Restricted Runtime 的 DSH 插件，不是 Employee 业务 Skill，也不是从 DSH Lab 自动同步而来。',
      items: [
        {
          id: 'llm-retry',
          name: '模型重试与退避',
          packageName: '@deepseek-ai/dsh-llm-retry',
          detail: 'Provider 短暂失败时最多重试 2 次，使用指数退避和 jitter。',
          policy: '异常时触发 · 自动生效',
        },
        {
          id: 'tool-timeout',
          name: '工具调用超时策略',
          packageName: '@deepseek-ai/dsh-tool-call-timeout-policy',
          detail: '只约束明确声明 timeoutMs 的工具，并采用协作式中止。',
          policy: '受限工具 · 自动生效',
        },
        {
          id: 'result-pruner',
          name: '压缩前工具结果裁剪',
          packageName: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          detail: '在上下文压缩前裁剪超长工具输出，保留必要的头尾信息。',
          policy: '达到阈值 · 自动生效',
        },
        {
          id: 'repeat-reminder',
          name: '重复工具提醒',
          packageName: '@deepseek-ai/dsh-repeat-tool-reminder',
          detail: '工具重复调用达到 3、5、8 次时提醒 Agent 调整策略。',
          policy: '循环保护 · 自动生效',
        },
        {
          id: 'user-questions',
          name: '用户问题通道',
          packageName: '@deepseek-ai/dsh-user-questions',
          detail: '提供 DSH 问题生命周期，由 ChatFlow 保存安全摘要。',
          policy: 'ChatFlow 适配',
        },
        {
          id: 'ask-user',
          name: '向用户确认',
          packageName: '@deepseek-ai/dsh-tool-ask-user',
          detail:
            '持久化问题与答案；等待时释放原生进程和租约，重启后继续原 Run。',
          policy: '同 Session 续跑',
        },
        {
          id: 'todo',
          name: '任务清单',
          packageName: '@deepseek-ai/dsh-tool-todo',
          detail: '允许 Agent 维护结构化 Todo，并限制并行进行中的任务数量。',
          policy: '原生事件可观测',
        },
      ],
    },
    {
      source: 'allrice',
      title: 'AllRice 已接入的执行能力',
      badge: '可按租户配置',
      description:
        '整合 DSH 原生助手与 AllRice 的任务、工具和设备能力，按员工配置发布给租户。',
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
