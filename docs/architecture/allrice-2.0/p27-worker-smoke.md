# P27 完整 Worker 连续任务验收

这是 [priced-native 子集](./p27-basic-assistant-smoke.md) 之外的补充验收，不替代四条业务线、真实 UI、双架构 Bridge 或正式签名门禁。脚本为 `scripts/acceptance/runtime/p27-worker-smoke.ts`；实际执行结果必须另附候选 SHA 与收据，脚本存在不代表验收通过。

## 路径与边界

1. 仅在专用 `allrice_b2` 数据库中新建随机 schema，迁移并创建独立组织、员工、模型连接和策略。数据库全局连接必须实际解析到该 schema；不继承在线服务的 `DATABASE_URL`，不启动自动领取其他任务的 `worker/index`。
2. 通过生产 `upsertEmployeeModelPolicy → prepareEmployeeRunBinding → enqueueRun → claimNextJob → startClaimedJob` 准备任务，再调用真实 `executeEmployeeRun`。使用冻结的 Gemini 模型、显式价格、最小工具与真实租约心跳；不预植空冻结配置冒充 Worker 准备。
3. 首任务委派两个只允许 `assistant.report` 的助手，核对真实子报告、平台不可变工件、父采纳、算术结果、每次调用价格回执、根 Token 账本、Worker 返回值、route 与月账投影。
4. 只有首任务完整成功、job/Run 成功且组织用量和费用可知，才在同组织的新 Session 准备第二条普通算术聊天。它明确禁用助手，检查没有新助手根、真实选路、普通费用估算、月额度与后续准入。不伪造第一条成功来执行第二条。
5. 最多两次 Worker 执行，每个 job `maxAttempts=1`；首任务或核验失败不准备第二条，不重放旧 unknown 调用。内部合法模型轮次、网络重试与银行账单不是“最多两次执行”所能证明的边界。

## 费用与授权

沿用已核验、版本化、到期拒绝的 Gemini fixture 价格。第一条使用整树 Token tariff 上界和 `maxCostCents=11`；未知用量不当作零释放。它仍不是供应商账单硬封顶。

第二条普通聊天使用生产旧估算器，显式提供相同 USD 输入/输出价格，避免“缺价返回零”。普通路径没有助手逐调用价格回执，其缓存折扣与未报告重试不能声称已按保守上界对账。报告须保留 `legacy_post_result_estimator` 这一差异，不能把第二条的估算称作正式收费凭据。

本脚本使用独立授权，不接受旧单次 adapter 验收票据：

- `ALLRICE_B6_P27_WORKER_AUTHORIZED=1`；
- `ALLRICE_B6_P27_WORKER_AUTHORIZED_SHA` 为当前干净候选的完整 SHA；
- `ALLRICE_B6_P27_WORKER_AUTHORIZED_PROVIDER=gemini`；
- `ALLRICE_B6_P27_WORKER_MAX_EXECUTIONS=2`；
- `ALLRICE_B6_P27_WORKER_ORDINARY_ESTIMATE_ACK=1`；
- `ALLRICE_B6_P27_WORKER_GEMINI_CREDENTIAL_FILE` 指向已确认的精确 Dev 凭据文件，不填写 Key 原文。

执行入口须显式 `--execute --provider=gemini --candidate-sha=<SHA>`。`--preflight` 仅检查候选、安装 pin、价格与路由能力，不打开数据库或调用 provider，也不读取凭据元数据。

`TSX_TSCONFIG_PATH` 必须是本候选 `tsconfig.base.json` 的绝对路径，确保生产包别名和 fixture 共享同一个源码数据库实例。首次真实运行前须按候选执行 frozen-lockfile 安装和 `pnpm dsh:verify`。真实调用仅正常 resolver 读取经元数据确认的 Dev 文件；新建空私有 DSH home，不复制 Codex 凭据，不 source 服务环境，不改代理设置或在线租户开关。

## 清理与证据

先停止实际 native host、确认执行 Promise 已结束，再停心跳/事件刷新、记录白名单失败快照，最后关闭两个本次拥有的数据库连接池并清理隔离 schema、storage 与临时目录。初始化未完成也要保留真实 cleanup proof；不能因为 fixture 未赋值就假定没有资源。清理无法确认时保留准确的残留定位，不扩大删除范围。

证据仅含候选和安装入口哈希、实际 Run/调用/工件身份、账务摘要、白名单错误及清理结果。Worker 可能包含上游正文的 console 日志在此独立进程内只计数，不抄入收据；临时 native transcript 在确认宿主退出后清理。

对应独立数据库准备测试只证明真实准备、冻结、租约、准入及第二任务门禁，不调用模型。其中合成终态/费用正例明确只用于测试准备门禁，不能作为真实 provider 成功证据。纯授权、超时、租约与故障清理测试也不替代实际完整 Worker 收据。
