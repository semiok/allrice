# 宿主模型网关 v1（MET-268 / M1-04）

离当前目标还差什么：本片提供可装配宿主包、实际HTTP计量和持久准入。还需当前身份/受管VM入口/原生会话树owner、真实subscription loader的SSE配置与出口接线、账号/后台消费、隔离PG验证和批次独立复核；真实VM/模型与Dev验收尚未执行。没有开启4.0或改变3.x运行入口。

## 版本、公开出口与五面

moduleId=`host-model-gateway`；owner=MET-268；contractVersion=`MODEL_GATEWAY_CONTRACT_VERSION=1`，包0.1.0。producer/consumer仅支持v1；HTTP header版本不符拒绝，不声称支持未来schema。DSH单代`0.2.1-rc.2`，源码commit`687f282e8625c6b8d11ff58211a90524be2e4317`（`apps/worker/dsh/distribution.json`），Node22.23.2。此服务不是EmployeeModuleRelease，使用宿主gatewayRelease/employeeRelease精确pin。

公开根入口`@allrice/model-gateway`，无deep exports。新增出口sourceAtSha=`733163b1c65404f8002bfe81013817f0b31481d4`，符号清单位于`packages/model-gateway/src/index.ts`，具名合同位于`src/contract.ts`，方法分别在`src/gateway.ts`、`src/dsh-provider.ts`、`src/postgres-store.ts`。该提交的产品源码与本记录封版时相同；每个方法与下列具名type一一对应，JSON检查器不建立信任。

| 允许符号                                                                                                 | 用途/来源                                                                     |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `MODEL_GATEWAY_CONTRACT_VERSION`, `MODEL_STREAMS_PER_PERSON`                                             | v1和用户决定每人8路                                                           |
| `ModelCallBinding`, `ModelGatewayAuthority`                                                              | host-only当前身份/VM epoch/native root-child/Run/call/release合同             |
| `GatewayModelInput`, `GatewayProvider`, `GatewayFetchClassification`                                     | DSH GenerateOptions消息/工具/生成控制项的薄projection；host provider/HTTP分类 |
| `ModelAttemptStart`, `ModelAttemptReceipt`, `ModelUsage`                                                 | 持久意图和独立上游事实；缺失tokens/status/terminal为null                      |
| `ModelGatewayStore`, `CapacitySubscription`                                                              | owner构造/存储端口，其他业务模块不得绕过授权端口使用其read/reconcile方法      |
| `UsageLedgerPort`, `ModelGatewayPort`, `ModelGatewayError`, `ModelGatewayErrorCode`                      | 对外服务合同与具名错误；不扩ApiError.details                                  |
| `createModelGateway`, `createDshGatewayProvider`, `GatewayLlmAdapter`, `createPostgresModelGatewayStore` | 可信宿主装配、现有native loader注入、guest公开原生LLM adapter、owner PG后端   |

| 面                         | 当前实现与未接边界                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 后端/私有数据              | present：网关、UsageLedgerPort和三表owner，表不向其他模块开放                                                                                          |
| MCP                        | none：模型/计费管理不是员工工具；本片只接原生LLM provider                                                                                              |
| 员工右栏/主区              | 既有账号用量入口是present需求；本片未接UI，后续经可信BFF消费UsageLedgerPort，不新增业务tab，不等同计费完整迁入                                         |
| 后台                       | 既有用量/计费/诊断面是present需求；本片无UI实现/授权。当前port只查询本人当前企业，跨本人后台查询须另由现权owner公开口接线                              |
| 权限/企业员工开关/资料级别 | present：当前身份+员工/VM/native call资格由authority核验；开关/名单沿已批发布配置。本片无新默认env；模型不得自启。资料级none（计量运维事实不授资料权） |

## 精确依赖及schema映射

- `@allrice/contracts#RequestContext`/`RequestContextSchema`与`ExecutionContext`：sourceAtSha=`6bf356b5a8e3ce2b72a20fd825e5e2ec77dd7190`，`packages/contracts/src/authorization.ts`。本包只取ExecutionContext的runId/executionId关联，不创建Run/Job或把policySnapshot当当前权限。
- `@allrice/contracts#RuntimeRunUsage`：同SHA，`packages/contracts/src/runtime-run-usage.ts`。输出input含cache、cache是input子集；null不是0、usageComplete/cacheUsageKnown及真实attempt/receipt计数沿既有type，不谎称已有Zod schema。
- `@allrice/person-vm#PersonVmBinding`：sourceAtSha=`34c6589bcfbb0283a886da2759277424718d6047`，`packages/person-vm/src/contract.ts`。精确vmId/personId/org/instanceId/leaseEpoch；本包不读其表、不管理VM生命周期。
- `@deepseek-ai/dsh-llm#LlmRuntime.prepareCall`, `LlmAdapter`, `GenerateOptions`, `StreamChunk`, `LlmError`：上述固定代际公开根出口。消息/工具/增量保持原生type。GatewayModelInput明确排除guest的provider/model/sessionId/signal；身份不是body DTO。

owner数据：`allrice_model_gateway_calls`仅不可变可信调用claim和请求digest；`allrice_model_gateway_attempts`仅逐HTTP intent/receipt/usage；`allrice_model_gateway_slots`仅全局person的1..8格租约。其他模块只调授权后的公开服务，不跨表联查。无secret/header/原始prompt/response字节持久化；binding中身份/权限快照是host审计关联，不能替代调用时现权。

现有runtime-ledger需要RuntimeRoot/ExecutionTarget/Bridge operation及预算状态，不表达原始HTTP retry/refresh或跨Run每人流数；旧llm/stream账本是native聚合且provider可能合成0。本片的host attempt是4.0唯一实际上游计量事实；UsageLedgerPort单向投影，未接价格/结算，旧3.x账本未修改，不产生平行扣费权威。

## 方法、权限、取消和恢复

| 公开方法                                              | 输入/结果/错误及真实保证                                                                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ModelGatewayPort.handle(req,res,binding,signal)`     | 可信host route参数传ModelCallBinding；业务JSON为GatewayModelInput。返回v1 StreamChunk NDJSON。ModelGatewayError或原生LlmFailure；guest header/body不参与绑定。入口、每次新fetch/排队后/返回chunk前复核当前authority |
| `ModelGatewayPort.revoke(binding)`                    | 精确PersonVmBinding；拒绝新准入，主动abort当前/排队请求，等待实际owned drain。旧epoch延迟撤销不作用新epoch；不能把whenIdle当cancel                                                                                  |
| `ModelGatewayPort.close()`                            | 停新准入、取消并等待本实例请求和provider iterator、归还自己fetch hook；不停止别人gateway/VM/服务                                                                                                                    |
| `ModelGatewayPort.reconcileOwner(ctx,ownerId,signal)` | authority先认证当前操作者并取得该精确宿主死进程/全部transport已停止的独立evidenceRef，才可记unknown并释放owner精确slots；guest header/receipt、超时或心跳缺失无效                                                   |
| `UsageLedgerPort.summarize(ctx,signal)`               | authority核当前本人和企业，再输出RuntimeRunUsage。没有guest personId选择器，没有写账/价格/额度接口                                                                                                                  |
| `createDshGatewayProvider(llm,route)`                 | 现有subscription loader已初始化的LlmRuntime；prepareCall固定adapter代际。route必须是同provider/model与SSE，`classify`固定host model/refresh endpoints；未分类外发拒绝。生产API实现注入同GatewayProvider合同         |
| `GatewayLlmAdapter.stream(options)`                   | guest公开DSH端口，只把原生消息/工具/控制项送受管host endpoint；不持上游凭据、不增加retry/reconnect/账户路由，native signal传实际HTTP                                                                                |

ModelCallBinding每次调用必有current RequestContext、PersonVmBinding、员工实例/release、allriceThreadRef、native instance/profile/session/root/parent/call、run/execution、executionGeneration、gatewayRelease和host provider/model。root parent必须null，child必须有parent/root映射；实际谱系/归属由authority从当前host/原生descriptor事实核验，字符串形状不是信任。workspaceId沿原RequestContext可null。ownerId每个真实宿主进程/transport owner独立产生，重启不能复用旧ownerId冒领恢复。

原生VM侧call选择器仍需可信入口/原生事实owner绑定，不能仅凭guest自报相同call字符串生成此binding。本片不提供能把任意JSON提升为可信context的构造器。登录/会员/VM实例等依赖不可用时拒绝，不跨读其表维持表面成功。

## 实际HTTP、8路与未知

每个实际上游fetch在其完整不可变async scope中执行，包含prepare与iterator.next/return，父/子调用沿各自可信绑定。classifier不从模型消息选账户。model和auth-refresh分别落attempt；8格只约束活跃模型流，按全局personId跨org/gateway共享。先LISTEN再原子重查；PG NOTIFY重连也唤醒重查，无任意轮询/TTL/队列上限或新增产品超时。

每人事务advisory锁保护slot领取和intent写入。intent提交后才调用fetch；DB故障发前fail closed。DB与网络无法原子，所以intent不证明上游收到/收费；崩溃未闭记录保留dispatchObserved=null/usage=null。请求失败也有独立回执，不把最终provider usage复制给所有HTTP retry。auth-refresh无模型usage，余额未知。

fetch明确`redirect:manual`，每次可观测HTTP尝试不隐藏重定向请求。wire observer跟随consumer pull，不tee、不全量缓冲响应，逐行/事件计量捕获各最多65,536字符；超过观察范围仍原字节流过，usage未知，不改变请求/输出容量。chat必须finish_reason和[DONE]；Responses必须明确terminal，failed/incomplete不作成功。provider最后的usage不负责计费，合成0不转为已知数。

slot只在实际reader EOF/awaited cancel与receipt提交后释放；close失败/DB提交失败占位保留，不因报错、取消请求或进程心跳消失而提前释放。原生pi-ai在解析terminal后会关闭私有consumer信号，此正常close和真实host/client/revoke取消分开；在持久原始terminal与native成功finish均成立前不输出成功finish。取消不撤销已发生费用/副作用。

重连同一(vm/instance/epoch/native instance/session/call)命中持久claim则409，不自动重放、重建native线程或迁到3.x。恢复集合包含三表、host owner/transport停止旁证、VM epoch/原生映射/员工和gateway release；恢复旧盘/账本不能使旧claim和效果丢失重收。

## 验证和未接事项

本地单包loopback检查走真实HTTP fake upstream→固定代际原生DSH provider→host gateway HTTP→公开guest adapter：文本/工具增量/工具结果往返、401/429/5xx、无terminal/usage、取消、9路队列/两人隔离、跨gateway同person、guest伪造/child/跨await归属、重连去重、模型重试/刷新独立回执、redirect拒绝、撤权/epoch及ledger失败。首败原件保留；修正native consumer close分类后的20项通过。

`postgres-store.integration.test.ts`声明db资源，默认环境不运行；由主会话m5-test执行跨store真实PG8路、NOTIFY/恢复、无TTL、claim幂等、receipt/slot事务回滚与不可变事实。新增收敛登记须跑直接受影响的既有`dsh-convergence-gate.test.ts`/`.integration.test.ts`，以及既有`route-usage-unknown.integration.test.ts`，保护unknown语义。本片不声称这些检查已通过。

未证：真实host identity/native树owner装配、SSE-only loader固定与MET-269出口阻止直连旁路、真实VM/模型运行、账号/后台消费、整批Astra/门禁、迁移演练、Dev部署/验收。instructions未新增AllRice段，未做装配tokenizer验收。本片不以native parent/child fixture替代真实子会话回归。MET-225行交主会话登记；无Linear写入。
