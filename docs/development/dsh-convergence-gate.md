# 门禁：DSH 收敛（自写表和适配只减不增）

MET-210 第四道防回退门禁。用户 2026-10-27 同意加入，原则是“只有 allrice 必须做出判断的才要留，SaaS 底层躲不开的那种逻辑”。对应 AGENTS.md 第 0 节：Agent 能力只加门卫、账本、存储后端、租约，不造第二套状态机；按同节“界面和业务工具照常做”，`patch` 适配项另允许“业务工具”类别。

## 拦什么

`scripts/dsh-convergence-gate.baseline.ts` 是唯一的当前基线，初始盘点基于 main `5edb28d2`（2026-10-27），按 2026-10-28 主会话首次复核处理决定补齐范围：

- `table`：执行全部迁移后，查询 PostgreSQL catalog 的当前 schema。`TABLE_PREFIXES` 是 `allrice_native_`、`allrice_assistant_`、`allrice_dsh_`；`EXACT_TABLE_NAMES` 只列 `allrice_brand_content_reminders`、`allrice_brand_native_reminder_targets` 两个确切表名，不扩成品牌宽前缀，不做全库闭世界。
- `patch`：`apps/worker/dsh/patch-ledger.json` 的全部 `patches[].id`。
- `private-interface`：`apps/worker/dsh/compatibility.json` 的全部 `privateInterfaces`，以 `id: upstreamInterface` 标识；同 id 换成另一个私有入口也算新增。清单内重复 id 直接报错，即使 adapter 或上游入口不同。

实际出现基线没有的项会失败；实际已删除但基线还留着也会失败，错误会列出类型、名称和更新方式。比较及登记校验是纯函数 `checkBaseline`，两步 CI 共用。

初始存量使用 `approvedBy: 'baseline 2026-10-27'`，本轮从待删改归业务工具的三项另记 `2026-10-28 任务说明：…`。`待删` 表示已有退役计划或尚待核定的存量，不代表本 PR 删除它，也不把初始盘点当成保留或新增批准。

当前共 34 张表（native 20、assistant 9、dsh 3、品牌提醒 2）、19 个适配项、1 个私有接口。助手九表按子智能体 v3 的 PR2b 标待删；once partitions/close proofs/journal、recurring journal 按定时 v2 的整组退役清单标待删。两张品牌提醒表的依据明确为“方案推荐删除，待用户确认”。现有 DSH 表按实际用途登记：运行实例与关闭观察为账本，技能内容/bundle 为存储后端。

基线引用的方案分别为 `~/allrice-dev/qa/met210-native-subagent/plan-v3-draft-astra.md` §2 和 `~/allrice-dev/qa/met210-schedule-converge/plan-v2-draft-astra.md` §1.2、§3、§4.2。执行删除仍须满足对应方案的前置及批准。

## 怎么跑

```bash
# JSON 清单 + 全部基线字段校验，不连接数据库
node --import tsx scripts/dsh-convergence-gate.ts --base <PR基准提交>

# 只读查询已经执行完全部迁移的数据库，不负责启动服务或迁移
DATABASE_URL=<已迁移库连接串> node --import tsx scripts/dsh-convergence-gate.ts --tables --base <PR基准提交>

pnpm exec vitest run scripts/dsh-convergence-gate.test.ts
# 先提交；由工具选 M5，不能用时自动回 M1
~/allrice-dev/bin/m5-test --db -- scripts/dsh-convergence-gate.integration.test.ts
```

未给 `--base` 时用与 `origin/main` 的合并基准，无法解析则失败；CI 明确传 PR 基准 SHA，推 main 时传推之前的 SHA。退出码：0 通过，1 清单或登记不符，2 参数、读取或连接错误。

CI 的 `validate` 紧接“正则判断用户原话”门禁检查 JSON 清单；`developer-bootstrap` 紧接 `pnpm db:setup`（内部已跑 `db:prepare` 的全部迁移）检查真实表，并运行隔离 schema 的数据库集成测试。普通 `pnpm test` 跑纯函数/CLI 单测，数据库集成测试必须有 `ALLRICE_RUN_DB_INTEGRATION=1` 才运行。

## 怎么登记新增

先找 DSH 原生做法；确实必须由 AllRice 判断且属于四类，取得用户批准后，在同一个 PR 中加入实现与一条基线。业务工具适配可归第五类，但只允许 `kind: 'patch'`，表和私有接口不能用这一类：

```ts
{
  kind: 'table', // 或 patch / private-interface
  id: 'allrice_native_example',
  category: '门卫', // 门卫 / 账本 / 存储后端 / 租约；patch 另可用业务工具
  basis: '写清 DSH 做不了的 SaaS 判断，或公开接缝上的业务工具依据。',
  approvedBy: 'YYYY-MM-DD 原话：“贴用户批准这项新增的原话。”',
  // approvedBy 格式为日期 + 非空出处：MET 评论链接、PR 链接、原话或任务说明均可。
}
```

缺字段或空白、无批准日期/出处、用 `待删` 登记新增都会失败。出处不限定 URL 格式或最少字数，其真实性由复核核对。新增项不能冒用初始标记：门禁读取基准提交中的基线，只有在其中已带初始标记的同类同名项才能沿用；仅首次引入门禁、基准还没有此文件时允许初始化。**从待删改为四类或业务工具，必须换成新的日期和出处，不能保留初始标记或原批准记录。** 删除后重新引入的项也要重新登记批准。基准文件按字符串字面量读取，不执行其中代码。

**新薄层表落地须在同一 PR 登记**。定时 v2 建议的 `allrice_dsh_kv/sessions/session_events/leases` 已落在前缀范围内；`allrice_schedule_receipts` 和子智能体 v3 PR3b 的镜像表如用范围外名字，落地时须同时补精确表名（或经决定的前缀）与基线。尚未建成的表不提前加入基线。

## 怎么删除

在移除适配或私有接口登记、或新增迁移真正删除表的同一个 PR 中，删除对应基线对象；不用新增依据或批准。不改写已经执行过的历史迁移，不保留已不存在的基线项，也不用把它改成“已删除”状态。

#622、#623、#624、#625 等并行工作可能改变这三份清单：**后合并的 PR 需要随之更新基线**，以合并后迁移的实际库及清单为准。

## 这道门禁管不到的

绿灯说明上述三份清单与登记格式一致，不能证明没有第二套状态机。首次复核剩余事项按主会话 2026-10-28 决定记录后续，本 PR 不扩展实现：

- **表名之外的状态**：其他前缀、其他 schema、旧表新增列或 JSON 中的生命周期不在检查内；不做全库闭世界，也不做字段语义扫描。新薄层表的同 PR 登记义务仍须复核落实。
- **适配自报清单**：只看 ledger id，未登记的 `apps/worker/dsh/` 文件、公开接缝包装和旧 id 下的语义扩张不会被发现。后续先定义哪些文件/接缝必须登记，再考虑文件→ledger 的闭世界检查及 ADR 补齐；本次由复核按 AGENTS.md §0 判断。
- **计算式私有导入**：`dsh:verify` 补位扫描普通字面量 import，但 `import(variable)` 等计算式入口可能漏检；不能据此宣称所有私有接口均被发现。
- **批准与语义**：category/basis/approvedBy 格式合格不代表分类、依据或批准真实，须独立复核。缩减型适配改版换 id 仍算新增，可引用已有 MET-210 收敛决定的日期及出处，不要求为格式编造新原话。
- **并行 PR 和陈旧绿灯**：门禁只检查本次运行的合并结果。基线文本冲突由 Git 处理；main 更新后未重跑的旧绿灯要靠分支保护要求分支更新，仓库设置留后续，不由本脚本保证。
- **测试证据缺口**：现有集成测试在随机 schema 跑全部迁移并核对 catalog，但尚未专门构造跨 schema 重名表验证隔离；不能拿 Set 去重后的通过当隔离断言。真实删除已登记表、并行合并状态的专门回归夹具也留后续。
- **维护细节**：迁移循环与其他集成测试重复，之后再抽共用 helper；GitHub annotation 留后续，当前以带条目和改法的失败日志报告。
