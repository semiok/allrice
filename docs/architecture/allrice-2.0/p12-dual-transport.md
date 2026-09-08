# P12：Bridge 双通道与有界证据续传

归属：B3 / MET-126 / MET-106-B。依赖 P11 服务端、P03 操作账本和设备 SQLite journal；只改变传输及恢复，不新增执行权限，不增加 Agent Loop，不替换 ChatFlow SSE。

## 选择通道

Bridge 在 `ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED=1` 且 `ALLRICE_BRIDGE_WSS_ENABLED=1` 时优先连接同源 `/api/v1/bridge/socket`。设备 Bearer 仅放在原生 TLS 握手 header，不放 URL、Cookie、网页上下文或日志。生产要求 HTTPS；只有显式 loopback 允许 HTTP 测试。不跟随重定向。

只有枚举的 operation API 使用 WSS；配对、工作区等原有接口仍走 HTTP。新客户端与服务端都默认关闭 WSS，旧客户端继续使用既有 HTTP。服务端关闭 WSS或升级握手暂不可用时，新客户端回退 HTTP；401/403 是凭证拒绝，不以切换通道绕过。设备身份改变或退出 Bridge 时关闭旧连接。

重连采用有上限的指数退避和抖动；wakeup 只缩短轮询等待，不包含命令或授权。最大在途请求数、帧长、发送缓冲与 HTTP 返回体都有界，超限/超时关闭连接。服务端连接 epoch 与 PG operation lease 是不同概念，连接恢复不会产生新的执行权限。

## 响应丢失时，什么可以重试

| 请求                                            | 响应不确定时的处理                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| 还未发送的请求                                  | 可回退原 HTTP adapter，仍需原授权校验                                                |
| `next`，新客户端声明 claim recovery             | 找回同一未启动的 dispatched attempt；不是重新领取、重新消费审批或延长 lease          |
| `next`，旧协议或旧随机 lease                    | 不盲目重发；按原账本过期/unknown 规则处理                                            |
| 已发送的 `start`                                | 不自动重放；设备 journal 留下 unknown，实际副作用不能被猜测为没有发生                |
| output / receipt / heartbeat / service evidence | 用相同 attempt、lease、sequence/receipt 标识重交；服务端幂等校验，不能重做本地副作用 |

可恢复领取使用已认证设备凭证的 request-local HMAC，从冻结 scope/device/attempt/input digest 派生同一 lease token。数据库只存 token hash；每次恢复都核对原 hash、未到期 lease、当前 device/grant/Run/权限状态。仅 `dispatched` 可恢复；已 `running` 不返回成一条可重新执行任务。恢复不增加 operation event、不重消费审批/预算、不修改期限。旧随机 lease 不满足摘要匹配，不伪装成新机制可恢复。

## 日志先落本地，再等待网络

SQLite 增量表 `output_outbox` 保存操作、连续序号、stdout/stderr、内容与确认位。attempt 与 lease 来自该设备持有的 dispatch，不接受任意调用者替换。每操作最多 256 块、合计 64 KiB UTF-8，整库容量计入预留；冲突重复、缺序号、越界内容均拒绝，不静默跳块。

本地持久化队列与网络投递队列分开：第一块网络 ACK 慢，不能阻止后续回调落盘。服务端必须在 PG 提交后返回匹配的 operationId、sequence 和请求摘要，客户端才标记已送达。普通 HTTP 200、错误序号、错误摘要不等于确认。重启可从 SQLite 重送证据，不能因此重启旧命令。

每轮最多补交 32 块，终态 receipt 在已有输出证据之后发送。未清空 outbox 时不领取更多任务。持续断网/落盘失败使运行器按原租约与终止规则停止，不以无限内存积压保活。后台服务的控制续租/输入 ACK 不应被日志网络发送阻塞；服务事件使用自己的持久化 evidence-only 补交，不投递重启后收到的新 stdin。

后台回调可能在一次空扫描后刚好完成；最终 receipt 的可投递性由同一条 SQLite 查询核对该操作没有未确认输出或服务事件，避免扫描与发送之间的竞态。原始 pending 记录仍供恢复检查和背压使用。两类 ACK 本地写入也在事务内完成，真实提交失败后停止新动作；测试验证重开数据库仍保留未确认的原证据。

## 兼容、迁移与回滚

- 服务端 output ACK 增加字段，旧 Bridge 可忽略；新客户端的严格 ACK 需要本批服务端，不能将旧服务端的弱 ACK 当成功。
- Claim recovery 是客户端显式能力，新服务端继续支持不声明该能力的旧客户端。
- SQLite 追加表，不删除原 journal/收据。回滚只关 WSS 或回到兼容 HTTP 版本，不删除未知执行或未确认输出。
- P12 没有 PostgreSQL 迁移；P09-c 的 0080 与 P11 的 0081 仍由整批按序迁移。
- 本批不发布签名/公证安装包，不开启 M 芯片未验证 Runner，不改变租户授权，不自动把本地任务迁到云端。

## 验证

`dual-transport.test.ts` 使用真实 TCP/WebSocket 测试握手、HTTP 回退、重连、在途限制、凭证拒绝和关闭竞态；`journal-output.test.ts` 使用真实 SQLite 验证重启、顺序、容量、错误 ACK 与慢网络。合成 runner 仅用于精确触发异常顺序，不冒充 VM 实测。

`runtime-ledger/bridge-http.integration.test.ts` 使用正式 gateway、HTTP adapter、PostgreSQL、真实 SQLite 和临时文件操作，分别丢弃 next/start/receipt 响应，断言不重复实际写入；其他本地命令/后台服务集成测试覆盖 Intel VM 的真实执行、输出及进程树停止。P11 另运行真实 Next production server 与 portal 鉴权。最终公网 WSS/Dev 验收、整批测试数和 SHA 记录于批次交付报告，不能用预集成版本替代最终部署版本。
