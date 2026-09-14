# P27 基础助手真实 provider smoke（受控子集）

本脚本只覆盖「真实父模型 → 两个有限子助手 → 两份平台发布的不可变小报告 → 父级持久采纳及汇总 → 全树预算账本」这一条基础助手路径。脚本编写、静态检查或合成 PostgreSQL 准入测试不等于真实 provider 验收通过，更不代表 P27、B6 或 GA 完成。

**当前阻断（2026-09-14）**：首次真实 Codex smoke 已在 `1507ff0` 失败，记录见 [B6 集成证据](./b6-integration-verification.md)。固定 SDK 的 Codex 请求未携带可验证的输出上限，因此本脚本的固定 Codex 助手路由目前被生产能力门禁拒绝。`--preflight` 仍可核对源码和安装清单，但必须同时报告 `providerEligibility.eligible=false`，不能将预检退出 0 当作执行许可。即使提供 SHA 绑定授权，`--execute` 也在凭据元数据、DB、原生宿主和临时文件创建之前返回 `blocked_before_execution` / 退出 1。不得以环境变量、换成普通聊天路径或移除 gate 绕过。Gemini 的独立合成 HTTP 协议证据不把本脚本静默切换为 Gemini，也不构成真实模型通过。

## 前置条件与权限

必须先由根任务集成 P25 `assistant_report.output` 生产接线及数据库 publisher，完成相关负例，并固定一个包含本脚本的完整 40 位候选 SHA。只允许在该 SHA 的干净工作树运行。最终再检查一次 HEAD 和工作树；并发修改使证据失效。锁文件、原生助手实现、restricted 配置、controller 和 publisher 的源码哈希也进入报告。

依赖须按该 SHA 的 `pnpm install --frozen-lockfile` 安装。预检记录实际 Node 版本/架构/平台；以原生 host 的 ESM parent URL 解析 10 个关键 DSH/pi-ai 入口（包括 Codex provider），只读核对 installed package version 与 worker metadata/lock importer 的精确 pin，并记录实际入口及 package metadata 的哈希，结束时再比对不变。它不执行这些包，不读取凭据；入口哈希不等于全部传递依赖的完整性证明。DSH distribution/upstream 清单哈希同时记录，仍应附同 SHA 的安装及 `pnpm dsh:verify` 收据。

真实调用必须另获显式授权；本次交付不调用 provider，也不读取密钥。脚本 `--execute` 要求 `ALLRICE_B6_P27_PROVIDER_AUTHORIZED=1` 和 `ALLRICE_B6_P27_AUTHORIZED_SHA` 精确等于候选 SHA。仅使用既有获授权 Dev 的 `openai-codex / gpt-5.6-luna / low / deployment:codex-default` 路由；不搜索、读取、复制或向子 argv 写入凭据，不创建新 key，不修改已装 App 或 Bridge 配置。

`ALLRICE_DSH_PLATFORM_HOME` 必须由操作人员给出，`realpath` 后严格位于 `/Users/a123/allrice-dev/.local/` 下。只检查 `.credentials.yaml` 的元数据（当前用户、私有权限、普通文件、非符号链接、单硬链接）。真实 native provider 服务仍按产品正常流程使用既有订阅凭据，可能执行原有 OAuth 刷新；不授权脚本手动改写凭据。

拒绝继承 `DATABASE_URL` 或 `ALLRICE_TEST_DATABASE_URL`。数据库固定为本机专用 fixture 库 `postgres://a123@127.0.0.1:5432/allrice_b2`；执行前只读确认 `vector`/`pg_trgm` 已安装。复用 P25 fixture 数据库创建器，在随机 `p25_<32 hex>` schema 内执行迁移；不修改公开租户，不清空共享表，不进行全库 cleanup。P27 fixture 从创建时就冻结真实路由，不事后改 immutable employee version，也不预植入宽松 runtime root。

## 命令

先运行无 provider、无 DB、无凭据元数据读取的源码/候选预检（SHA 必须替换为根任务固定的实际值）：

```sh
TSX_TSCONFIG_PATH=./tsconfig.base.json node --import tsx scripts/acceptance/runtime/p27-assistants.ts \
  --preflight --candidate-sha=<full-candidate-sha>
```

仅在根任务之后明确授权的一次真实执行中，使用干净环境启动，不 source `.env`。`AUTHORIZED_PLATFORM_HOME` 代表操作人员已确认的既有 Dev 目录，不能用示例值猜测路径。以下是操作模板，**不是本轮已执行的命令**：

```sh
env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" LANG=en_US.UTF-8 \
  ALLRICE_DSH_PLATFORM_HOME="$AUTHORIZED_PLATFORM_HOME" \
  ALLRICE_B6_P27_PROVIDER_AUTHORIZED=1 \
  ALLRICE_B6_P27_AUTHORIZED_SHA="$P27_CANDIDATE_SHA" \
  TSX_TSCONFIG_PATH=./tsconfig.base.json \
  node --import tsx scripts/acceptance/runtime/p27-assistants.ts \
  --execute --candidate-sha="$P27_CANDIDATE_SHA"
```

如既有 Dev 路由需要代理，只加入已确认的 `ALLRICE_DSH_HTTP_PROXY` / `ALLRICE_DSH_HTTPS_PROXY` / `ALLRICE_DSH_NO_PROXY`，不要复制任意平台环境。脚本进一步白名单清理环境，关闭 Bridge、MCP、cloud runner、browser；仅开启本路径需要的助手、Workbench、runtime policy。

没有外层重试或轮询模型执行：`adapter.execute` 恰好一次，180 秒 deadline 到达即 abort，并进入受控 native host 关闭。生产运行时内部有限模型轮次和 provider 自带网络重试仍可能发生，不能把“一次 execute”写成“一次 HTTP 请求”。全树生产预算为 16 次模型调用、64 次工具调用、80,000 输入 token、12,000 输出 token、92,000 总 token；输入预留使用生产保守估算，最终核对真实回传用量。未绑定权威价格，`maxCostCents:null`；报告不能宣称美元费用或已验证费用上限。

## 实际断言与证据边界

工具来自真实 `riceToolDefinitions` 和 `allRiceToolManifest`；严格 provider schema 由生产 `allrice-assistant-runtime.mjs` 注册，不在 smoke 中伪造 tool schema、模型回复、子结果或 artifact UUID。父助手委派两个最大深度 1 的子助手，子权限仅为 `assistant.report`，两者均输出名为 `report` 的不同不可变 JSON 对象。纯合成销售/收款计算为 875 分销售额和 600 分未收款，必须由真实报告及父汇总同时匹配。

断言包含：三个真实 run、两个 completed 子结果、报告没有 incomplete、父级两条非空 `parentAdoptedSeq`、消息真实 native ID / durable seq / adopted seq；以真实 owner/session 通过 Workbench API 重新打开并读回 immutable bytes，检查 checksum、组织/工作区/owner、child provenance、独立 namespace/object ID；所有 usage 行已结算、所有预算 reserved 为 0，按 metric 汇总逐项等于 root spent，父和每个子都有正的真实模型用量。平台保存模型输出不证明其事实已由第三方核验，产物须保留 `independentlyVerified:false`。

适配器的公开返回值也必须与 PG 全树账本逐项相等，不能只验证数据库而漏掉父级返回值少算子用量的回归：`assistantStatus=completed`、`usageComplete=true`、输入/输出总量等于对应 budget spent。当前全树接口的 `cacheUsageKnown=false`、`costEstimateAvailable=false` 必须明确保留；缓存数值 0 只是带未知标记的占位，不是已确认的缓存用量，也不推出零成本。这些安全字段及数字进入报告，不保留完整答案。

证据仅写入新建 `.local/p27-assistants-<UUID>/` 的私有 append-only JSON：候选及源码哈希、标识、摘要/答案哈希、对象字节数、断言、持久采纳序号、预算与用量、清理状态。绝不记录 raw thinking、模型完整答案、prompt payload、工具原始事件、凭据或泛化 error stack。错误仅保留下面定义的白名单标量；provider 原始错误不进入报告。

失败诊断另外保留精确白名单 error code/class、布尔 retryable、400–599 HTTP status 及固定正则匹配的类别（认证、限流、模型不可用、严格工具 schema、previous-response/state、native authority、预算等）。类别只是线索，不能作为已证根因或自动重试授权。cause 最多 5 层，每层 code/message 只扫描前 4096 字符；不调用 getter/序列化 hook，不遍历 payload，不写入任何原文、堆栈、响应正文、headers 或凭据。超长或未知代码不能凭 `DSH_` / `p27_` 前缀进入报告。

生产 JSONL native session 为证明真正 durable adoption 会在独立私有临时 runtime 目录短暂存在；其中可能包含模型原生内容，不能冒充零落盘。这些内容不被复制到证据，在确认本脚本启动的 host 已退出后，删除仅本次私有 runtime/work/storage 和随机 schema。报告中的 artifact ID/hash 证明本次实际 reopen/readback；清理后不能再下载该临时对象。若 host 停止或 schema 清理不确认，则标记 `cleanup_blocked` 并保留新建私有目录供人工诊断，不能宣称全部清理，更不能宽泛 kill/rm。

fixture 初始化失败同样需要真实清理回执，不能因 `database` 未赋值就认为 schema 未创建。helper 对随机 schema 的 DROP 后读取 `to_regnamespace` 确认消失；关闭自己具名的 PG 连接，并独立删除/确认自己的辅助 storage 目录。未确认的 DROP、目录创建或连接关闭保持 false，P27 标记 `cleanup_blocked` 并分别指出残留/未知资源；已成功删除的目录不标作 retained。故障测试覆盖 mkdtemp 失败、迁移读取失败及真实竞争 PG 锁阻挡 DROP，均只使用本次新建资源。

## 无 provider 自测（初始脚本记录；后续实际结果见集成证据）

```sh
pnpm exec vitest run --maxWorkers=1 scripts/acceptance/runtime/p27-assistant-preflight.test.ts scripts/acceptance/runtime/p27-assistant-outcome.test.ts scripts/acceptance/runtime/p27-error-diagnostics.test.ts scripts/acceptance/runtime/p27-owned-clients.test.ts
env -u DATABASE_URL -u ALLRICE_TEST_DATABASE_URL ALLRICE_RUN_P27_FIXTURE_TEST=1 \
  pnpm exec vitest run --maxWorkers=1 scripts/acceptance/runtime/p27-assistant-fixture.test.ts
env -u DATABASE_URL ALLRICE_RUN_DB_INTEGRATION=1 \
  ALLRICE_TEST_DATABASE_URL=postgres://a123@127.0.0.1:5432/allrice_b2 \
  pnpm exec vitest run --maxWorkers=1 packages/database/src/assistant-runtime.fixture.integration.test.ts
```

第二条仅在含 P25 接线的源码环境运行：合成随机 PG schema、真实 controller/authority 准入、真实零使用预算初始化；不启动 native host，不解析凭据，不调用模型。它不是 provider smoke 的替代。

本次自测：6 个 preflight、11 个 whole-tree outcome 和 2 个真实 dummy 子进程停止测试通过；dummy 不回应 initialize 的场景证明不能把空 pool inventory 当作 host 已退出，必须由 initialize 入场登记全部 owned client、等待 execute settle 和真实 close 事件，再清理。正常合成 PG 准入 1/1、真实 PG 故障清理 3/3 通过；database 与脚本 TypeScript 检查均为 0 diagnostics，ESLint 通过。未执行 `--execute`，没有真实 provider 成功收据。

安全诊断增补：26 个纯测试覆盖所有分类、精确代码拒绝、HTTP/boolean 类型、长载荷、嵌套/循环 cause、getter/toJSON/live Proxy 零调用；与 preflight/outcome 合并 43/43 通过，未调用 provider。

仍未由本脚本覆盖：P27 四条真实业务任务线、M/Intel 实际 Bridge、旧 Bridge/Session 恢复、正式 Developer ID 签名/公证安装更新、取消/断连/跨租户/撤权/恶意预览/超预算负例、完整 P26 前端交付和 P28 release gate。已有其他证据需各自绑定同一最终候选并独立验收；证书缺失仍是正式分发验收的外部阻断项。
