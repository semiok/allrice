# P21 / MET-135：云端受控浏览器工作台

本阶段是在既有 Run / Job / Managed Browser / Runtime Ledger 上增加浏览器 I/O controller，不增加模型循环。P22 将消费同一浏览器控制协议与 `@allrice/browser-control` renderer；本阶段不开放 Bridge、本机私网或个人 Chrome Profile。

## 启用边界

- 新能力默认关闭：需要 `ALLRICE_BROWSER_CONTROL_ENABLED=1`、`ALLRICE_RUNTIME_POLICY_ENABLED=1`，现有云执行目标授权与 `ALLRICE_CLOUD_RUNNER_ENABLED` 仍适用。工件工作台使用既有 `ALLRICE_WORKBENCH_ENABLED`。
- 员工发布的冻结工具集必须显式包含 `browser.workspace`，活跃 assignment、Run、Job 租约、目标与管理员创建的 browser grant 全部有效才允许执行。
- 管理员通过 `POST /api/v1/runtime/browser-workspaces?workspaceId=...` 的 `kind=grant` 设置精确 `targetId`、`ownerId` 和 Profile。Profile 仅允许公网 HTTPS/443 精确 origin；上传、下载、人工敏感输入分别显式授权。
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

人工敏感输入走同源、真实会话、owner 范围 HTTP API。数据库只保存 AES-GCM 短期密文引用；AAD 绑定租户、工作区、Run 所属浏览器、Profile、用户、fence、观察与 element。控制器在返回明文前原子消费，失败也不重放；输入进入浏览器后清空 Buffer，观察、截图和标签遮罩敏感字段与本次输入值。页面本身仍可能显示用户数据，全部作为不可信外部内容，不作为平台指令。

## 接口与复用点

- Canonical tool：`browser.workspace`，DSH native wire：`browser_workspace`；open / act / close，无任意 JS 或 selector。
- HTTP GET：按 owner / tenant / Run 返回 workspace、只读当前授权、原始审批与结果。
- HTTP POST：`control` / `act`（仅 human）/ `input` / `grant` / `revoke_grant`；审批继续走既有 `/api/v1/runtime/approvals/:id`。
- `packages/database/src/browser-control*.ts`：当前身份与授权、精确准入、控制意图、密文引用、工件。
- `apps/worker/src/browser-control/controller.ts`：Run 所有的物理 I/O 生命周期与无重放回执。
- `packages/browser-control`：无 DB 的共享 renderer，调用方必须提供可信 URL guard、当前授权检查、同步请求保留与精确审批回调。云端入口固定公网策略，不能由请求传入例外。
- ChatFlow 新面板仅在 `browser.workspace` 事件出现时加载，展示观察、脱敏截图、审批、人工控件和历史回执；旧 `browser.run` 不改变。

## 验证与未完成门禁

当前已通过：协议、密文、真实隔离 PG 准入/撤权/fence、实际 Chromium DOM、真实公网 pinned HTTPS 的合成登录/上传/下载与新 context Cookie 隔离。公网组件测试使用精确合成 fixture 和审批回调；不能把它算作真实 PG + Web + Worker 的完整端到端验收。

合成公网测试曾暴露导航期间混合观察和只读 capture 导航竞态，已修复并保留失败轮次。测试结束恢复仅测试域名的临时 DNS 例外并关闭自有 tunnel/fixture；没有启用主 Dev 或真实租户权限。

本提交首先固定 P22 可复用接口。负向测试扩充、真实 UI 与 PG/Worker 浏览器闭环仍需后续验收提交；在这些门禁完成前不视为 P21 发布完成，也不宣称 Dev/Prod 已部署。
