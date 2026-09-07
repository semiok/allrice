# P04：确定性策略与精确持久审批

归属：MET-113 / B1 / S1 / R2；顺序以[执行总表](https://linear.app/metasnowsky/document/allrice-20-执行总表阶段依赖pr-与验收门禁-df09b0b1e681)为准。

## 范围与当前边界

复用 `allrice_approval_requests` 的审批 ID 和状态，0074 只加运行请求/回复、准确绑定摘要、控制版本、有效期、消费与撤销时间。旧连接器/Workflow 审批不迁移、不自动取得新执行权限；旧通用审批接口明确排除 `runtime_operation`，不能绕过新类型校验。

真实旧接口兼容测试发现 `decideConnectorApproval` 曾把 `approved/rejected` 直接写入仅允许 `allowed/denied/recorded` 的审计字段，造成事务回滚；本次修为 `recorded` 并在 metadata 保存 `approvalDecision`，审批自身的状态和 API 不变。

新增内部 `allrice_runtime_policy_controls` 按组织/工作区存当前版本，默认无记录且拒绝。只有重新核对数据库管理员身份的服务 API 可设置它。没有工作区自动安装策略、Skill/Hook 规则执行、通配权限或 Prompt 安全决策。

B1 注册现有七个 Bridge 文件/只读 Git 工具；任意规则不能注册新 Runner/插件/Boost。云端执行、service actor、资料传输与 Artifact baseline 的治理适配器尚未注册，明确拒绝，按各后续切片真实接入。现有文件写入的 expected SHA 等属于 command payload 的准确摘要，不用不存在的 Artifact 伪造基线。路径函数只是语法前置，不能证明真实路径、软链接、TOCTOU 或进程沙箱安全。

## 判定与事务

`createRuntimePolicyAdmission` 是 P03-a 的事务回调：创建阶段可返回 `waiting_user`；派发在同一事务消费精确批准；start/续租重新校验但不再次消费。取消/撤销后的真实结果仍须独立记录，不能因拒绝新执行而丢掉副作用证据。

判定顺序：已注册工具 → 平台强禁令 → 租户强禁令/只规划限制 → Ask → 显式 Allow → 未匹配拒绝。策略解析错误、未知字段、无策略、过期/停用用户和成员、错误工作区、已结束 Run、失效的冻结策略、撤销的设备/目录都拒绝。Allow 不增加能力、预算或数据权限。

每次准入重新读取数据库成员、Run、策略快照、执行目标、设备/目录授权，不信请求传来的成员数组。冻结配置摘要为 Run `execution_spec` 的确定性 JSON SHA-256，策略摘要对应原 policy snapshot payload；键按代码点排序，非 JSON 数据拒绝。旧 Bridge 会在重新选择目录时复用同一 grant ID，因此0074新增数据库维护的 `runtime_generation`：撤销、重新授权或作用域改变均递增，批准绑定真实 generation，旧批准不会随同目录重新选择而复活。旧客户端不必认识该列。

服务器执行适配器还必须重新解析真实 payload/目标/基线，返回当前完整 `RuntimeActionBinding`；任何差异都拒绝，不能把请求 binding 原样回传冒充校验。该函数依赖由服务器组装，不由浏览器或模型注入。P03-b 联调中以持久命令内容重新计算 inputDigest，不从未受信 HTTP 提交创建操作。

事务锁顺序为 P03-a root → operation → Run/target → 控制记录 → 身份/策略/目录 → 审批。批准消费和派发失败一起回滚，12 路并发消费只有一路成功。策略修订/撤销与消费串行；派发之后的撤销只能阻止后续准入并要求停止核对，不能撤回已发生的外部动作。截止时间使用数据库当前时间，不相信调用方时钟，也不允许一次锁等待复用旧检查时间。

批准绑定完整 operation/attempt、用户、Run、冻结版本、政策摘要、目标/目录/工作副本、动作、输入/命令与资料摘要。批准回复严格使用 `action_approval`，Ask User、计划认可、评论均不能替代；同一回复重复提交返回已有结果，不重复消费或启动。审批拒绝、过期、已消费、版本变化不可重置为 pending；需要重新规划新的精确操作。请求、决定、消费与撤销审计只记录身份、引用和摘要，不复制参数/凭证/正文。

## HTTP 和静态预览

`/api/v1/runtime/approvals/:id` 提供 GET / POST / DELETE，用既有登录与租户上下文，服务端 `ALLRICE_RUNTIME_POLICY_ENABLED=1` 才开放；默认 404。没有公开创建任意绑定、发布 Allow 或直接执行工具的入口。返回不缓存，POST 有大小边界；读取恢复不产生执行副作用。新交互卡片属于 P10，不在本 PR 声称已实现。

`runtimeStaticPreviewPolicy` 给出最小渲染要求：HTML/SVG/Markdown 等默认转义文本；已授权 PNG/JPEG/WebP 可做静态图片；禁止脚本、远程子资源、主站同源运行并附限制性 CSP。这不是 HTML sanitizer，也没有在 B1 偷改整个旧 ChatFlow 渲染；P07 工作台必须实际遵守并验证这些要求。

## 测试、兼容与回退

纯策略与路径/预览测试，真实 PostgreSQL migrations + 策略/审批测试覆盖并发消费、事务回滚、重放、跨租户、撤销/到期、策略/输入/执行变化、冻结配置、审计和旧接口隔离。数据库测试使用唯一合成 schema，需显式 `ALLRICE_RUN_DB_INTEGRATION=1`；不以默认跳过当通过。集成 P03-a/b 后另记录统一故障链证据与固定 SHA。

新增结构是 expand 迁移，无数据收缩；旧应用忽略新表/列。关闭新 HTTP/设备账本开关并回部署旧兼容版本，新结构及审计保留。不得 down migration 删除真实审批/账本，也不把回退当未知外部动作已撤销。B1 Dev 默认不开新 Runner、不安装新租户 Bridge、不更改 Prod。
