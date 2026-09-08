# P19：真实 DSH / 模型对账验收

本项与 `b4-cloud-workbench.ts` 的浏览器、HTTP、数据库验收分开记录。确定性测试、真实模型业务执行、前端离线渲染、最终集成版本完整验收是不同证据层级，不能互相替代。

## 验收脚本及边界

`scripts/acceptance/runtime/b4-dsh-reconciliation.ts` 只创建 `allrice_b2` 内的随机 schema、合成用户/租户/Session/Run、两份测试 CSV 和独立私有存储目录。使用实际 `DshHarnessAdapter`、既有 DSH Harness、生产 Tool Broker、PostgreSQL 精确审批、专属 `allrice-cloud-b4` gVisor 后端及 ExcelJS；不另建 Agent Loop、不 mock 模型、不操控真实租户或 Bridge。

脚本要求显式 `ALLRICE_B4_DSH_AUTHORIZED=1`，拒绝继承部署数据库 URL。代码可以位于独立审查 worktree，但凭证目录经 `realpath` 后只能位于已授权的 `/Users/a123/allrice-dev/.local/` 内，凭证文件须由当前用户持有、无组/其他用户权限。由既有 DSH 凭证服务读取，不打印、复制、写入测试目录或传入容器。脚本不执行登录、解锁、换账号或刷新。

一次 `adapter.execute` 最长 180 秒；事件守卫最多 16 次工具调用，外部 Broker 最多 12 次。同一个真实模型 Run 应完成：

1. 原生 Ask User 澄清币种/重复处理；合成用户通过原生 typed input 回答，必须取得 `adopted / question_resolved` 回执。
2. 模型自行通过 `workspace.skill.read` 读取该 Run 初始冻结的规则和脚本。只在创建 Run 时写入快照，不更新不可变字段或关闭数据库触发器。
3. 模型使用 `cloud.process.execute` 的 `frozenScript` 引用。服务器从当前持久化 Run 的冻结 bundle 还原原始脚本字节；测试驱动核对完整脚本、两份精确 object ID/checksum、输出路径，确认审批前没有容器，才通过真实数据库审批 API 以合成用户提交批准。问答不等于审批。
4. 生产 Broker/Runner 执行，模型再调用 `workspace.reconciliation.export`。验收不替模型补工具调用、不伪造结果、不替换脚本。
5. 读取权威工件，先保留真实 XLSX，再重新打开，独立核对金额总计、5 个对象明细和 3 条人工核查问题；确认容器已销毁，核验租户作用域内的 Tool Broker 审计。
6. `rendered-download-link.ts` 使用实际 ChatFlow `AssistantMarkdown` 渲染原始回答，并在独立无个人 Profile 的 Chrome 中验证真实 anchor、完整 pathname/object ID/query 和点击目标。预期值来自本次真实 export 返回值，不仅判断 UUID 包含关系。全部浏览器请求在本地拦截，不请求 Dev/Prod 或外站；此步骤验证链接语义，不冒称真实服务器下载。真实 HTTP 下载另由 `b4-cloud-workbench.ts` 覆盖。

脚本按阶段追加只写一次的私有 JSON：初始化、澄清采纳、精确审批、每次 Broker 完成、模型完成、工件字节保存、XLSX 逐 cell 核对、容器销毁、审计和渲染链接。后续断言失败不会抹去先前阶段。报告仅记录限量公开回答/安全事件元数据；已知原生工具诊断只保留脚本长度和 hash、合成输入引用、限制与 schema 错误 code/path，不保留原始推理、完整脚本或 provider 原始响应。

结束后逐项、相互独立清理该随机 schema、测试存储和运行目录，保留阶段报告及已读取的 XLSX。每阶段清理等待上限 20 秒，任何失败均令最终结果失败；等待超时并不声称能够强制终止底层 Promise。最终小型本地报告写入不参与超时 race，只有实际完成写入后才输出成功回执，避免超时后迟到的文件带有 `passed: true`。验收需要同时核对最终报告及进程成功退出，不能仅以中间阶段报告判定整链成功。

## 真实验收推动的产品修正

- 原生工具接线：三个工具原先仍是 envelope 传输，模型没有稳定进入生产 Broker。补充严格参数 schema 的 `cloud_process_execute`、`workspace_skill_read`、`workspace_reconciliation_export`，并以实际 pinned DSH 子进程、JSON-RPC 和合成 SSE provider 验证参数 roundtrip。此输送层测试不冒充真实模型业务测试。
- 原生错误投影：DSH 的失败位于工具结果内容的 `isError`；仅检查旧 `data.error` 会将失败显示为完成。适配器已补实际事件结构的失败投影和回归，由 P15 公共接线承载。
- 冻结脚本引用：一轮实际模型将 5,982 字节脚本复制为 5,981 字节，丢失末尾换行。精确审批正确拒绝，未执行容器。P19 增加 `frozenScript: { skill, path }`，不让模型搬运脚本正文；旧 inline 路径继续兼容。服务器检查当前 tenant/workspace/owner/session/run、冻结的 read/execute 权限、Skill 所需工具、固定 Node runtime 依赖、bundle/resource 实际 hash、脚本目录/媒体类型及严格 UTF-8。`ignoreBOM: true` 保留 BOM 和末尾换行原字节；随后仍交原有完整脚本 hash 精确审批，没有 trim 或容错 hash。
- 对账脚本原始字节未改：`sha256:c747a90c5bae56e8712e57e84f6a09d25dda4af8c32616d69927983830a27449`。Skill 正文新增引用用法，正文/目录/bundle hash 已按现有规范重算。

## 2026-09-08 当前证据层级

| 证据                                         | 结果和边界                                                                                                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FrozenScript 权威与失败路径，真实 PostgreSQL | 15/15，包括跨租户/owner/Run/session、未冻结资源、缺 read 权限、篡改 bundle、媒体类型、运行依赖、BOM/末尾换行和非法 UTF-8                                                                      |
| DSH 原生传输                                 | 三个原生工具及 frozenScript 引用的 roundtrip 通过；非法参数不得进入 Broker                                                                                                                    |
| 原 fixture 默认兼容                          | cloud execution 11/11、reconciliation cloud 3/3，独占 VM 串行执行，真实 PostgreSQL + gVisor + XLSX                                                                                            |
| 最新真实模型 Run                             | 同一 `openai-codex / gpt-5.6-luna`、low，35,306 ms；1 次原生澄清采纳、2 次 frozen resource read、1 次精确批准的 cloud execute、1 次真实 XLSX export；所有逐 cell 和容器销毁断言先于失败点完成 |
| 该 Run 的最终脚本状态                        | **原报告仍为 `passed: false`**：旧版脚本将 Markdown 中合法的 `\/` 与原 URL 做 raw-string 比较，末尾链接断言失败；清理错误 0                                                                   |
| 离线实际前端复核                             | 同一公开回答经实际 renderer、独立 Chrome 得到正确完整 anchor 并点击；错误 object ID、路径、query 三个反例均拒绝。原始回答不能 raw-string 匹配 URL，但实际链接语义有效                         |
| 最终集成 SHA 的完整验收                      | **待主代理统一安排一次 bounded 重验**；不追溯修改旧失败报告，不因离线复核改称已完成最终端到端验收                                                                                             |

该次真实模型的数值核对：发票/回款各 6 行，发票 36,049 分、有效回款 34,550 分、分配回款 34,050 分、未分配 500 分、差额 1,999 分。5 个对象明细、重复发票/未分配回款/重复回款 3 条问题均逐 cell 比对，不只检查行数。

**旧证据的保留局限：** 最新 Run 执行时，XLSX 保存、export 返回元数据和审计查询尚位于错误链接断言之后。因此原报告虽证明工具调用已完成，并可结合固定脚本控制流确认 XLSX 逐 cell 检查和容器销毁已通过，但没有保留原 XLSX 字节和独立的权威 export 下载 URL；审计查询未运行。离线复核预期 URL 来自公开回答及生产导出格式，证明 renderer/click 语义，不能独立补证文件身份或已完成审计。分阶段保存和真实 export URL 比对是为最终重验补齐证据，不能倒填成旧 Run 的证据。

本机私有证据目录：系统临时目录 `allrice-b4-dsh-2goLCR/`，内含原 `result.json`（SHA-256 `c0489b7574c3ec7250c8aca18e4cc0b826240b33b973b2d52a9f367c42da7d17`）和 `renderer-replay-utf8.json`。没有新模型调用参与离线复核，原报告未被更改。

## 整合 SHA 924ed7e 的单次模型结果与验收脚本补正

2026-09-08 19:16–19:17，在只读冻结的 `924ed7e664566ac9e222ad5455a088dfff162f67` 整合树执行一次真实模型验收，开始和结束均确认 tracked tree 干净，没有循环重试。

- 44,952 ms 内完成 1 次澄清采纳、2 次资源读取、1 次独立精确审批的云计算和 1 次真实 XLSX 导出。11 个分阶段报告保留到 `sandbox_destroyed`，XLSX 全部 cell 校验通过。
- 真实 XLSX 已保存，8,903 字节，SHA-256 `15b61433558441edb3c159162506169b51aca9e5c0e6a43d5b5fb4a217a85b3d`。报告同时保留权威 export 返回的工件 ID、object ID 和完整下载 URL。
- **该次原报告依然为 `passed: false`**：验收脚本的审计排序使用了不存在的 `created_at`；实际表定义为 `occurred_at`，PostgreSQL 错误码 `42703`。业务执行未失败，但本 Run 的审计查询未验证，清理错误 0；不把后续离线补证写成整链成功。
- 无新增模型请求的离线补证，直接读取此次保存的真实 XLSX，再核对 checksum 和所有 cell；使用此次真实 export 的下载 URL/object ID，实际前端 renderer 与独立 Chrome 完整 href/路径/query/点击均通过。这次预期 URL 不再从公开回答推断。

私有证据为系统临时目录 `allrice-b4-dsh-1sscQk/` 内的 `result.json`、`reconciliation.xlsx`、11 个阶段报告及 `offline-final-replay.json`。原报告 SHA-256 为 `ae105c7cdd52d73f9209d2feb0f84ab46b7391d1e4ee299800069f081f7948d3`。私有启动器旁的 `final-launch-result.json` 记录完整源 SHA、脚本 hash、退出码及证据位置。

为避免再用模型发现测试 SQL 笔误，已提取 `reconciliation-audit.ts`：

1. 模型调用前，在已迁移的真实随机 schema 执行同一审计查询，要求当前合成执行的审计为空；SQL 字段错误会在花费模型预算之前失败。
2. 模型结束后，严格按 organization/workspace/actor 和 `metadata.runId`、`metadata.executionId` 过滤，使用 `occurred_at` 排序；逐项核对 `tool.execute / tool_broker / allowed` 及每次实际成功 Broker 调用的工具名称和数量。只投影安全字段，不导出整个 metadata。
3. 最后消息写入也复用测试覆盖的作用域 SQL：organization/workspace/session/owner、assistant role、明确 message ID，并要求该 message 是当前 Run 持久化记录绑定的 assistant message，`RETURNING` 恰好一行。
4. 额外核对 `artifact.object.id === finalExport.objectId`、工件当前 Run/Session/租户/owner 归属和实际文件 hash，确保逐 cell 核对的文件就是最终链接所指的工件。

`reconciliation-audit.integration.test.ts` 在真实 PostgreSQL、实际 `recordToolBrokerAudit` 写入结构下 **5/5 通过**，不使用模型或 VM。覆盖原 SQL 错误码的精确复现、空查询 preflight、4 条正确工具审计、跨五个作用域的查询/邻居记录排除、缺失/重复/拒绝审计，以及最后消息写入的正反作用域和 user role 拒绝。此补正之后，完整模型验收仍需由主代理在重新整合的固定版本统一安排。

## 早期失败与处理记录

初期真实 DSH 返回 `DSH_PI_AI_ERROR`，安全诊断为 `Provided authentication token is expired.`。这是远端拒绝，并不证明本地过期字段已经到期；后台 `connected` 也不能代替真实 token 可用性验证。主代理按已授权的同一个 Dev 账号完成原生刷新后恢复模型测试，没有切换账号或另行登录。

第一次并行运行两个云集成文件出现 6 个 `unknown`，原 schema 随生命周期清理，没有足够证据断言根因。相同代码逐文件和 `--no-file-parallelism` 重跑均 14/14。共享 VM 瞬态资源/attestation 竞争只是待验证假设；没有放宽 preflight、租约或 fail-closed。实机验收应独占专属 VM、串行执行。

## 复现方式

静态验证：

```sh
pnpm exec eslint scripts/acceptance/runtime/b4-dsh-reconciliation.ts scripts/acceptance/runtime/rendered-download-link.ts
pnpm exec tsc --project .local/p19-dsh-acceptance.3nmlkC/tsconfig.json --noEmit
```

当前工作机的私有启动器为 `.local/p19-dsh-acceptance.3nmlkC/launch.mjs`，经 `.local/b3-deploy.H3jwWE/common.mjs` 的 `devEnv` 读取指定已授权 Dev 发布配置，仅透传平台 home 和已有代理参数；不 source `.env`，不读取默认 Prod。它不是跨机器部署脚本。启动器可以指向审查/集成 worktree 中的脚本，凭证目录仍限定到上述唯一 Dev 工作区。模型重验须由主代理确认集成版本和 VM 独占窗口后运行，不循环重试。

```sh
node .local/p19-dsh-acceptance.3nmlkC/launch.mjs

env ALLRICE_RUN_CLOUD_INTEGRATION=1 node .local/b4-execution.u9W4Zo/test-db.mjs \
  packages/database/src/cloud-execution.integration.test.ts \
  packages/database/src/reconciliation-cloud.integration.test.ts \
  --no-file-parallelism
```

本页不表示已发布 Dev、已启用真实租户或达到 GA。
