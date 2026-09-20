# MET-147 · UX01-B：能力可用与操作接通

这是 UX01-A（PR #73）之后的独立增量，不改 Agent Loop、预算、审批凭据或执行授权，不自动部署或全量打开功能开关。本文中的“可用”是**下一项任务的当前配置已核验**，不是执行授权、模型额度承诺或实时 Runner 健康保证；真正执行仍由既有 Tool Broker/Runtime 再检查。

## 服务端能力矩阵

所有入口可见；状态来自新的只读 `GET /api/v1/workspace/readiness?workspaceId=…&sessionId=…`。状态包括可用、需要配置、需要授权、设备离线、暂未开放和状态未知。缺少任何必要条件都不能显示为可执行；只显示当前首要原因，修复后刷新显示下一项条件。

以下发布条件复用原有 helper，不新增“万能开关”。表中的 Policy 指 `ALLRICE_RUNTIME_POLICY_ENABLED`，Ledger 指 `ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED`；还需实际员工工具/能力许可和工作区策略。

| 入口            | 既有工具 / 发布条件                                                     | 关键前置条件                                                                          | 下一步与边界                                                    |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 报告与文件交付  | `workspace.export.create` / WORKBENCH                                   | 员工可写交付物                                                                        | 准备可编辑研究任务，真实发布成功后才是工件；无需 Bridge         |
| 本地文件读取    | `local.fs.list/read` / Ledger 开启时需 Policy                           | 自己的在线 Bridge、有效目录授权、读取策略                                             | 直接打开下载、配对和工作区弹窗                                  |
| 文件修改与 Diff | `local.fs.write` / CHANGESET + WORKBENCH + Policy + Ledger              | 在线 Bridge、目录、Changeset 策略                                                     | 复用精确版本审批，不因查看 Diff 自动落盘                        |
| 本地沙箱命令    | `local.process.execute` / LOCAL_COMMAND + Policy + Ledger               | 目录、90 秒内匹配 ARM/x64 的 Runner 报告、在线目标                                    | 缺沙箱给诊断和独立 Linux 配置步骤；不安装、不开放宿主 Shell     |
| 云端沙箱计算    | `cloud.process.execute` / CLOUD_RUNNER + Policy                         | 在线云目标、当前用户 grant、合法 profile                                              | 平台准备环境，租户配置权限；已有环境才准备任务                  |
| 云端浏览器      | `browser.workspace` / BROWSER_CONTROL + Policy                          | 目标、用户 grant、合法 profile                                                        | 管理员直达当前工作区配置；成员显示申请步骤                      |
| 本地独立浏览器  | `local.browser.workspace` / LOCAL_BROWSER + BROWSER_CONTROL + Policy    | 自己的在线设备、独立浏览器 grant                                                      | 不要求文件目录授权，不继承日常 Chrome；管理员配置或 Bridge 指引 |
| 云端 MCP        | `cloud.mcp.call` / CLOUD_MCP + Policy                                   | 有效连接、发现完成、工具授权、当前员工版本绑定、凭证存储可配置                        | 管理员直达当前工作区 MCP；成员申请；不返回凭证/端点             |
| 本地 MCP        | `local.mcp.discover/call` / LOCAL_MCP + LOCAL_COMMAND + Policy + Ledger | 本人设备、精确目录授权代次、平台匹配且含 local_mcp 的新鲜 profile、发现/工具/员工绑定 | 复用本地沙箱和逐次审批，不自动安装服务                          |
| 日常并行助手    | `assistant.delegate` / ASSISTANTS                                       | 支持的协议、员工许可、委派 allow-only 策略                                            | 复用现有开关/助手树，仍计入根预算，不等于 Boost                 |
| Boost           | 尚无执行入口                                                            | MET-145 后续范围                                                                      | 始终“暂未开放”，不能伪装为已实现助手模式                        |
| Teamwork        | 尚无执行入口                                                            | MET-146 后续范围                                                                      | 始终“暂未开放”，不自动创建团队                                  |

本地设备缺失、退出或未选文件夹不影响独立云端能力；不存在把在途本地动作或文件静默迁移到云端的路径。Runner 配置报告不是实时探测，发起执行时仍按原有精确设备、版本、授权和状态重新检查。

## 权限与状态来源

- `repeatable read read only` 事务重新验证数据库中的活跃用户、组织、工作区和成员身份，不把客户端角色或旧 membership 缓存当权威。
- 会话必须属于当前用户、组织和工作区。读取会话对应的当前有效 assignment/version，不回退到另一个员工；无会话时才选当前用户默认员工。这里只描述下一任务，不修改正在运行 Run 的冻结快照。
- 所有 Bridge、目录、云/浏览器 grant 均按当前用户限定；MCP 依据当前租户、服务连接和员工版本绑定，不向成员返回其他人的目录或连接详情。
- 响应只含固定枚举与作用域 ID、核对时间；无文件路径、服务 URL、凭证、原始策略或工具输出。`private, no-store`；不探测外部网络、不供应资源、不写数据库。
- 客户端校验组织/工作区/用户/会话全部匹配；切换或刷新会中止旧请求并防止迟到响应覆盖新状态。读取失败/超时显示未知，不显示“刷新成功”或沿用旧在线状态。
- 面板打开时每 15 秒刷新，配置新标签页返回、窗口重新获得焦点、关闭 Bridge 弹窗时重新核验。新配置不会直接修改进行中的任务。

## 交互接通

- 聊天页始终有“能力与环境”入口；已实现但未开放的能力显示原因，而不是悄悄消失。
- 管理配置链接限定三个既有页面（MCP、云浏览器、本地浏览器），显式携带当前 `workspaceId`。页面继续独立验证管理员权限；普通成员只有职责与操作指引，不给无权使用的后台跳转。
- “准备任务”只把可编辑模板追加到当前草稿，保留原文和焦点，不自动发送、安装、配对或批准动作。发送后仍是原有任务链路。
- 复用已有 Ask User、审批、拒绝、取消、Steer、过期和恢复机制。待审批状态入口采用页内定位精确 operation 卡片，不用整页跳转清空草稿，也不重新生成审批。
- 报告继续通过已有 `workspace.export.create → publishWorkbenchArtifact` 发布，再由 UX01-A 工作台展示。本 PR 补充 document/plan 的原子发布与失败不伪装为工件的回归，不新增“把聊天文字冒充交付物”的旁路。
- 助手入口显示未开放/待配置等真实状态；只有既有客户端条件与服务端 readiness 同时满足才允许勾选，仍使用原有协议、能力和根预算约束。
- 能力弹窗有移动端单列、独立滚动、键盘焦点约束和关闭恢复，不把报告或现有审查草稿移出工作台。

## 测试、发布与关单边界

- Web、readiness projector 与 Worker 工件发布相关单元/组件回归共 464 项通过；环境门禁测试另行运行，不把跳过项计为通过。`pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm dsh:verify` 通过。
- Chromium 合成 HTTP 场景：12 项工作台/能力测试 + 14 项原有输入隔离测试。覆盖成员/管理员入口、配置返回刷新、草稿保留、迟到响应、失败恢复、窄屏焦点、无溢出及原有工件交互；没有调用真实模型。
- 隔离 PostgreSQL：workspace access、runtime policy、governed Bridge 三套共 130 项通过，4 项环境门禁场景未执行，明确不计为已通过。新 readiness 测试使用数据库只读连接，覆盖真实表结构、成员撤销、跨租户/所有者、目录/Runner 新鲜度及平台匹配，不向 Dev/Prod 数据库写入测试数据。
- 开关变更只发生在隔离测试进程：测试前置开启工作台/本地命令/策略/账本，断言 ready；再关闭本地命令，断言 not_released；`afterEach` 恢复环境。**实际 Dev/Prod 发布开关未改动**，指定 Dev 租户灰度的前后配置与回退记录须在获准部署时补齐，不把模拟测试当作已部署验收。
- 真实 Codex 研究报告、网页审批 → Bridge 执行 → 交付、真实浏览器与助手端到端验收留在 UX01-C。历史 Run `49fe3f09` 只作为代表性场景参考，不改写其消息、结果或账本。
- 回退仅需撤销本 PR 代码，无数据库迁移，无需撤销新权限（本 PR 未授予权限）。服务端接口失败会使能力状态未知，不绕过原有执行校验。
- PR 基于 `codex/met147-workbench-visible`（PR #73），依赖 MET-150 → UX01-A 的前序提交；不得把旧 main 覆盖当前 Dev。提交 PR 不代表合并/部署或 MET-147 整单结束。
