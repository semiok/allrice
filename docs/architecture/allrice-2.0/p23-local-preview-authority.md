# P23：已批准服务的私有预览权威

本切片基于 P22 后端 `01d1fdb`，仅实现数据库权威、Worker 原生入口及既有 HTTP 适配。它不发布宿主机端口、不新增代理 Agent 循环，不将普通云端或本地 BrowserGrant 扩为内网授权。

## 权限与生存期

- 默认关闭 `ALLRICE_LOCAL_PREVIEW_ENABLED`。既有 Runtime Policy、Bridge ledger、本地命令、后台服务及本地浏览器开关也都须启用；设备另须显式开启项目预览。
- 新 Run 必须冻结 `local.preview.open` 和 `network:outbound`。底层服务继续要求它原有的 `local.process.execute`、`storage:write`、真实工作区授权、精确批准和实际 START。预览不能代替任何一项服务授权。
- 仅 `ready`、HTTP readiness、未停止且硬期限未到的服务可派生一个端点。端点绑定 tenant/workspace/owner/device/Run/rootRun/process/attempt/generation/fence/inputDigest/folderGrant+version/container/image/port/deadline。
- 专属地址为 `https://p-{endpointUUID}.preview.allrice.invalid`，只交给可信进程 relay；禁止 DNS、宿主机任意端口和普通公网授权创建。内部 grant 的 purpose 为 `local_preview`，不出现在普通管理列表，不占普通 grant 配额。
- Profile 临时且不保留登录；第一版禁止上传、下载和人工凭证，不继承个人 Chrome。
- `0091` 的 `preview_heartbeat_at` 仅在现有服务交换事务通过当前审批/策略和租约复核后更新。每次预览准入要求该心跳不超过 5 秒；预览租约不超过该心跳 + 5 秒、底层进程租约和硬期限。不能用最长 120 秒的服务投递租约冒充物理存活。
- 服务停止、未知结果、断连、容器变化、工作区撤销/版本变化、当前策略改变或 Run/Job 变化均使新预览 I/O 失效。已经关闭或 unknown 的端点不会因重复点击而复活。物理终止仍需端侧实际确认。

## 接口与恢复

- 原生 `local.preview.open({processId})` 不接受 host/URL/port/job token。Worker 由真实调用上下文取 Run 身份。生成导航审批后调用既有等待机制，避免提前结束 Run 使审批与服务失效。
- `POST /api/v1/runtime/local-services?processId=...`，正文仅 `{action:"preview"}`。真实会话和同源检查后，从数据库派生 Worker/Job/冻结策略上下文，调用同一权威函数。
- 返回 `{workspaceId,endpointId,previewUrl,pending,operationId?}`。未收到 Bridge ACK 时为 pending；用户再次申请后建立唯一导航审批。HTTP 不长时间等待，也不直接执行。输入行、账本行或审批行之间发生失败，可在原来的稳定 ID 上修复；已开始/完成/未知操作不重放。
- 既有 `POST /api/v1/bridge/browser-workspaces` 的 claim 新增 `acceptPreview`，缺省 false。旧 Bridge 不领取预览。claim/heartbeat 的 workspace 可附加 `preview: LocalPreviewLease`；普通 workspace 省略该字段。
- 服务摘要增加 `previewEnabled`、`preview`。公共 BrowserWorkspaceView 仅返回 `{processId,endpointId,url,port,hardDeadlineAt}`，不暴露容器内执行上下文或 Job token。

## 验证边界

独立临时 PostgreSQL schema 中，真实执行服务创建、批准、START 和有序 ready 事件，再检验预览派生和唯一导航审批。覆盖两处故障注入恢复、跨租户/旧冻结/TCP/未就绪拒绝、旧客户端不领取、失权/短心跳失效、flag OFF 清理和并发服务/浏览器续租。

这些测试中的容器与截图事实是合成输入，不能当成物理 Chrome/VM 验收。后续完整验收须采用实际 Bridge 服务循环、原生浏览器、真实容器 HTTP relay，并在至少跨越短租约窗口的运行中检查批准/拒绝 POST、停止、断连与清理。本切片没有部署 Dev/Prod，没有读取真实租户数据或凭证。
