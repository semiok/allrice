# P27 显式 Gemini priced-native 基础助手 smoke（受控子集）

本脚本只验收「真实父模型 → 两个有限子助手 → 两份平台发布的不可变小报告 → 父级持久采纳及汇总 → 全树 Token 账本、逐调用价格回执与适配器返回值对账」这一条基础助手路径。它直接使用生产 adapter/controller/数据库能力，不经过完整 Worker job 的路由与月额度流程。

**当前状态（2026-09-14）**：显式 Gemini priced-native 路径已完成无 provider 自测：105 个本地测试、2 个真实隔离 PostgreSQL 测试通过。本轮尚未调用真实 Google，也没有该路径的真实模型成功收据；必须先集成、审查、固定干净候选 SHA，再单独进行获授权的真实执行。脚本存在、预检退出 0、合成协议或 PG 测试通过，均不代表 P27、B6 或 GA 完成。

## 保留的历史事实与默认门禁

首次真实 Codex smoke 已在 `1507ff0` 失败，记录见 [B6 集成证据](./b6-integration-verification.md)。固定 SDK 的 Codex 请求未携带可验证的输出上限，因此默认 `openai-codex / gpt-5.6-luna / low / deployment:codex-default` 助手路由仍被生产能力门禁拒绝。

不传 `--provider` 仍选择 Codex，不会静默回退 Gemini。默认 `--preflight` 应报告 `providerEligibility.eligible=false`；即使提供正确 SHA 授权，默认 `--execute` 也在凭据元数据、DB、原生宿主及临时文件创建之前返回 `blocked_before_execution` 并退出 1。不得移除 gate、改环境变量或借普通聊天路径绕过。历史 Codex fixture 的无价格断言只保留作兼容回归，不是可执行路由许可。

新路径必须显式传入 `--provider=gemini`，固定为 `dsh / gemini / 3.8flash / low / deployment:gemini-default`，使用正常 AllRice credential resolver；不切换模型、不自动重试整场任务、不使用模拟 provider 冒充真实成功。

## 候选、安装与权限

执行前须集成 P25 生产接线，包括不可变 report publisher、provider 输出上限、价格选择与回执，再完成相关负例。根任务固定包含本脚本及价格 manifest 的完整 40 位 SHA，只在该 SHA 的干净工作树运行；结束再次检查 HEAD/工作树和实际安装入口，任何并发修改都会使证据失效。

依赖必须按该 SHA 的 `pnpm install --frozen-lockfile` 安装，并附同 SHA 的安装及 `pnpm dsh:verify` 收据。脚本记录 Node 版本/架构/平台，按原生 host 的 ESM parent URL 解析 **11 个关键安装入口**：

- `@deepseek-ai/dsh-app-boot`、`dsh-sdk-protocol`、`dsh-sdk-jsonrpc-server`、`dsh-tools`；
- `@deepseek-ai/dsh-subagent`、`dsh-subagent-spawn-in-process`、`dsh-session-persistence-jsonl`、`dsh-llm-pi-ai`；
- `@earendil-works/pi-ai` 及其 `providers/openai-codex`、`providers/google`。

逐项核对已装 package version 与 Worker metadata/lock importer 的精确 pin，记录实际入口及 package metadata 的哈希，结束再次比对。这里只解析并读取安装入口，不执行这些包或读取凭据；**入口哈希不是全部传递依赖的完整性证明**。另外记录锁文件、native/restricted 配置、controller、publisher、DSH distribution/upstream、P27 价格/fixture/outcome 及生产价格 contracts/database 等源码哈希。

真实执行必须同时满足：

- `ALLRICE_B6_P27_PROVIDER_AUTHORIZED=1`；
- `ALLRICE_B6_P27_AUTHORIZED_SHA` 精确等于候选 SHA；
- 对 Gemini 显式设置 `ALLRICE_B6_P27_AUTHORIZED_PROVIDER=gemini`。旧 Codex 授权不授权 Gemini 消费；
- 不继承 `DATABASE_URL` 或 `ALLRICE_TEST_DATABASE_URL`，不 source `.env`，不传入 API Key 原文。

### Gemini 凭据与新空 private platform home

操作人员通过 `ALLRICE_B6_P27_GEMINI_CREDENTIAL_FILE` 明确指定已获授权的既有 Dev 文件。允许 canonical path 为 `/Users/a123/allrice-dev/.local/` 的严格后代，或已确认的精确 Dev Worker 绑定 `/Users/a123/.config/allrice/dsh-credentials.dev.json`；后者不授权同目录其他文件，尤其不是 Prod 文件。

执行授权后只做元数据预检：当前用户、普通文件、原始路径非符号链接、单硬链接、私有权限、非空且不超过 64 KiB。脚本不搜索密钥、不手动读取或复制密钥内容，不创建 key、不把密钥放入 argv/证据；**之后实际 native 执行仍由产品正常 resolver 读取所选 Dev 文件**，因此不能把真实执行描述为“完全不读取凭据”。元数据预检也不宣称消除了预检到正常 resolver 读取之间所有文件系统竞态。

Gemini 每次创建本次独有的 mode `0700` 空 `platform` 目录，不复用已存在的 Codex home，不复制或预植入 `.credentials.yaml`。固定的 `credentials-local` 实现允许该文件缺失；新目录、环境白名单设置放在执行的 `try/finally` 内，初始化失败也进入本次资源清理。旧 Codex home 校验器仍保留但 Gemini 不调用；默认 Codex 门禁在到达它之前即拒绝。

数据库固定为本机专用 fixture 库 `postgres://a123@127.0.0.1:5432/allrice_b2`。只读确认 `vector`/`pg_trgm` 已安装，再复用 P25 fixture 创建器在随机 `p25_<32 hex>` schema 中迁移。新 fixture 从创建时冻结真实 provider、运行上限和隔离价格快照；不事后修改 immutable employee version，不预植宽松 runtime root，不写生产 model connection/catalog 价格，不修改公开租户、不清空共享表。

## 隔离价格 manifest 与 11 美分边界

`scripts/acceptance/runtime/p27-assistant-pricing.ts` 是**仅供本脚本使用**的显式、版本化 manifest，不是生产默认价或租户报价。基于根任务在 2026-09-14 核验的 [Google 官方 Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) 公开事实：Gemini 3.8 Flash Standard，USD 每百万输入 Token 0.75、输出（含 thinking）3.75、cache-read 0.075。

生产 selector 的目标使用新 fixture 随机生成的 `connectionId`、`catalogId`，精确绑定 `dsh / gemini / api_key / gemini-3.8-flash / https://generativelanguage.googleapis.com/v1beta / default / text`。`default` 表示请求没有另选 service tier；来源事实标为 Standard，并明确记录此映射，不把其他 endpoint/model/tier 自动映射到这张价表。

- `catalogVersion=p27-isolated-gemini-standard-20260914-v1`；
- `source.reference=google-gemini-3.8-flash-standard-20260914`；
- `source.digest` 绑定代码中明确的 JSON 来源事实，**不是网页 HTML 快照的哈希**；
- 有效期为 `2026-09-14T00:00:00.000Z`（含）至 `2026-10-01T00:00:00.000Z`（不含）。Gemini 预检及执行均拒绝过期 manifest；续期须重新核验、审查并固定新候选，不能临时改环境绕过。

本路径仅为文本/函数调用，不主动创建缓存、不使用 grounding、音频或视频。`cacheWrite` 桶使用 uncached-input 费率作为上述范围内的保守输入桶上界，**不是声称 Google 公布了相同的缓存写入或存储价格**。真实 provider 未报告缓存细分时仍保留 `cacheUsageKnown=false`，不把未知当零或声称精确缓存账单。

全树限制为 16 次模型调用、64 次工具调用、80,000 输入、12,000 输出、92,000 总 Token、180 秒。按这张表，对已准入且最终确认用量的 Token tariff 上界为 **10.5 美分**，设置 `maxCostCents=11`。生产 controller 检查共同根预算和此金额上界，并冻结价格、持久化逐调用回执。

**11 美分不是银行/Google 账单封顶保证，也不是完整 Worker 月额度验收。** 未报告的 provider/SDK 内部重试消费、非 Token 费用及实际账单不由此脚本证明。保持 `actualCostKnown=false`，计价基础为 `conservative_upper_bound`，没有汇率换算或订阅 Token 转现金收费。`adapter.execute` 恰好一次且没有外层任务重试；生产内部有限模型轮次和 provider 网络重试仍可能发生，不能把一次 execute 写成一次 HTTP 请求。

## 操作命令

以下均为模板，**不是本轮已执行的真实 provider 命令**。在候选干净工作树中，把 `P27_CANDIDATE_SHA` 设置为根任务固定的完整 40 位值。先做显式 Gemini 的无 provider、无 DB、无凭据元数据读取预检：

```sh
TSX_TSCONFIG_PATH=./tsconfig.base.json node --import tsx scripts/acceptance/runtime/p27-assistants.ts \
  --preflight --provider=gemini --candidate-sha="$P27_CANDIDATE_SHA"
```

检查 `providerEligibility`、`pricing` 的到期日/11 美分/fixture-only 标记，以及 11 个安装入口；这一步退出 0 仍不是模型验收。默认 Codex 门禁可独立预检，不会产生 Gemini fallback：

```sh
TSX_TSCONFIG_PATH=./tsconfig.base.json node --import tsx scripts/acceptance/runtime/p27-assistants.ts \
  --preflight --candidate-sha="$P27_CANDIDATE_SHA"
```

仅在根任务明确授权的一次执行中，`P27_AUTHORIZED_DEV_CREDENTIAL_FILE` 由操作人员填写已经确认的既有 Dev 文件路径，不猜测路径、不填写密钥原文：

```sh
env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" LANG=en_US.UTF-8 \
  ALLRICE_B6_P27_PROVIDER_AUTHORIZED=1 \
  ALLRICE_B6_P27_AUTHORIZED_SHA="$P27_CANDIDATE_SHA" \
  ALLRICE_B6_P27_AUTHORIZED_PROVIDER=gemini \
  ALLRICE_B6_P27_GEMINI_CREDENTIAL_FILE="$P27_AUTHORIZED_DEV_CREDENTIAL_FILE" \
  TSX_TSCONFIG_PATH=./tsconfig.base.json \
  node --import tsx scripts/acceptance/runtime/p27-assistants.ts \
  --execute --provider=gemini --candidate-sha="$P27_CANDIDATE_SHA"
```

不要给 Gemini 传入旧 `ALLRICE_DSH_PLATFORM_HOME`、`GEMINI_API_KEY` 或 credentials JSON。如既有 Dev 路由需要代理，只加入已确认的 `ALLRICE_DSH_HTTP_PROXY` / `ALLRICE_DSH_HTTPS_PROXY` / `ALLRICE_DSH_NO_PROXY`，不复制任意平台环境。脚本进一步白名单清理环境，关闭 Bridge、MCP、cloud runner、browser，只开启本路径需要的助手、Workbench、runtime policy 和 Gemini。

## 真实执行必须核对的断言

工具来自真实 `riceToolDefinitions` 和 `allRiceToolManifest`，严格 provider schema 由生产 native 实现注册。脚本不伪造模型回复、tool schema、子结果或 artifact UUID。父助手委派两个深度 1 的子助手，子权限仅 `assistant.report`，两者均提交名为 `report` 的不同不可变 JSON 对象。合成销售/收款输入须由真实子报告及父汇总同时得到 875 分销售额、600 分未收款。

必须得到三个真实 run、两个 completed 子结果且无 incomplete、父级真实 `parentAdoptedSeq`、消息 native ID/durable seq/adopted seq。通过生产 Workbench artifact 读取函数以正确 owner/session 重新打开并读取 immutable bytes，核对 checksum、组织/工作区/owner、child provenance、独立 namespace/object ID；这不是额外宣称 HTTP/UI 点击验收。平台保存模型输出不代表独立事实核验，产物保留 `independentlyVerified:false`。

Token 与价格对账缺一不可：

1. 全部 usage 行已结算、各预算 reserved 为 0；逐 metric 汇总等于 root spent，父与每个子均有正的真实模型用量。
2. 模型准入记录必须 dispatched 且 finished；每条调用与唯一不可变价格 receipt 的 call/run/request/snapshot 身份一致，数量等于模型调用账本。
3. 用冻结价格逐笔重算精确 picounits，汇总后只舍入一次；receipt 输入/输出 Token 总数必须等于独立的 root Token 账本，summary 必须逐字段匹配。
4. adapter 返回 `assistantStatus=completed`、`usageComplete=true`，输入/输出等于全树账本；`costEstimateAvailable=true`、金额/币种/价格 digest 匹配 summary，`costBasis=conservative_upper_bound`、`cacheUsageKnown=false`、`actualCostKnown=false`。缓存数值 0 只是带未知标记的占位，不是已确认用量。

未来仅在这些真实断言和清理均成功后，脚本才返回 `passed_priced_native_assistants_subset_only`。此状态名称特意不叫 P27 passed 或 production billing passed。

## 证据、失败诊断与清理

证据只写入新 `.local/p27-assistants-<UUID>/` 私有 append-only JSON：候选/源码/安装入口哈希、公开价格事实及 digest、fixture 身份、摘要/答案哈希、对象字节数、持久采纳序号、预算/价格安全汇总、断言与清理状态。不保留 raw thinking、完整模型答案、prompt payload、工具原始事件、凭据、泛化错误堆栈或原始 provider 响应。

错误诊断仅保留精确白名单 code/class、布尔 retryable、400–599 HTTP status 和固定正则类别。类别是线索，不是已证根因或自动重试权限。cause 最多 5 层，每层 code/message 最多扫描 4096 字符，不调用 getter/序列化 hook、不遍历 payload；未知代码不能只凭 `DSH_`/`p27_` 前缀进入证据。

原生 JSONL session 为证明 durable adoption 会在本次私有临时 runtime 目录短暂存在，可能含模型原生内容，不能冒充零落盘。它不复制到证据；确认本次启动的全部 native host 已关闭且 execute settle 后，只删除本次 private platform/runtime/work/storage 和随机 schema。artifact ID/hash 证明当时真实 reopen/readback，清理后不能再下载临时对象。

fixture 初始化失败也要求真实清理回执：不能因为 database 尚未赋值就认为 schema 没创建。helper DROP 后检查 `to_regnamespace`，关闭自己的具名 PG 连接，独立删除并确认自己创建的辅助 storage。任一 host/schema/storage/连接未确认清理时，报告 `cleanup_blocked`，分别指出残留/未知资源；已成功删除的目录不标为 retained，不允许宽泛 kill/rm。已有故障清理测试包括 mkdtemp、迁移读取失败及真实竞争 PG 锁阻挡 DROP，不等于本轮重新执行全部历史故障矩阵。

## 已执行的无 provider 验证（2026-09-14）

```sh
pnpm exec vitest run 'scripts/acceptance/runtime/p27-' --maxWorkers=1
env -u DATABASE_URL -u ALLRICE_TEST_DATABASE_URL ALLRICE_RUN_P27_FIXTURE_TEST=1 \
  pnpm exec vitest run scripts/acceptance/runtime/p27-assistant-fixture.test.ts --maxWorkers=1
pnpm exec eslint 'scripts/acceptance/runtime/p27-*.ts' --max-warnings=0
pnpm exec prettier --check 'scripts/acceptance/runtime/p27-*.ts'
```

- 本地测试 **105/105**（7 个文件，19:07:17，8.23 秒；2 个 PG 用例默认跳过）：预检/SHA/provider 授权、价格和 receipt 负例、adapter 全树返回值、元数据边界、空 private home/初始化失败清理、错误脱敏、owned native client 停止。owned-client 用例只启动受控 dummy 子进程，未启动真实 DSH provider。
- 显式开启的真实隔离 PostgreSQL 测试 **2/2**（19:08:04，5.99 秒）：Codex 历史无价 fixture 兼容准入；Gemini 从创建冻结价格，经真实 controller/admission/receipt/summary/finish 的两笔合成协议调用验证。后者核对 20 输入/4 输出 Token、`0.003000` 美分及未知缓存/非账单标记；**没有 native host、Google 请求或凭据解析**。
- 16 个 P27 TypeScript 文件及其传递依赖通过 TypeScript `createProgram` 检查，0 diagnostics；ESLint、Prettier、`git diff --check` 均通过。

这些结果是候选冻结前的实现验证，不是已绑定最终提交的真实 provider 成功。此前文档的初始 6/11/26 等局部测试数是历史阶段记录，本次以上面的完整 105 + 2 口径为准，不相加冒充新增实测。

仍不覆盖：完整 Worker model-connection 选择/月额度路径、实际供应商账单、P27 四条真实业务任务线、M/Intel 实际 Bridge、旧 Bridge/Session 恢复、正式签名/公证安装更新、取消/断连/跨租户/撤权/恶意预览/超预算完整负例、完整 P26 前端交付及 P28 release gate。其他证据须各自绑定最终候选并独立验收；证书缺失仍是正式分发的外部条件。**本次 priced-native 基础子集不代替这些门禁，尚未真实 Google 验收。**
