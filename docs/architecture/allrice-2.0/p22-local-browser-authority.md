# P22：Bridge 本地浏览器的服务端权威

P22 复用 P21 BrowserWorkspace、控制 fence、观察、密文输入、工件和既有 Runtime Ledger；只增加设备授权和短租约传输适配。它不是另一套 Agent 循环，也不默认接管个人 Chrome。

## 授权与使用

- 默认关闭。服务端同时要求 `ALLRICE_LOCAL_BROWSER_ENABLED`、`ALLRICE_BROWSER_CONTROL_ENABLED`、`ALLRICE_RUNTIME_POLICY_ENABLED`；本机还须显式启用。
- 新 Run 的冻结工具集必须包含 `local.browser.workspace`，并具有 `network:outbound`。租户策略还须明确配置 `local.browser.observe` 和 `local.browser.act`；act 即使配置 Allow 也必须逐次精确审批。安装浏览器 grant 不会自动修改员工、Skill 或已运行的冻结配置。
- `local.browser.workspace` 原生入口提供 `command: open/observe/act/close`。open 必须给出 `grantId` 和公网 HTTPS URL；grant 决定唯一设备，不允许隐式改由云端执行。
- 浏览器 grant 绑定当前管理员自己的未撤销设备。**不需要本地文件工作区或 folder grant**；不赋予本地文件读写、Shell 或个人 Chrome Cookie 权限。
- Profile 仅允许精确公网 HTTPS origin。云端和本地授权入口均先拒绝私有/特殊 IP 字面量、localhost、内网及保留域，不进行 DNS 查询；执行时仍必须逐连接检查 DNS 结果并固定公网 IP，入口预检不替代这一门禁。上传、下载、人工敏感输入分别授权。`.preview.allrice.invalid` 是后续 P23 专用保留域，普通云端和本地 grant 均拒绝。
- 人工敏感输入使用既有 `ALLRICE_BROWSER_CONTROL_KEY` 加密、一次消费，不能通过模型工具提供敏感输入。文件上传只消费精确 START 操作绑定的 SaaS 文件对象，不接受客户端另传任意 objectId 或路径。

## 权威与恢复

`0090_local_browser.sql` 是增量迁移，不创建默认 grant、不启用 flag。公共表通过 transport 区分云端 Managed Browser task 与本地设备控制器；本地 taskId 为空，不制造云任务或文件授权。

- 每个 Run 使用新的实际 profileId。同一个 grant 的 logicalProfileId 可在显式选择保留登录资料后复用；新 grant 使用新 logicalProfileId。每个 grant 同时只有一个未确认释放的 workspace。
- Controller 租约不超过 5 秒。同一 controllerId 可恢复丢失的 claim 响应，其他进程不能接手旧 lease。过期后只允许旧 token 递交事实/关闭回执，不重新 START。
- 开始动作前服务端重新验证当前租户、owner、员工分配、Run/Job 租约、冻结工具、设备、grant/profile、控制 fence、观察和审批。
- 本地浏览器使用专用 `localBrowserPayload`。账本核对 BrowserCommand 与已登记的不可变输入、scope 和 digest；它不进入旧的 folder-bound Bridge 命令领取接口。
- 实际 POST/PUT/PATCH/DELETE 再建立子操作精确审批。每个物理请求有稳定 requestId；重试只读取同一审批。取得 permissionToken 后不得再次发送同一请求，无法确认记为 unknown。
- 撤销只记录关闭/清理意图。已经领取的 workspace 必须收到实际关闭确认才释放；unknown 不释放。未曾领取的 intent 可由数据库证明没有发出控制权并关闭。新 flag 关闭后仍支持读取、撤销、停止和回执清理。
- 截图、下载都是不可信对象。截图必须绑定当前 fence/observation；下载必须绑定已 START 操作。观察 revision 单调递增，ACK 必须引用已登记的新观察。

## 接口

- `GET/POST/PATCH /api/v1/admin/local-browser`：真实会话、同源写入、当前 owner 管理员。GET 返回 enabled/grants/devices；POST 安装；PATCH 显式撤销。
- `POST /api/v1/bridge/browser-workspaces`：仅设备 Bearer token；类型化 claim/heartbeat/next/start/receipt/control/input 操作，不携带用户凭证或 Job token。
- `POST /api/v1/bridge/browser-workspaces/capture`：有界二进制；`x-allrice-browser-capture` 保存 base64url 类型化元数据。两条设备路径是精确代理例外，不放宽整个 Bridge/admin 前缀。
- ChatFlow 复用 `/api/v1/runtime/browser-workspaces` 和既有审批 API。WorkspaceView 显示 cloud/local、设备名称及显式保留登录状态。

## 当前证据及发布门禁

服务端窄提交包括：14 项真实独立 PostgreSQL 测试；HTTP envelope、proxy、Worker 输入/可见性和 DSH adapter 测试。与最终 P21 控制和既有 Runtime Ledger 回归一起执行，53 项 PostgreSQL 测试通过。公网 origin 预检另有 34 项无 DNS 正反例；真实 PG 验证 local/cloud 私有地址安装均失败且不落授权。

另一个待集成验收已实际跑通：真实 HTTP 端口 → 生产 Web handler → PostgreSQL → 实际 Bridge HttpAuthority/Controller → 实际 Worker adapter，完成审批、唯一执行、新观察、工件、outbox 和撤销。此验收的 **renderer 是合成驱动，不是实际 Chrome**；测试文件 `local-browser-http.integration.test.ts` 随 Bridge runtime 完成后单独集成，不能作为窄后端提交的浏览器实物证据。

真实 Chrome 的父进程硬停、端侧清理和完整 UI 验收由后续验收提交提供；这些门禁完成前不视为 P22 发布完成。本提交未部署 Dev/Prod，未调用计费模型，没有读取真实 Keychain 或租户数据。
