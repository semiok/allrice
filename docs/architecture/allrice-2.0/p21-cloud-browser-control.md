# P21 / MET-135：云端受控浏览器工作台

本阶段是在既有 Run / Job / Managed Browser / Runtime Ledger 上增加浏览器 I/O controller，不增加模型循环。P22 将消费同一浏览器控制协议与 `@allrice/browser-control` renderer；本阶段不开放 Bridge、本机私网或个人 Chrome Profile。

## 启用边界

- 新能力默认关闭：需要 `ALLRICE_BROWSER_CONTROL_ENABLED=1`、`ALLRICE_RUNTIME_POLICY_ENABLED=1`，现有云执行目标授权与 `ALLRICE_CLOUD_RUNNER_ENABLED` 仍适用。工件工作台使用既有 `ALLRICE_WORKBENCH_ENABLED`。
- 员工发布的冻结工具集必须显式包含 `browser.workspace`，活跃 assignment、Run、Job 租约、目标与管理员创建的 browser grant 全部有效才允许执行。
- 管理员从 ChatFlow 侧栏进入 `/workspace/browser`，选择执行目标、授权使用者和精确站点，分别授权上传、下载与人工敏感输入。页面的只读管理投影为 `/api/v1/admin/browser-control`，写入复用 `POST /api/v1/runtime/browser-workspaces?workspaceId=...` 的 `kind=grant`。Profile 仅允许公网 HTTPS/443 精确 origin；登记授权不会启动浏览器，不替代员工发布的冻结能力。
- 人工敏感输入必须配置专用随机 256 位 `ALLRICE_BROWSER_CONTROL_KEY`（64 位 hex），不得复用模型、MCP 或 Bridge 凭据。缺少密钥时拒绝输入，不降级明文。
- 迁移 `0089_browser_control.sql` 只增加表，不创建 grant、员工授权或启用任何 Feature Flag。

## 权威与实际动作

`BrowserCommand` 绑定浏览器工作区、当前 Run、Profile、actor、控制 fence、观察 ID 和精确动作。浏览器控制 fence 与 Runtime Ledger 的执行 attempt fence 是两种独立概念。

1. 创建动作时使用既有账本准入。修改输入、点击、导航、上传、下载必须确认；策略 Allow 不会绕过这些动作的 Ask。
2. Renderer 拦截所有浏览器请求。每个实际 POST/PUT/PATCH/DELETE 另外绑定真实 URL digest、method、body digest/bytes 和父动作进行审批；只批准点击不等于批准任意表单提交。
3. 每次动作、请求发出和交接 ACK 前重新读取当前授权。DB 异常、撤权、失效观察和 Profile 不匹配均拒绝。
4. 先持久化派发/开始，再执行真实 I/O。进程重启不重放已派发动作；无法确认效果记为 unknown。

公网 DNS、CONNECT pinned proxy、精确 origin 与重定向/子资源检查共同生效。Chromium 使用独立临时 context，禁止 Service Worker、WebSocket、弹出窗口和绕过代理的 QUIC/UDP。它不是通用命令行、任意 DevTools 或个人浏览器接管接口。

## 人工交接与敏感输入

接管、暂停、恢复和关闭 API 只记录意图并递增 fence。controller 等当前 I/O 和请求审批/请求完成边界结算后，采集新观察再 ACK；UI 在此之前显示“等待实际停止”，不能输入。关闭只有真实 browser/context/proxy close 成功才填写 `stoppedAt`，否则为 unknown。

操作心跳在物理 I/O 结算后、终态回执写入前停止并排空，避免慢截图对已完成操作续租造成错误关闭。控制 fence 切换使旧操作失效，但不自动证明整个浏览器失权；只有重新检查完整 live authority 通过才继续完成交接 ACK。UI 持续轮询到物理关闭/未知，即使助手聊天消息已经结束；旧操作尚未结算或新观察尚未发布时禁用下一次人工输入，过期观察仍可通过“更新观察”恢复。

人工敏感输入走同源、真实会话、owner 范围 HTTP API。数据库只保存 AES-GCM 短期密文引用；AAD 绑定租户、工作区、Run 所属浏览器、Profile、用户、fence、观察与 element。控制器在返回明文前原子消费，失败也不重放；输入进入浏览器后清空 Buffer，观察、截图和标签遮罩敏感字段与本次输入值。页面本身仍可能显示用户数据，全部作为不可信外部内容，不作为平台指令。

## 接口与复用点

- Canonical tool：`browser.workspace`，DSH native wire：`browser_workspace`；open / act / close，无任意 JS 或 selector。
- HTTP GET：按 owner / tenant / Run 返回 workspace、只读当前授权、原始审批与结果。
- HTTP POST：`control` / `act`（仅 human）/ `input` / `grant` / `revoke_grant`；审批继续走既有 `/api/v1/runtime/approvals/:id`。
- `packages/database/src/browser-control*.ts`：当前身份与授权、精确准入、控制意图、密文引用、工件。
- `apps/worker/src/browser-control/controller.ts`：Run 所有的物理 I/O 生命周期与无重放回执。
- `packages/browser-control`：无 DB 的共享 renderer，调用方必须提供可信 URL guard、当前授权检查、同步请求保留与精确审批回调。云端入口固定公网策略，不能由请求传入例外。
- ChatFlow 新面板仅在 `browser.workspace` 事件出现时加载，展示观察、脱敏截图、审批、人工控件和历史回执；旧 `browser.run` 不改变。

## 验证与覆盖边界

已通过：协议、密文、真实隔离 PG 准入/撤权/fence、管理员/member/归档/跨租户负向检查、实际 Chromium DOM、真实公网 pinned HTTPS 的合成登录/上传/下载与新 context Cookie 隔离，以及管理路由精确代理 allowlist 与失败路径。慢截图心跳结算竞态用真实 PG 修前复现、修后回归，未放宽权限或超时。

`scripts/acceptance/runtime/p21-browser-workbench.ts` 使用随机专用 PG schema、最小环境、独立 Web 3021 与独立 Chromium。它通过正式 session issuer 创建合成登录会话并进入原生页面，再从 UI 创建 grant、刷新审批卡片、审批导航、请求人工接管、输入短期加密密码、审批真实表单 POST、选择上传文件并分别审批文件动作和真实上传 POST、审批下载并保存已交付工件、暂停/交还、撤销 grant，并验证旧审批 403 与实际物理关闭。上传/下载计数逐次核对，原生下载文件内容逐字核对。窄屏无水平溢出，页面无 JavaScript 错误。它不使用模型、不读取个人浏览器 Profile，且不是邮箱密码登录测试，也不等于主 Dev 已启用高权限。

合成公网测试曾暴露导航期间混合观察、只读 capture 导航竞态、新管理 API 精确代理遗漏、助手消息结束后 takeover UI 不轮询，以及慢截图心跳竞态。对应失败轮次保留，修复后独立重跑，不把部分通过写成全链路成功。公网验收仅对自有测试域名设置有看门狗的短期 DNS 例外，结束恢复并关闭自有 tunnel/fixture；不关闭公网 DNS 检查，没有启用主 Dev 或真实租户权限。

合成站点证据不代表所有生产网站兼容。CAPTCHA、任意 DevTools/JavaScript、个人 Chrome Cookie 导入、远程桌面和无人审批的高风险提交不在本阶段范围。批次集成仍须执行统一 CI、P22/P23 共用协议回归及独立 Dev 验收；此文不宣称 Dev/Prod 已部署。
