# P11：同端口 Bridge WSS 服务端

归属：B3 / MET-125 / MET-106-B。只升级连接与传输，不新增执行权限、不改 ChatFlow SSE、不增加 Agent Loop。Bridge 双通道客户端、输出日志续传与失联重试策略在 P12。

## 运行方式与灰度

`apps/web/server.mjs` 是同端口 Next custom server；`pnpm --filter @allrice/web start` 使用它，仍支持 `--hostname` / `--port`。`start:http` 保留旧 `next start`，关闭新传输即可回滚到纯 HTTP。`dev` 同样经过 wrapper，其余 upgrade 事件仍交 Next。

默认 `ALLRICE_BRIDGE_WSS_ENABLED=0`。只有 WSS 与 `ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED` 均为 `1` 才接受新连接。关闭时 upgrade 返回 404，不要求创建数据库连接，更不自动开启本地 Runner、安全策略或权限。

Dev 的现有域名已代理到 Web 3001，无需新开放 Worker 3102 或端口。正式灰度前，由批次部署流程将 **整组** LaunchAgent `ProgramArguments` 指到 release 内 `apps/web/server.mjs`；本 PR 不修改 live plist / .env / 实际租户数据。迁移 0081 是增量表和通知触发器，旧 HTTP 代码可继续运行；回滚保留表，不删除连接或操作历史。

Next 16.2.1 的 custom server 会在第一次 HTTP 请求后注册自己的 upgrade listener。本实现通过 `AllRiceHttpServer.emit` 仅截取固定 Bridge 路径，避免 Next 的第二个 listener 提前销毁 Bridge socket。所有其他事件仍调用原 `Server.emit`。已用真实 production build 子进程验证先 HTTP 后 Bridge，不靠只测手写 HTTP handler 冒充完整 Next 验证。

## 协议与鉴权

- 路径：`/api/v1/bridge/socket`；不接受 query、URL token、Cookie 或浏览器 Origin。
- 子协议：`allrice.bridge.v1`。这不是旧 `BridgeProtocolVersion=2` 的变更，两者独立。
- 设备凭证只在 TLS 连接握手的 `Authorization: Bearer …` header 中提供。服务端不记录 header/token/frame body；传输表也不存凭证。
- 先校验握手字段和协议，再在 PostgreSQL 事务中通过 token hash 认证、锁定未撤销设备，最后注册连接。认证失败不创建或替换连接。
- welcome：`version/type/connectionId/deviceId/epoch/heartbeatMs/maximumFrameBytes`；没有执行权限、租约 token 或命令内容。
- request：`{version:1,type:'request',id:UUID,action,operationId?,body}`。
- action 仅为 `operation.next/start/heartbeat/output/receipts/service`；`next` 不接受 operationId，其他必须有 UUID。P09-c 的 `service` 路由仍由其原授权 HTTP handler 校验；P11 不实现或扩充服务输入权限。
- response：`{version:1,type:'response',id,status,body}`；wakeup 只有 `{version:1,type:'wakeup'}`，是提示，不是命令或授权。

严格 schema 拒绝任意 URL、Header、未知 action、版本以及作用域注入。服务端把 action 映射成固定 `/api/v1/bridge/device/operations/...`，目标始终是本进程配置的 `127.0.0.1:port`，不跟随重定向、不接受客户端目标 URL。原握手中经过语法验证的 Host 仅用于既有 portal 路由；不会决定网络目标。真实 operation HTTP adapter 再次认证设备，继续使用 `createGovernedBridgeOperationLedger` 的冻结配置、审批、Run、预算、工作区和 lease 检查。

实测补上了 `proxy.ts` 先前漏列的新设备 operation/runtime-profile 路由白名单：这使 Bearer 请求能到达其专属 handler，而不是被网页登录先拦截。仅放行列举动作，不放行设备管理、审批或任意 `/bridge/*`。

## 多实例与撤销

`allrice_bridge_connections` 每设备一行：组织/工作区、connectionId、serverId、递增 epoch、expiresAt。单设备注册在设备行锁下串行化，跨实例也只有一个当前 epoch。

每个 request **开始前及发送响应前** 都检查当前 PG epoch 与设备撤销状态；服务端每 5 秒检测 pong 并续租，连接租约为 30 秒。新连接替换旧连接时，旧 owner 的迟到关闭/续租都不能覆盖新 owner。没有 pong、租约过期、设备撤销或数据库不可用都关闭 socket。

`LISTEN/NOTIFY` 只用于加速旧连接关闭和工作唤醒；通知丢失由逐请求检查与心跳检查补足。设备撤销触发器即刻将连接租约到期；既有旧设备替换配对产生的 revokedAt 也走同一机制。

**连接 epoch 不是操作 lease。** 已在旧连接切换前进入既有账本事务的请求可能已提交；换连接后丢弃其旧连接响应，不凭 socket 关闭推断“没有执行”。PG 操作状态与 Bridge journal 仍决定后续行为。WSS 断线不会自动转移任务到云端或重做副作用。

## 不重复执行、背压与失败语义

- 网关不自动重发任何 RPC，不把连接 ACK 当执行成功。`next/start` 响应丢失的歧义由 P12 沿既有 journal/账本策略处理，不能宣称必然恢复执行。
- output/receipt 的去重仍由原 operationId/attempt/lease/sequence/receiptId 权威完成。P11 没有第二套内存命令队列。
- 单帧至多 750,000 bytes，关闭压缩；单连接最多 8 个待处理请求及 1,500,000 待处理 bytes，进程待处理数据至多 8 MiB。
- 单连接发送 buffer 至多 1,500,000 bytes，进程总发送 buffer 至多 16 MiB；超过关闭连接，不悄悄丢包再伪造成功。
- 进程最多 256 个 socket/握手，以及 32 个同时鉴权；握手、HTTP response 都有时间上限。重复的同时在途 request ID 被拒绝，已完成 request ID 不是执行幂等凭证。
- 本机 HTTP 返回体有限长（保留 envelope 余量）；HTTP 超时、连接中断、无效响应关闭 WSS，客户端不能把这些失败都当成可重试的 start。

## 验证与边界

普通单元测试覆盖协议固定路径/作用域/未知版本，以及 portal 设备与管理端边界。

真实测试使用单独 `allrice_b2` 数据库下随机 schema，加载正式 migrations；用两台独立 gateway 与真实 WebSocket、既有 HTTP handler 和 PostgreSQL ledger，覆盖认证、租户隔离、连接替换、丢失 NOTIFY、设备撤销、帧限、请求洪泛、实际暂停 TCP reader 的输出背压、数据库不可用、响应丢失、并发注册、到期不续租、无 pong 和无敏感内容的工作唤醒。

运行：

```sh
pnpm --filter @allrice/web... build
ALLRICE_RUN_DB_INTEGRATION=1 \
ALLRICE_P11_NEXT_BUILD=1 \
ALLRICE_TEST_DATABASE_URL=postgresql://a123@localhost:5432/allrice_b2 \
pnpm exec vitest run apps/web/server/bridge-socket.test.mjs
```

`ALLRICE_P11_NEXT_BUILD=1` 额外启动真实 Next production build，开启 portalAuth，再从握手 Host 对应 portal 经固定 loopback 访问操作 API。测试不修改 Dev/Prod、使用合成设备，不调用付费模型。公网 TLS/代理长连接验收留本批统一 Dev 部署；没有宣称已验证正式 M/Intel 安装包。

主要实现参考是 [ws 8.21.3 官方代码和鉴权/共享 HTTP Server 示例](https://github.com/websockets/ws/tree/8.21.3)、[Next 官方 custom server 文档](https://nextjs.org/docs/app/guides/custom-server)、[PostgreSQL 17 NOTIFY 事务语义](https://www.postgresql.org/docs/17/sql-notify.html)。仅使用 ws 的依赖实现，不复制其他 Agent Loop；依赖锁定 `ws@8.21.3`。Next 文档指出 custom server 与 standalone 输出不组合使用，本项目保持现有非 standalone 构建。
