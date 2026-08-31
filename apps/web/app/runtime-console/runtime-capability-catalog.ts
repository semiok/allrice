export type RuntimeCapabilitySource = 'migrated' | 'allrice' | 'blocked';

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
      source: 'migrated',
      title: '已从 DSH 管理端迁移',
      badge: 'Runtime 已启用',
      description:
        '经过多租户准入审核，以固定版本加入 AllRice Restricted Runtime。',
      items: [
        {
          id: 'llm-retry',
          name: '模型重试与退避',
          packageName: '@deepseek-ai/dsh-llm-retry',
          detail: 'Provider 短暂失败时最多重试 2 次，使用指数退避和 jitter。',
          policy: '固定版本 · 自动生效',
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
          policy: '阈值治理 · 自动生效',
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
            '保持当前 Run，通过 active-turn steer 在原会话中等待文本回答。',
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
      title: 'AllRice 自有能力',
      badge: 'SaaS 控制平面',
      description:
        '不来自 DSH 管理实例，由 AllRice 为多租户、员工装配和本地协作提供。',
      items: [
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
            '把审核后的 AllRice 工具注册为真正的 DSH 工具，而非提示词占位。',
          policy: '白名单注册',
        },
        {
          id: 'rice-bridge',
          name: 'Rice Bridge',
          detail: '提供 local.fs.* 与 local.git.* 的本地只读执行能力。',
          policy: '设备授权目录内只读',
        },
        {
          id: 'codex-search',
          name: 'Codex Search Provider',
          detail: '使用平台 Codex 订阅提供受控联网搜索，并输出引用。',
          policy: '平台托管 Provider',
        },
        {
          id: 'employee-assembly',
          name: 'AI 员工能力装配',
          detail: '按员工绑定 Skill、Workflow、Knowledge、模型与安全策略。',
          policy: '新任务冻结生效',
        },
      ],
    },
    {
      source: 'blocked',
      title: '不能从 DSH 管理端直接迁移',
      badge: '默认禁止',
      description:
        '这些能力依赖单机信任边界；如未来确有需求，必须先改造成可授权、可审计、可撤销的 SaaS 工具。',
      items: [
        {
          id: 'bash',
          name: 'Shell / 持久终端',
          packageName:
            '@deepseek-ai/dsh-tool-bash · @deepseek-ai/dsh-tool-bash-persistent',
          detail: '可执行任意宿主命令，无法直接满足租户隔离和最小权限。',
          policy: '禁止直接迁移',
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
          name: '任意 MCP 接入',
          detail: '连接器权限、密钥和数据边界未经 AllRice 冻结与审计。',
          policy: '需 Connector Broker 改造',
        },
        {
          id: 'subagent',
          name: '进程内 Subagent',
          packageName:
            '@deepseek-ai/dsh-subagent · @deepseek-ai/dsh-tool-subagent-control',
          detail:
            '会扩张执行并发、上下文与权限范围，当前没有租户级预算和隔离。',
          policy: '需额度与隔离改造',
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
            '依赖单机 Host API 和用户桌面状态，不属于 SaaS Worker 的信任边界。',
          policy: '未来走 Bridge 专用协议',
        },
      ],
    },
  ];
