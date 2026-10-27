# B6：139 → 140 → 142 订阅验收收尾

2026-09-15。当前只做 Codex 订阅；本轮补测不调用外部模型，也不启用 Gemini/API。

## 结论与交付状态

| 工单          | 本轮结论                                                                | 仍需交付                                                                 |
| ------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| MET-139 / P25 | 本地功能验收补齐：失败、取消、撤权、未知用量、强退恢复及订阅增量迁移    | In Review；收尾提交的 PR/CI、合并与 Dev 验收尚未执行                     |
| MET-140 / P26 | 本地功能验收补齐：真实页面取消链、部分失败、工件、刷新及跨任务/会话隔离 | In Review；与 139 同批交付，不等待正式签名才可开发/复验                  |
| MET-142 / P27 | 新增服务端/工作台证据和逐调用收据导出能力，完整 RC 仍未通过             | In Progress；最终材料、四线/双架构矩阵、真实发布/回退及 138/143 适用门禁 |

本轮本地候选为 `f4b726fa2017b1d97fec0c7f8133414e3d5886f8`，分支 `codex/b6-closeout-139-140-142`。
全仓构建通过，Next BUILD_ID 为 `WIbS9R5RNLitFv8pIJbN4`；最终 UI 运行前后工作树干净。
候选只增加验收脚本、测试夹具、CI 步骤及文档，没有再次修改产品运行代码、依赖或迁移 SQL。
本页的后续文档提交不改变上述被测身份。

Linear 已回读确认：139/140 为 In Review，142 为 In Progress；执行总表同步为 v1.42，原阻塞关系保留。

没有 push、新建 PR、合 main、部署 Dev/Prod、修改真实租户开关或操作 M5/Intel。
`allrice`、`allrice-dev` 的既有脏工作树未动。工单依赖不为了消除红色图标而删除。

## 139：生命周期和持久状态

新增 `scripts/acceptance/runtime/p27-codex-lifecycle.test.ts` 的 **10 项**场景通过。
这些运行真实隔离 PostgreSQL、生产订阅 controller 和固定 DSH native service；模型端点是可控的 loopback 替身。
它不是新的真实 Codex transport 或全 `executeEmployeeRun` 失败场景实测。

- completed 与 partial/failed 两助手报告真实落库、产物字节可读、父级消息持久采纳，重复 settle 不重复交付。
- 单助手取消先落请求态，实际 native drain 后才出现 stoppedAt；另一助手和父级继续工作。
- 整树取消关闭新准入，迟到结果不能唤醒；不以 HTTP 202 冒充停止确认。
- 缺失用量、超额真实用量、成员/策略/员工撤权、SIGKILL 后原生日志与持久消息恢复，均不将未知清零或自动重放。
- 下一 Run 的真实准入与同 native Session 后续普通 turn 可用；该项不是第二次完整 Worker 的同会话多轮业务验收。

撤权新测试是当前授权拒绝后显式结束测试拥有的 native host；自动授权轮询/执行端关闭另由既有生产 adapter 回归覆盖。
不能把手工触发测试进程退出描述成远端 Codex 已确认停止计量。

新增 `packages/database/src/subscription-migration-recovery.integration.test.ts` 的 **4 个顺序阶段**通过：

1. 从真实 0096 SQL 状态开始，0097/0098 事务中断完整回滚，再实际应用两个 SQL 文件。
2. 历史 NULL 不被追认为 N/A；新路由 proof 不可变，当前 writer 拒绝以零费用完成可信订阅。
3. 连接池关闭/重建后，已耗尽额度、旧字段 status writer、账号变更与迟到响应隔离仍有效。
4. 冷读取保留未知 Token，新准入仍拒绝；历史账本逐项不变。

这是一次迁移旅程的四阶段，不是四次独立迁移；是连接池重建，不是 PostgreSQL 服务重启或旧二进制混部。
没有验证完整部署回退；没有可信旧 reader 时继续 **forward-fix-only**，不得删表/撤销迁移来回退。

## 140：主开发独立页面复验

2026-09-15 **12:22:36（北京时间）**完成，使用 `f4b726f` 全新构建、真实 Chrome/Next/API/PG 和上述可控 native。
测试登录身份、任务输入和模型回应明确为合成；部分失败/取消结果来自实际 controller/native 状态推进，而非直接修改终态。

- 真实 partial/failed 报告与父级采纳可见，两个同名 `report.json` 有独立 ID、命名空间和 SHA-256；通过页面打开并核对工件 API/实际字节。
- 单助手和整树的 UI POST 均为 202，独立 GET 确认请求态；刷新仍等待，执行实际 drain 后再核对停止时间与页面确认。
- 注入一次详情 GET 网络失败，页面显示错误、不伪造停止，恢复网络后重新读权威状态。
- 同 Session 后继 root 只经过真实 controller bind，无新模型请求；取消旧 root 后，新 root/job/预算/proof/active Session owner 不变。
  这遵守每个 Session 唯一 active root 的时序，不伪造两个同时拥有执行权的 root，也不宣称后继任务已执行成功。
- 同用户同租户的另一 Session 读取两个工件均返回 404；另验跨租户拒绝、空 Session 无旧助手树、回切与刷新稳定。
- 桌面及 390px 均核对，15 张截图哈希全部复算匹配；主开发查看部分失败、窄屏已停止和后继 root 未取消等截图。

最终证据目录 `/tmp/allrice-met140-evidence-yPfUph/`：

- `summary.json`：SHA-256 `c5b18ddf07eb53b289928f593630b45ba503effc56905b8177a0a948e930ae2a`。
- `met140-ui/checks.json`：SHA-256 `274415d49d40891571abc9bd738fa7cce5697d17c3992d7186b5cf97f31308c1`。
- Page 错误 0；仅允许与那一次注入详情故障匹配的固定 Chrome 网络错误；非预期 HTTP/外部请求 0。
- loopback 请求为 5 + 3，外部模型请求 0。Chrome/Next/临时登录/native/schema/存储/连接均确认清理。
  主开发另查随机 schema `p25_251f85c032f244f7844b656f6c6c553d` 已不存在，存储目录已移除。
  UI 子报告的 `fixtureLeftOpen=true` 仅表示将执行夹具交回外层 owner；外层 summary 才记录最终移除结果。

工件变更冲突不冒充页面主动提交：UI 报告保留 `artifactConflict.covered=false`。
其下层真实 PG 证据为 `assistant-output.integration.test.ts` 的精确并发去重、同 delivery 改内容/名称拒绝、同名 sibling 不覆盖，
以及 `assistant-runtime.integration.test.ts` 的同助手/路径冲突；均在本轮 120 项相关回归内通过。

## 142：可沿用的证据与仍缺的材料

真实订阅正向业务链沿用 [11:28 验收原件](p27-codex-first-acceptance.md)：
`68571d467919daa443b477d43192884664749d8f` 上真实双助手交付、持久采纳与另一普通 Session 共 8125 Token，且同源 Chrome 联验通过。
该真实业务结果没有因本轮测试脚本改动被重跑或重标 SHA；产品运行字节与依赖在本轮未变。

旧成功报告没有保存每一调用的 requestDigest/实际 Token，现场已清理，**不能倒填成正式 v2 会计证明**。
新增 verifier 从 PG 原始 request digest 与 **settled_amount** 导出实际用量，不拿预留值代替；核对 call/run/root/租户、三维结算与全树总量。
新 smoke 可保存符合原严格合同的 `subscriptionAccountingProof`，但本轮只测其合成/PG 归一化，没有产生新的正式业务 receipt。
P28 validator 未放宽，草稿 manifest 未填假材料、未改为批准。

下一轮仍需逐项取得：

1. 收尾 PR/CI 和合并身份；最终 source、lockfile、DSH upstream、Web、Worker、arm64/x64 Bridge 共七份实际材料及迁移库存。
2. 最终候选下四条真实任务线和 47 项适用矩阵。上述本地专项是可复核的分层证据，不是“47/47 已通过”；双架构各 11 项客户端观察不能只用普通单测代替。
3. 真实 Dev 登录/历史/下载/开关与发布身份；实际迁移、排空/恢复及兼容回退观察。连接池重建不等于部署回退成功。
4. MET-143 独立外部条件：Apple Developer、Developer ID、公证和可信包双机实测；MET-138 的相应正式包门禁继续保留。

不把 142 全部矩阵或 Apple 账号变成 139/140 本地开发验收的新前置，也不把 139/140 本地通过变成 RC/GA 声明。
MET-141 仍只是已完成的发布准备，不是已有正式候选批准。

## 回归索引与重现

以下 `.local/` 路径相对于本隔离仓库。普通/PG/浏览器集合可能重叠，不将数量相加冒称唯一总数。
除最终 UI 外，这些在冻结前相同源码字节上运行；后续 `f4b726f` 仅提交这些字节，没有中途产品改动。

| 报告                                                 | 结果                                          | SHA-256                                                            |
| ---------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `.local/b6-closeout-final-regular-20260915.json`     | 2461 passed / 0 failed / 899 skipped          | `0b906269c8503fb54bddc9e9cc91a451d3b00aaefdb091b3bb4b7f67913ee8a3` |
| `.local/b6-closeout-ci-root-20260915.json`           | 主开发独立 69/69，真实 PG/可控 native，无跳过 | `b07ab751a1eb9a508e22c7d2817e6f8453ce5b7c31011b22d8654c2f2c710063` |
| `.local/met139-lifecycle-related-regression.json`    | 既有权限/输出/准入/生产 adapter 120/120       | `2c36b84d45c401ccf3361fd5ed1e7b4532a10b4b6ce3e6da9ad10a7112a0f4f8` |
| `.local/b6-closeout-composer-browser-20260915.json`  | 主开发真实 Chrome/StrictMode 14/14            | `6030c900a073606a4fd8cd6a94333a6000e31dc0504ed9c31db4befdee669f3a` |
| `.local/b6-closeout-release-contracts-20260915.json` | 原严格发布合同 35/35                          | `f96c348831fc0e360ba4151911e8a8f683bfde44da1b2b6b1c77196ece22b893` |

整仓 typecheck、lint、format、build、DSH pin 通过；10 个验收脚本的独立 TypeScript 程序零诊断。
CI 新增无真实凭据的 69 项步骤，显式复用既有专用本地/CI 数据库白名单；活模型 smoke 的默认数据库 pin 不放宽。
本地跑通 CI 命令不等于远端 GitHub CI 已执行。

最终页面复验命令（在候选构建完成后，driver 自建私有测试环境）：

```sh
pnpm exec tsx scripts/acceptance/ui/p29-assistant-lifecycle-smoke.ts
```

本次开发中发现的测试夹具重复 seed、额度元组缺失、浏览器 locator/路径解析与 response body 等验收脚本失败均保留原件。
例如旧 `/tmp/allrice-met140-evidence-hcYQPw/` 在已收到 POST 202 后因 DevTools response.json 等待而失败；修正为核对真实提交身份/状态及独立权威 GET，不回写旧报告为通过。
后续独立复验采用全新目录，清理失败必须 `passed=false` 并保留未确认 owner 对应的资源，不用强删换取成功。
