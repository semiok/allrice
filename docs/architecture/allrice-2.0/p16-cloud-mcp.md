# P16 云端 MCP：实现范围与验收边界

本模块把管理员安装的远端 MCP 服务接入已有 Connector 权威体系，再通过 P03/P04 操作账本、冻结配置与精确审批执行。它不是第二个 Agent Loop，也不会通过 MCP 启动本机进程。

## 当前支持范围

- 固定 `@modelcontextprotocol/sdk` **1.30.0**；协商协议必须为 **2025-11-25**。不宣称支持更新的协议或 SDK v2。
- 只支持 **Streamable HTTP** 的工具发现与调用：initialize、tools/list、tools/call，以及 SDK 的协议通知。
- 只支持管理员配置的 **HTTPS / 443** 固定 endpoint，无 URL 用户信息、query 或 fragment。不得将凭证放入 URL。
- 只支持租户/工作区范围的 **service identity + Bearer token**。没有 OAuth 登录、个人连接继承、匿名认证、stdio、旧 HTTP+SSE transport、采样、MCP roots、elicitation 或自动资源下载。
- 每个工作区最多 16 个启用连接；发现最多 8 页/128 个工具；每个 Run 冻结工具总数最多 128。变化后的工具必须重新授权，不静默扩大权限。

### JSON Schema 是明确的首版子集

顶层输入/输出 schema 必须是 object；支持 type、properties、required、additionalProperties、items、enum、const、数值上下限、字符串/数组长度边界和说明性 metadata。schema 最大 32 KiB、24 层、4096 个遍历节点。

`$ref` / dynamic refs、正则、format、anyOf/allOf/oneOf、patternProperties 等未审查约束会 **fail-closed**，不会忽略约束继续执行。一个服务包含不支持的 schema 时会拒绝该次发现；因此此版本**不等于任意 MCP 服务即插即用**。

## 权威与执行路径

1. 当前管理员在指定工作区创建连接；每次管理变更现查数据库中的管理员会员资格，不信旧请求快照。
2. 凭证存入与既有 `connector_binding` 关联的 MCP 配置扩展表，以 AES-256-GCM 加密。数据库、模型上下文、公开 API 和审计不保存/返回明文凭证。
3. Worker 从有租约的发现队列读取配置，获取工具 schema；默认所有工具未授权。管理员逐工具选择允许/拒绝及风险类别。
4. 平台员工策略必须声明 `cloud.mcp.call`、service 身份和 `secret:use`/`network:outbound` 能力，且不得明确 Deny；需保存新草稿、试用、发布。平台草稿仍禁止包含租户 Connector ID，也不开放其他尚未实现的 Service 工具。随后租户管理员在工作台「MCP 连接管理」选择确切员工版本，点击「绑定此连接」。连接安装、工具授权和员工绑定是三道独立权限。
5. `0086` 的 `allrice_employee_mcp_bindings` 关联既有租户员工版本和 MCP Connector 配置，保留不可删除身份及单调授权版本。绑定只缩小已有政策，不改 immutable manifest、不伪造 Skill、不提升 Deny。新 Run 经真实 `prepareEmployeeRunBinding` 冻结 employee grant ID/revision、connection revision、tool revision/schema digest、tool grant revision 和 opaque credential reference；旧 Run 不自动继承。显式绑定仅作为当前唯一 `secret:use` 工具 `cloud.mcp.call` 的附加来源，不新增 network 能力或其他工具；将来新增 Secret 工具必须另设逐工具授权，不能直接继承此绑定。
6. 模型仅提交 `{connectionId, tool, arguments}`。Worker 从真实运行中 job 对应的冻结 Run 选工具，不接受模型提交的 frozen authority、目标或凭证。
7. 创建 `cloud_mcp` / `remote_service` 的独立操作身份，复用当前 Run root 预算。所有调用，包括 read-only，必须得到本次精确审批。
8. Dispatch 与私有 lease journal 原子落库；START receipt 的 `mayExecute` 是唯一一次 tools/call 门禁。每次网络前及运行中心跳都复查 job lease、当前会员/用户、有效员工 assignment、员工版本绑定、连接、工具授权、schema、精确审批和 root 状态。员工锁先于绑定/连接锁，避免撤销与派发锁序反转。撤销再授权会产生新 revision，不能复活旧 Run 或旧审批。
9. 超时、断流、取消、丢回执不能证明第三方没有执行：保持 `unknown`，不自动重放。`isError: true` 也不能推断副作用为 none。
10. 冷恢复只重放已有持久结果，或标记未知；不连接 MCP、不获取凭证、不重新调用工具。已知结果结算 tool_calls，未知工作保留预算 reservation。

MCP 远端内容始终是不可信数据。服务端拒绝内网、回环、链路本地、测试/Fake-IP 等地址；DNS 每次复核全部地址并 pin 到实际 TLS lookup，不跟随重定向、不转发 Cookie 或代理认证。参数最多 128 KiB、HTTP body 最多 256 KiB、响应最多 1 MiB、模型输出最多 20,000 字符；不接受压缩响应。

## 部署配置与启用步骤

| 配置                               | 作用                                                           |
| ---------------------------------- | -------------------------------------------------------------- |
| `ALLRICE_CLOUD_MCP_ENABLED=1`      | Web 管理写入、Worker 发现及调用开关；默认关闭                  |
| `ALLRICE_RUNTIME_POLICY_ENABLED=1` | 运行策略与精确审批执行开关                                     |
| `ALLRICE_MCP_CREDENTIAL_KEY`       | Web 与 Worker 使用的同一 32 字节随机密钥，以 64 位十六进制编码 |

密钥应由部署管理员生成并存入受保护的部署密钥管理，不写入代码仓库、日志或前端环境变量。不应未经迁移直接更换加密主密钥；没有批量重加密/主密钥轮转工具。丢失主密钥会使已保存凭证不可解密，需要管理员重新录入。

业务服务 Bearer 的轮转与主密钥不同：使用管理页“轮转密钥”，它提升 connection revision 并撤销逐工具授权；重新发现、授权后只影响后续新 Run。撤销连接立即阻止新派发和心跳续权，但不宣称第三方已撤回正在执行的动作。

按顺序执行：应用迁移 → 安全配置 Web/Worker 同一主密钥 → 开启 Dev 功能开关 → 创建自有测试连接 → 发现 → 逐工具授权 → 发布具备 MCP 能力但不携带租户连接 ID 的员工策略 → 租户管理员绑定确切员工版本与连接 → 创建新 Run → 审查并批准一次调用。未满足条件的员工版本在 UI 显示具体原因，不自动给现有员工扩权。不得为验收借用个人 Linear/GitHub 或真实租户账户。

模型通过原生 DSH 函数 `cloud_mcp_call` 调用 canonical `cloud.mcp.call`；参数 DSL 与执行前严格 schema 验证一致，仍走同一个 Tool Broker。没有通过普通文本 envelope 伪装完成调用。客户端冻结名单只用于可见性；执行权威仍由数据库 Run 快照与当前授权共同决定。

## 用户可见审批

`CloudOperationPanel` 与本地命令面板分开。云端计算展示实际脚本、输入文件 ID/hash、输出与限额；MCP 展示目标 endpoint、工具、风险和脱敏参数，明确这些参数将发送给第三方服务。

`GET /api/v1/runtime/cloud-operations` 只允许当前有效会员读取自己拥有的 Run；`POST` 只接受所属 Run 的 root 取消意图。审批沿用既有 `/runtime/approvals/:id` 精确响应协议，不新增通用执行接口。拒绝、过期、撤销、刷新恢复与重复提交均保留原审批身份。

新执行 flag 关闭后仍显示历史账本、结果与授权撤销状态；停止按钮仅表示已记录意图。未知结果不显示“安全重试”按钮。若展示时无法解密当前服务凭证，参数字符串会隐藏，历史状态不隐藏。

## 自动化验收与未宣称部分

- `mcp-connections.integration.test.ts`：真实隔离 PG schema，既有 Connector 关联、加密/隔离、schema 变化、逐工具授权与旧管理员快照撤权。
- `mcp-http.integration.test.ts`：真实 Worker discovery 队列 → 自有认证 MCP HTTP → 合成读写数据；不使用个人账户。
- `mcp-execution.integration.test.ts`：真实 PG 精确审批/操作账本 + 上述真实 HTTP，覆盖等待、拒绝、撤销、schema 漂移、一次执行、写后丢回复、工具错误、job/root/grant 运行中撤权、原子 journal、冷恢复、预算、历史读取消权限和单连接池回归。
- `transport.test.ts`：真实 SDK/HTTP 工具发现调用、错误/取消与 schema 子集。
- `egress.test.ts`：DNS/TLS 接口隔离单测，证明 private/mixed DNS 拒绝、地址 pin、重定向拒绝和撤权先于开连接；不是公共 TLS 端到端验收。
- Web route tests 与 SSR tests：HTTP 权限边界和可读卡片、转义、过期/拒绝/撤销/未知状态；不冒充浏览器点击 E2E。
- P16 追加真实 PG 编译→试用队列→合成模型完成→发布验证，确认 Service 精确开放、显式 Deny/平台草稿租户 ID/无 MCP 声明都拒绝。模型完成是合成数据，不声称真实模型预览。
- `dsh-mcp-native.test.ts` 运行 pinned DSH 子进程与合成 SSE provider，验证原生工具 roundtrip 和非法参数不进入 Broker。`mcp-execution.integration.test.ts` 另将该入口接实际 generic Broker→真实新 Run 冻结→PG 审批→自有 MCP HTTP，写入一次并验证审计。
- `scripts/acceptance/runtime/p16-mcp-workbench.ts`：独立 Chrome + 构建后 Next + 开启 portal 的双合成 cookie，实际点击员工版本绑定/刷新、审批前刷新、批准、拒绝、撤销和窄屏；非所属用户读取/批准返回 403，远端写入恰一次，无 pageerror。生产 Origin 检查复用实际 Host 的 `sameOriginBrowserWrite`，拒绝缺失 Origin、跨站及伪造 forwarding 头。
- `scripts/acceptance/runtime/b4-cloud-workbench.ts`：真实独立 Chrome → 已构建 Next → PG → gVisor → 工件工作台 → HTTP 下载 XLSX 并重新解析。覆盖刷新后批准、精确重复提交、同工作区其他用户读取/审批/下载拒绝、拒绝后不派发、窄屏抽屉及零 pageerror/5xx；另以随机 secret 签名的合成租户双 cookie 验证真实 portal proxy → MCP 管理页、当前会员鉴权、错误 portal 拒绝和关闭新执行 flag 后保留云端历史。它不调用模型，也不冒充 DSH 模型 E2E。

运行数据库验收必须显式指定 `ALLRICE_RUN_DB_INTEGRATION=1` 和专用 `ALLRICE_TEST_DATABASE_URL`。测试只创建并删除自己的随机 schema，不对真实租户授权。测试服务仅绑定 loopback；`fetchOverride` 只通过测试代码依赖注入，不允许生产配置开启内网例外。

P16 独立网页命令：`pnpm --filter @allrice/web... build` 后运行 `pnpm exec tsx scripts/acceptance/runtime/p16-mcp-workbench.ts`。使用空闲 `127.0.0.1:3006`、专用 `allrice_b2` 随机 schema、最小环境、临时 Storage 和无个人 Profile 的 Chrome。结束只清理本脚本 schema/服务/Storage，保留打印路径下的 `evidence/checks.json` 和截图。不需要 VM，不访问真实 Snow/Drink，不声称公共 TLS 服务或真实模型 E2E。

批末集成浏览器脚本将在 P19 分片提供：`pnpm exec tsx scripts/acceptance/runtime/b4-cloud-workbench.ts`，不属于本 P16 独立提交。它需要当前 Web build、测试数据库 `allrice_b2` 和已安装的独立 `allrice-cloud-b4` VM；脚本固定使用空闲的 `127.0.0.1:3005`，若已有进程占用即拒绝。环境变量以最小白名单重新启动，不继承 `.env`、个人浏览器 Profile 或外部账号。测试只创建随机 schema 和临时私有 Storage，结束后关闭自己的服务/浏览器并删除 schema/Storage；保留临时目录中的 `evidence/result.json`、截图与下载的样例 XLSX。第二次私有启动的 portal 名称只用于验证产品真实路由，组织、用户、cookie 和签名密钥全部是测试生成，不访问真实 Snow/Drink。

P16 的 `developer-bootstrap` CI 使用 `127.0.0.1:54329` 上的显式测试数据库运行 MCP 连接、真实 HTTP 和账本三组集成测试，云端状态读/取消鉴权也包含在账本测试中。CI 不启用 `ALLRICE_RUN_CLOUD_INTEGRATION`，真实 gVisor 云执行测试因此显式跳过；不得把它记作 CI 完成沙箱验收。

目前这些证据不等于真实租户模型调用、第三方 OAuth 或公共 HTTPS SaaS 全链路验收。Dev 发布验收仍需在实际登录页面完成一次审批并核对独立自有服务的调用计数、结果和撤权；未经这一步不得声称完成真实租户 E2E。
