# 门禁：DSH 收敛（自写表和适配只减不增）

MET-210 第四道防回退门禁。用户 2026-10-27 同意加入，原则是“只有 allrice 必须做出判断的才要留，SaaS 底层躲不开的那种逻辑”。对应 AGENTS.md 第 0 节：只加门卫、账本、存储后端、租约，不造第二套状态机。

## 拦什么

`scripts/dsh-convergence-gate.baseline.ts` 是唯一的当前基线，初始盘点基于 main `5edb28d2`（2026-10-27）：

- `table`：执行全部迁移后，当前数据库 schema 里的所有 `allrice_native_*` 表；查询 PostgreSQL catalog，不扫描历史 SQL，也不混入并行测试的 schema。
- `patch`：`apps/worker/dsh/patch-ledger.json` 的全部 `patches[].id`。
- `private-interface`：`apps/worker/dsh/compatibility.json` 的全部 `privateInterfaces`，以 `id: upstreamInterface` 标识；同 id 换成另一个私有入口也算新增。

实际出现基线没有的项会失败；实际已删除但基线还留着也会失败，错误会列出类型、名称和更新方式。比较及登记校验是纯函数 `checkBaseline`，两步 CI 共用。

初始条目均写 `approvedBy: 'baseline 2026-10-27'`。`待删` 表示无法确认属于四类的存量，交主会话核定，不代表本 PR 删除它，也不把初始盘点当成新增批准。门禁管清单是否收敛；依据是否真实、是否扩大现有包装的语义，仍由独立复核判断。

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

先找 DSH 原生做法；确实必须由 AllRice 判断且属于四类，取得用户批准后，在同一个 PR 中加入实现与一条基线：

```ts
{
  kind: 'table', // 或 patch / private-interface
  id: 'allrice_native_example',
  category: '门卫', // 只能是门卫 / 账本 / 存储后端 / 租约
  basis: '写清 DSH 哪个公开接缝仍不能承担这项 SaaS 判断及原因。',
  approvedBy: 'YYYY-MM-DD 原话：“贴用户批准这项新增的原话。”',
  // approvedBy 也可写 YYYY-MM-DD https://linear.app/...#comment-...
}
```

缺字段或空白、无批准日期/出处、用 `待删` 登记新增都会失败。新增项不能冒用初始标记：门禁读取基准提交中的基线，只有在其中已带初始标记的同类同名项才能沿用；仅首次引入门禁、基准还没有此文件时允许初始化。删除后重新引入的项也要重新登记批准。基准文件按字符串字面量读取，不执行其中代码。

## 怎么删除

在移除适配或私有接口登记、或新增迁移真正删除表的同一个 PR 中，删除对应基线对象；不用新增依据或批准。不改写已经执行过的历史迁移，不保留已不存在的基线项，也不用把它改成“已删除”状态。

#622、#623、#624、#625 等并行工作可能改变这三份清单：**后合并的 PR 需要随之更新基线**，以合并后迁移的实际库及清单为准。
