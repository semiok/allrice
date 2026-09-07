# B1 Gemini 初稿兼容审核（MET-115）

2026-09-07。用户明确授权将现有 Dev 的 Gemini 改动纳入独立审核 PR；这是 B1 六项基线之外的兼容修复，不是 Gemini OAuth 或生产模型开放承诺。

## 原因与基线

`/Users/a123/allrice-dev` 是带用户未提交改动的工作区，基线 `5eb1601345a5598f8d3499c0821c997644d19510`。本 PR 在独立工作树开发，基于 B1/P04；没有覆盖该工作区、修改真实 Dev 数据库或启动真实模型请求。

Dev 已应用初稿 `0073_gemini_model_provider.sql`，且其固定 Provider ID `...0004` 后来被改成 `zhipu`，仍携带 `gemini_oauth`。未经兼容直接切到 clean main，会使模型池读取、历史 Gemini 员工定义解析失败。这不是未应用迁移的假设。

初稿 SQL [原件归档](archive/0073_gemini_model_provider.sql.txt) 不在 active migrations 目录，不能再次执行。它会默认开启 Gemini、禁用 MiniMax / DeepSeek，并把 API-key 接入描述成 OAuth。替代是 [0075 additive migration](../../../packages/database/migrations/0075_gemini_provider_compat.sql)：扩展历史枚举；使用新的 `...0005` ID 创建默认禁用的 Gemini API Provider / Connection / Model 与显式 disabled release control。`ON CONFLICT DO NOTHING` 不重置已有管理员配置、不改名或删除 `...0004`。

[迁移核验](../../../packages/database/src/migration-compatibility.ts) 仅允许精确的已退役名称 `0073_gemini_model_provider.sql` 作为额外历史登记；仍拒绝其他未知登记、重复登记或缺少任何 active migration。既有 ledger 不删除、不伪造。Fresh DB 不运行 archived SQL。

## 逐类处置

| 初稿模块                                                 | 审核结果                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Models / DSH / Employee schema 与显示                    | 接纳 Gemini 历史标签，不改变冻结模型、ID、checksum；保留旧 API Provider 和 Codex `xhigh` 等选项                                            |
| DSH `google` API composition                             | 保留 API adapter；`3.8flash` 仅在到 Google 的传输边界映射到 `gemini-3.8-flash`，不回写历史                                                 |
| Worker credential handling                               | 修复对所有子进程注入 ambient `GEMINI_API_KEY`；使用已有 scoped reference resolver，仅给选中的 Gemini 子进程注入返回的 key                  |
| Gemini OAuth flow / status / authorize routes / 登录按钮 | 不纳入：无 Worker 消费与完成流程，且初稿查无状态仍声称 `connected`；Codex 授权合同与路径不变                                               |
| Gemini 发布健康门禁绕过                                  | 不纳入；平台员工发布仍须既有已实现的 Provider 健康检查                                                                                     |
| fallback / replay                                        | 只匹配明确 Provider 路由与模型的冻结项；保留 Codex / DeepSeek / compatible 历史别名；Gemini 无合法冻结项拒绝恢复，不换另一 Provider 的凭证 |
| 历史 OAuth primary Run                                   | 历史只读可解析；准备新 Run 与 Worker 执行既有 queued Run 均拒绝未实现的 OAuth authMode，不能丢弃原 authMode 后伪装 API 执行                |
| 初稿发布无关的请求超时 / UI 限制改动                     | 不纳入此兼容 PR                                                                                                                            |
| `.env`、凭证、`docs/codex-handoff.md`                    | 不搬运、不提交                                                                                                                             |

`runtimeSupported` 是“该 Provider/authMode 有已实现路由”的展示字段，不是密钥有效、模型健康或允许生产调用的证明。`zhipu + gemini_oauth` 可读并明确显示不支持；不会自动改名成 Gemini，也不会被新选择逻辑误认为普通 OpenAI-compatible API。

## 执行与凭证边界

`ALLRICE_GEMINI_API_ENABLED` 默认关闭。显式启用时仍需要部署管理员在既有 `ALLRICE_DSH_CREDENTIALS_FILE`（私有权限）或 `ALLRICE_DSH_CREDENTIALS_JSON` 中提供准确的 `credentialReference` 绑定；没有绑定就失败，不回退到 ambient key。新快照使用 `allrice_credential`；旧 Gemini `platform_subscription` 字段仅兼容其不可变历史，绝不证明 OAuth 已实现。

本 PR 没有自动打开开关、启用种子、写入密钥、审批生产发布或绕过租户治理。正式开启还需管理员批准的发布范围、凭证配置与独立真实模型验收；本次测试没有用真实密钥发起模型请求。

重要限制：已有 credential resolver 校验 reference 与 tenant/deployment scope，尚未把凭证本身按 Provider route 绑定；DSH 各 Provider 仍共用平台 credential store 的路径。因此本次验证的是“选定 reference 与子进程环境变量的最小分发”，不是 OS 级隔离或全凭证隔离。更强隔离不能由本 PR 的测试结果推导。

官方 [Gemini API key 文档](https://ai.google.dev/gemini-api/docs/api-key) 区分 API key 接入与登录授权，并要求密钥不进入客户端或源码；[入门文档](https://ai.google.dev/gemini-api/docs/get-started) 当前使用 `gemini-3.8-flash` 模型标识。仓库锁定的 DSH `dsh-llm-pi-ai` / `@earendil-works/pi-ai` 的 `google` Provider 为 API-key 路由。本文不把另一套 Gemini CLI OAuth 当作已接入能力。

## 验证证据

对真实 `allrice_dev` 使用 PostgreSQL `BEGIN READ ONLY`，只在内存使用本 PR schema 解析，不修改记录、不输出聊天或密钥：Provider 4/4、Platform definition 28/28、Runtime profile 27/27、Employee provider 19/19、Employee manifest 19/19、Session model snapshot 47/47，共 144 条通过。

当前 Rice draft/published 与两个 active tenant assignments 均为 `openai-codex / gpt-5.6-luna`。历史 Gemini 标签仍保留，不能据此宣称 Gemini 已可调用。

自动测试覆盖：

- 历史 schema、Codex 授权合同不扩权、未支持 OAuth 仍不允许运行。
- 默认开关关闭时不读取凭证、不启动子进程；无匹配凭证不使用 ambient key；Codex / DeepSeek 子进程没有 Gemini key。
- 真实 DSH runtime 初始化 Gemini composition 与历史 alias，无模型 prompt、仅合成凭证。
- Gemini / 其他 Provider 双向同名回放隔离、无冻结匹配拒绝、compatible 历史回归。
- Worker 真实 primary handler 对历史 Gemini / Zhipu OAuth 的前置拒绝。
- 真实临时 PostgreSQL 独立 schema：fresh 默认禁用、保留旧 ID / 管理员设置、显式 release denial；仅临时测试 schema 被清理。
- 精确 archived migration 白名单、missing / unknown / duplicate 负例。

2026-09-07 本分支门禁：上述新测试加既有 DSH/Codex、credential resolver 与旧 wire compatibility 回归，共 **10 个文件 / 64 项测试通过**；全仓 `pnpm typecheck`、`pnpm build`（含 Next production build）及改动 TypeScript 文件 ESLint 通过。Gemini primary handler 的测试 fixture 使用真实 `executionSnapshot.schemaVersion === 2` 的嵌套 `modelSnapshot`，不是模拟不存在的顶层字段。

数据库集成测试必须设置 `ALLRICE_RUN_DB_INTEGRATION=1` 与专用临时 `ALLRICE_TEST_DATABASE_URL`，测试另外校验数据库名为 `allrice_b1`，不能指向 `allrice_dev`。

## Dev 切换约束（发布由主代理执行）

采用 clean main immutable worktree，例如 `/Users/a123/allrice-dev/.local/releases/b1-<SHA>`，不 checkout / reset / 清理 dirty Dev。正式部署前保留旧 plist、release SHA、数据库备份与数据目录恢复点，先核验同一构建与 schema。

现有 Web 是 `ai.bplabs.allrice-dev-web`，工作目录 `apps/web`，Node `--env-file=/Users/a123/allrice-dev/.env`，端口 **3001**；Worker 是 `ai.bplabs.allrice-dev-worker`，工作目录仓库根，环境来自 plist，端口 **3102**。文件中 `.env` 的 Worker port 是 3101，不能覆盖 plist 的 3102；不要假定新建一个 `dev.env` 就自动等价。保留 storage signing 与 portal session secret 的值但不打印。

继续使用以下既有绝对持久化路径，不能随 release 换成新的相对 `.local`：

- `ALLRICE_STORAGE_ROOT=/Users/a123/allrice-dev/.local/storage`
- `ALLRICE_EXECUTION_ROOT=/Users/a123/allrice-dev/.local/executions`
- `ALLRICE_DSH_RUNTIME_ROOT=/Users/a123/allrice-dev/.local/dsh-runtime`（其下 tenant/session 的绝对 cwd 也是 DSH 会话恢复键的一部分）
- `ALLRICE_DSH_PLATFORM_HOME=/Users/a123/allrice-dev/.local/dsh-platform`
- `ALLRICE_DSH_CREDENTIALS_FILE=/Users/a123/.config/allrice/dsh-credentials.dev.json`

但 **`ALLRICE_DSH_CORDIS_CONFIG` 是代码配置，不是持久化数据**：必须改成新 release 的 `apps/worker/dsh/allrice-restricted.cordis.yml`，不能继续指向 dirty Dev。保留已验证的系统 Node 可执行文件；应用 entrypoint / node_modules 与工作目录应使用新 release。既有 DSH HTTP(S) proxy / NO_PROXY 设置保留。

Bridge 下载包的 `ALLRICE_BRIDGE_MACOS_ARM64_PATH` / `ALLRICE_BRIDGE_MACOS_X64_PATH` 当前在 `/Users/a123/.allrice/rice-bridge/dev/`；本兼容 PR 不替换客户端包。`ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED`、`ALLRICE_RUNTIME_POLICY_ENABLED`、`ALLRICE_GEMINI_API_ENABLED` 保持默认关闭。

`ai.allrice.dsh-admin` 是独立服务：当前 entrypoint 在 `/Users/a123/allrice/apps/dsh-admin/server.mjs`，读取 Dev `.env` 且持久化在 Dev `dsh-admin` / `dsh-platform`。不要因本次切 Web/Worker 顺带切换它。`ai.traditionow.allrice-web/worker`（Prod）完全不动。

Worker 当前 SIGTERM 会主动 abort 活跃执行，并非排空后继续。因此切换前需重新确认无 running/claimed/waiting approval 任务、无进行中的试用或授权，再优雅退出；不能把 kill/restart 称为无损任务排空。回滚可切回旧代码与 plist，但不要直接 down/drop additive schema 或重写旧模型快照。
