# MET-269：每人 VM 出口门卫

本层依赖 `@allrice/person-vm` 的资格接口提交 `c35c8f17` 和模型网关 `5b7800aa`；PR 指向
`batch/4.0-n2`。当前交付的是宿主网关和真实 HTTP 入口，VM/身份/密钥投送
使用显式 owner port，尚未完成 MET-266/268 的真实 VM 联调，不宣称默认拒绝网络已部署。

## DSH 与 SaaS 边界

原生 DSH 保留 MCP、模型调用和内部审批语义，本包不复制其状态机、工具包装
或私有源码。SaaS 必补的是 VM 外门卫：当前身份/代际、业务语义出口、受控包源。
模型请求由 MET-268 的原生 SSE host composition 承担，不走本包的只读行情接口。
MET-225：无新增 DSH 默认行为或私有接口；本包仅 AllRice 宿主边界。

## 公开接口与装配

公共入口 `@allrice/egress-gateway`：`createEgressGateway` 返回
`PersonVmEgressPort`；`createOkxMarketRoutes`、`createPackageMirrorRoutes`
创建具名路由；`createPublicHttpsTransport` 为真实地址校验/固定 socket 的 HTTPS
传输。没有默认 allow 身份服务，没有默认 package/行情参数、时限、容量或监听地址。
这些由获批 host 配置显式传入。配置对象仅宿主可构造，不能从 guest JSON 传入。

必填注入：

| 接缝                         | owner / 责任                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `vm.assertAdmissionBinding`  | MET-266，每请求校对当前人/企业、完整 binding、撤权、精确出口资格；冻结物理租约不拒绝资格，不授予派发                                 |
| `admission`                  | 与 VM 同一 PG shared host；read 独占 gateway permit，排队、激活、取消和真实收尾由公开 boundary 管理                                  |
| `authority.context/allow`    | 身份与模块 owner，从受管 binding 查当前可信 RequestContext，再核当前企业/员工/路由资格；不能反序列化 guest header                    |
| `provisioner.endpoint`       | 宿主出口分配器，持久保留每 vmId 的监听端口和实际 guest 可达地址；不能用端口当身份，重启也须稳定                                      |
| `provisioner.install/remove` | MET-266 可信盘/config 写入接缝，开机前按精确 instance/epoch 写入、撤销本地 capability；不得写错 VM 或删除新代凭据                    |
| `revokeModel`                | 装配成 `ModelGatewayPort.revoke(binding)`，abort 并等待模型流/排队真实 drain；不是空回调                                             |
| `services`                   | MET-268/270 等具名宿主协议的精确 path/method；执行前同一当前 VM/资格校验。handler 自己核原生 call、业务资源及限制，不是任意 URL 转发 |

`services.handle` 得到 `{context,binding}` 来自上述可信来源，模型 handler 应经
MET-268 公开 authority 解析实际原生会话/call，再调 `ModelGatewayPort.handle`。
本包不制造 executionId 或 callId。不把 guest 请求中的同名字段变成 host binding。
真实 endpoint、盘内投送、会话/call 关联尚待 owner 接线，fixture 不是其产品实现。

`services.admissionOwner` 必须显式为 `service`。managed model 的 permit 只由
model-gateway 持有，`assertCall` 仍核完整执行身份，本地 capability 不能替代它。
read 冻结前 queued 保留；冻结后的请求进入可取消 deferred，等待双端 exact release
及真实 ready，期间不因冻结返回 403/502。read 若完整 binding 未变，先结束旧 permit，
重新获取当前权限并 fresh admit，然后才执行首次 I/O；再次冻结时仍可继续 deferred。
binding 已变则取消旧 read，不能重标或重放。模型旧执行由 model-gateway 返回
`EXECUTION_REBIND_REQUIRED`，不走 read 的 fresh admission 路径。
网络 timeout 只从 active 阶段开始；permit 保留到 HTTPS request/response 真正关闭及
下游响应结束。取消同样等待实际收尾；没有新增本地冻结状态或 VM 私表读取。

## 连接资格与生命周期

每次 prepare 生成随机 256-bit **VM 本地访问资格**，只经可信 provisioner 给指定
VM。它不是上游模型/公司凭据，不出现在公开 receipt；上游 token 不进入本包或 VM。
HTTP 必须同时满足该资格、精确 Host、当前 VM 代际和权限；其他 VM/宿主仅知道端口
不能访问。npm 用 Bearer，pip 可用 netrc 的 `egress` 用户名和本地资格；禁止打印
配置、Authorization 或含秘密的日志。资格不可作为真人外发批准。

同一 vmId 的 prepare/revoke 串行；换代先撤旧资格、abort 并等待只读与模型请求
收尾再开新 listener，端口不变。旧 receipt 的延迟 revoke 不作用新代。
失败时资格保持关闭；cleanup 任一失败都报告不完整，VM owner 继续按合同尝试 stop，
不能因此宣称已可卸盘。宿主崩溃时 listener 消失；重启须经持久 VM owner 的新 epoch
和稳定端口恢复，不把本进程内状态当跨进程租约。

GET 只读响应有界缓冲，返回前再核一次权限，防止撤权后把整份新响应交回；流服务
由其 owner 传递同一 abort 信号并遵守持续权限检查。HTTP CONNECT/Upgrade 不提供，
模型只注册 SSE，不允许未计量 WebSocket 旁路。

## 语义出口

- OKX 只提供 SPOT instruments 与 candles；symbol/bar/maxCandles 来自 host 配置，
  不固定样机的 ETH，也不提供账户/交易/撤单。拒绝重复、额外、非法参数和请求体。
  成功响应检验 code、data 及对应行形状；不把任意 GET 当只读证明。
- 包源提供 npm 元数据及 pip simple HTML；源 metadata 必须属于请求的包，制品只从
  获准源和对应路径导入。重写为本地不可猜的摘要路径，下载校验 metadata 声明的
  SHA-512/SHA-256。pip 保留 requires-python/yanked，正常解析依赖图；不限定两份 tgz。
- 本版只支持 public npm 的完整 metadata+SRI 和 PyPI JSON/simple 兼容源；旧无 SRI
  npm 包、私有仓库、git/direct URL dependency 不自动放行。需要扩展协议时登记合同，
  不能退回公网 CONNECT。制品索引容量显式配置，满额失败而非解除校验；进程重启后
  客户端重新取得 metadata，旧未知制品 ID 失败，不乱指向别的字节。
- 宿主 transport 使用原有 `sandboxPublicAddress`，查全部 DNS 回答、排除宿主地址，
  连接已验 literal IP，TLS servername 仍为原主机。无二次解析、代理、重定向、自签 CA
  或 DoH fallback。此为出口 transport，不修改 M1 的 Clash/DNS 设置。

## 五面、存储和恢复

后端：本包仅运行时连接资格与公开包制品索引；稳定端口/VM 绑定归 VM/宿主 owner，
不新增业务表/迁移。MCP：行情可由原生 MCP owner 绑定本地路由，包管理用标准 HTTP；
无万能网络工具。员工 UI：无新增面板，沿原生工具错误。后台：本层无新页面，仅
暴露现有错误给 owner 的诊断通路；管理页接线归后续后台模块。开关/权限：每次
authority.allow 的当前资格与 routeId；同人不同员工不宣称强隔离，root 已获字节不能收回。

恢复集合包括 owner 的 VM 绑定/端口分配/配置版本；本地访问资格重新颁发，旧资格失效。
包索引可从已校验 metadata 重建，不作为授权数据库。`assertActive` 只证明本地出口
活性，外层 VM `assertCurrentBinding` 才证明本人/租约，不能反过来缓存它当永久授权。

## 验证与未完成项

测试从真实 HTTP 入口覆盖合法行情、伪身份/错误资格、重复参数、危险路径、撤权、
同端口换代、旧回执、在途取消和 cleanup 失败；包测试覆盖 metadata 来源、摘要字节、
标准 npm/pip 两级依赖图，使用本机合成上游，不访问真实包源/模型账户。
`clients.test.ts` 需要 npm、python3/pip、tar（M5/CI 的既有开发工具）；独立临时 HOME，
不读取用户 npm/netrc 配置，运行结束删除本地资格/文件并关闭 listener。

仍须节点 2 联调：MET-266 实际网络策略读回+root DNS/IP/私网/UDP/WS 旁路负向；
实际凭据投送/稳定端口分配；MET-268 SSE 原生装配与精确模型撤销；真实 BFF 当前身份。
本层的 fixture allow 或合成 binding 绝不能进入生产 composition。缺任一项不报整卡联合验收通过。
