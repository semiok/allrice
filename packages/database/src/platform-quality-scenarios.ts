/** Versioned regression entry points, not receipts or permission to execute. */
export const qualityScenarioRegistryVersion = 1;
export const qualityRegressionScenarios = [
  {
    id: 'chat.continuation.v1',
    title: '聊天续办与终态',
    group: 'native',
    input: '固定历史工具消息、用户续办/取消和重复错误；loopback 模型替身。',
    expected: '原工具不重放；续办或取消后的终态及上下文与原生事件一致。',
    files: [
      'apps/worker/test/p25/dsh-legacy-replay.test.ts',
      'apps/worker/test/p25/task-progress-native.integration.test.ts',
      'apps/web/app/chatflow/session-run-stream.test.ts',
    ],
    boundary: '真实 DSH 子进程与合成模型；不证明任意模型任务或浏览器页面体验。',
  },
  {
    id: 'delivery.truth.v1',
    title: '交付状态与错误恢复',
    group: 'native',
    input: '固定多文件导出失败、同文件修正、问答与预览不可用样本。',
    expected:
      '回复或其他文件成功不掩盖缺失成果；未验证的检查与预览不能变成通过。',
    files: [
      'apps/worker/src/jobs/document-delivery.test.ts',
      'apps/worker/src/office/quality.test.ts',
      'packages/database/src/task-next-steps-projector.test.ts',
      'apps/web/lib/runtime/artifact-http.test.ts',
    ],
    boundary:
      '确定性模块与 HTTP 回归；不等于真实 Office 软件或跨页面全链路验收。',
  },
  {
    id: 'office.native-wire.v1',
    title: 'Office 原生参数',
    group: 'native',
    input: '固定 Office/Python/PDF 参数与无效位置、格式和文件字段。',
    expected: 'DSH 实际工具定义、参数往返及 Broker 校验保持一致。',
    files: ['apps/worker/src/harness/dsh-office-native.test.ts'],
    boundary:
      '真实 DSH 参数链路；完整 DOCX/XLSX/PPTX、公式和本地软件另需实机证据。',
  },
  {
    id: 'mcp.native-recovery.v1',
    title: 'MCP 原生续办',
    group: 'native',
    input: '固定 MCP 调用，工具返回后注入两次 loopback 模型 503。',
    expected: '同一原生请求恢复，已经完成的工具不重复调用。',
    files: ['apps/worker/src/harness/dsh-mcp-native.test.ts'],
    boundary:
      '合成服务与模型；不调用用户已连接的 GitHub、Linear 或其他真实服务。',
  },
  {
    id: 'chat.production-two-turn.v1',
    title: '同一会话两轮正式交付',
    group: 'postgres',
    input:
      '隔离普通 assignment，两轮真实 sendChatMessage 与确定性 Worker 工具请求。',
    expected:
      '提交重放不多建任务；两轮终态、上下文、版本、工具次序和鉴权下载一致。',
    files: [
      'tests/integration/platform-quality-conversation.integration.test.ts',
    ],
    assertionTags: ['chat.production-two-turn.v1:'],
    boundary:
      '真实队列/Worker/Broker/发布/HTTP；模型适配器为替身，不证明原生 Office 生成。',
  },
  {
    id: 'office.native-features.v1',
    title: 'Office 固定三格式与坏文件',
    group: 'office',
    input: '真实受管云端 VM 中的固定 DOCX/XLSX/PPTX、并发三格式和坏文件。',
    expected:
      '生成、原生检查、并发上限和停止清理通过；Python exit 0 不掩盖坏文件。',
    files: ['apps/worker/src/office/native.integration.test.ts'],
    boundary:
      '真实固定云端沙箱；不证明任意 Office 项目、Bridge、公式重算或视觉审阅。',
  },
  {
    id: 'office.native-delivery.v1',
    title: '原生 Office 正式版本交付',
    group: 'office',
    input: '普通员工两轮确定性工具请求；真实原生 XLSX 与源文件修订。',
    expected:
      '实际 Broker/原生检查/正式发布/鉴权下载接通，v1 原件保留且 v2 数值与来源一致。',
    files: [
      'tests/integration/platform-quality-conversation.integration.test.ts',
    ],
    assertionTags: ['office.native-delivery.v1:'],
    boundary:
      '真实云端 VM、PG 与 HTTP；模型为替身，不代表全部格式的发布或本地实机通过。',
  },
  {
    id: 'mcp.receipt-failure.v1',
    title: '连接器失败与未知写入',
    group: 'postgres',
    input:
      '隔离 PostgreSQL 与 loopback MCP：拒绝、503、网络断开、写后丢失回复。',
    expected:
      '派发前失败、只读失败与写后未知分开；回读或恢复不会重复外部写入。',
    files: ['packages/database/src/mcp-execution.integration.test.ts'],
    boundary: '真实 PG/Broker 和合成 MCP；不证明真实第三方服务的可用性。',
  },
  {
    id: 'delivery.publication.v1',
    title: '成果发布、回滚与版本隔离',
    group: 'postgres',
    input: '隔离账号、不可变文件字节、发布锁顺序、事务中止及清理后重试。',
    expected:
      '发布及下载以不可变版本和当前权限为准；中止发布回滚并清理后可重试。',
    files: [
      'packages/database/src/artifact-publication-concurrency.integration.test.ts',
      'packages/database/src/company-deliverables.integration.test.ts',
    ],
    boundary: '真实 PG 与文件存储；不代表任意格式均已通过渲染和质量检查。',
  },
  {
    id: 'task.cancel-resume.v1',
    title: '持久取消与恢复',
    group: 'postgres',
    input: '隔离任务、活动/停驻 Worker、等待与撤权样本。',
    expected: '取消或撤权切断新动作，恢复沿用原任务且不重放已完成工具。',
    files: [
      'apps/worker/test/p25/task-wait-worker.integration.test.ts',
      'packages/database/src/session-archive.integration.test.ts',
    ],
    boundary: '合成任务与真实 PG；原生进程物理停止仍以对应后端回执为准。',
  },
  {
    id: 'platform.private-isolation.v1',
    title: '公司隔离与私有质检',
    group: 'postgres',
    input: '平台私有检查与普通公司账号、并发派发、过期、重复请求及重启样本。',
    expected:
      '公司数据不被测试任务污染；私有请求和成果不可跨账号，旧任务不洪泛补发。',
    files: ['packages/database/src/platform-quality.integration.test.ts'],
    boundary:
      '真实 PG 的固定发布包及合成执行回执；物理构建/浏览器另由 Dev 检查证明。',
  },
] as const;

export type QualityRegressionGroup =
  (typeof qualityRegressionScenarios)[number]['group'];
