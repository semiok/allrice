# P28 / MET-141：发布候选、迁移与兼容恢复准备

2026-09-14。状态：**可审查的准备切片，不是 B6 / RC / GA 验收通过，不是发布授权。**

依据：[MET-105 §7](https://linear.app/metasnowsky/issue/MET-105)、[MET-106-C](https://linear.app/metasnowsky/issue/MET-106)、[MET-107](https://linear.app/metasnowsky/issue/MET-107)、[MET-108](https://linear.app/metasnowsky/issue/MET-108) 与唯一[执行总表 v1.27 P27/P28](https://linear.app/metasnowsky/document/allrice-20-执行总表阶段依赖pr-与验收门禁-df09b0b1e681)。本页不建立第二份排期；P28 准备先供 P27 / MET-142 联验。Codex 自主设计、自审、自测；Gemini 不作为研发门禁。

代码基线是完整 SHA `57f3b5fd2acba034e9011231075c3e29b4503733`。[B5 集成记录](b5-integration-verification.md)、[验收设计](acceptance.md)及[ADR](decisions.md)是历史与规则，不能替代最终 B6 SHA 的真实证据。B5 BUILD_ID `YmBpsav9R6_mfJmIob03N` 和 `0.5.0-dev.1` ad-hoc 包不是正式签名候选。

## 1. 本切片交付与仍然受阻的内容

交付：[草稿清单](p28-release-manifest.draft.json)、[只读检查器](../../../scripts/acceptance/platform/p28-release-readiness.mjs)、[检查器测试](../../../scripts/acceptance/platform/p28-release-readiness.test.mjs)及本程序。没有改应用开关、数据库、包分发、系统服务或现有共享验收入口，也没有备份数据库、扫描秘密、合并或部署。

草稿有意保留 `sourceSha: null`、空包/证据、空发布授权与真实 blockers，**运行必定拒绝**；不可把基线 SHA、虚构 SHA 或测试夹具填进去变成发布材料。准备代码本身不等待证书；已固定候选的材料检查允许 `prepare` 成立而 `technicalEvidenceComplete: false`，证书/设备缺口仍阻断 RC。

外部依赖必须尽早解决：P14 需要可用 Developer ID 发布者身份、公证权限、已固定的更新元数据验证公钥，以及各一台可实际交互的 Apple Silicon / Intel Mac。两台均要从最终实际包进行 Keychain、Finder/原生 GUI、签名拒绝、任务排空、升级中断、兼容恢复测试。构建两包、ad-hoc 签名、哈希一致、模拟 Keychain 或仅一台设备不等于两平台通过。不索取/提交私钥、密码、公证令牌或真实配对凭证；缺少条件填未验证。

当前草稿另缺最终集成 SHA、最终 Web/Worker/客户端构建、0093 等最终迁移清单、P27 实测收据及批准的真实发布范围。P25/P26/P14 交付与 P27 验收由对应切片负责；P28 的测试通过不替它们签字。

## 2. 固定版本与证据包

由 P27 从实际候选构建/运行结果整理一个**专用、脱敏、只读、无符号链接**的 evidence staging 目录。不要把用户主目录、源码根目录或 `.env`/凭证目录作为证据根。仅复制本次批准保留的报告、观察与分发产物；检查器不收集这些材料。

清单 `schema: allrice-p28-release/v1` 的字段由检查器严格定义，缺失/额外字段拒绝。`artifacts` 恰含七个 ID：

| ID | 固定的真实文件及身份 |
| --- | --- |
| `source` | 最终候选干净源码归档；完整 Git SHA、归档 SHA-256/字节数、归档生成标识 |
| `lockfile` | 此源码的实际 `pnpm-lock.yaml` 字节 |
| `dsh-upstream` | 此源码的 `apps/worker/dsh/upstream.json`；固定 DSH 版本/commit/tree/archive 摘要保留在原文件 |
| `web` | 实际部署的 Web 分发归档/镜像导出；准确 Next `BUILD_ID`，不是笼统 `pnpm build` 成功 |
| `worker` | 实际 Worker 分发归档/镜像导出及不可变构建标识 |
| `bridge-arm64` / `bridge-x64` | 对应最终下载包的全量字节；同一 Bridge 版本，各自构建 ID；来源 SHA 必须一致 |

每项格式是 `{id, sourceSha, version, buildId, file: {path, sha256, bytes}}`。所有路径相对 evidence 根；每包必须有独立路径，不能用一个文本/探针重复充当 Web、Worker、GUI 包。`source-build-package-provenance` 实测收据及其原始构建记录负责把干净 checkout → 归档 → 实际构建 → 下载字节联系起来。检查器对提供的 checkout 核对 lockfile、DSH pin 及迁移库存，**不会因此证明整个 checkout 干净或其 Git 身份**；P27 必须实查完整 SHA/dirty 状态、构建输入和打包清单。

签名身份是 `clientPublisher: {teamId, bundleId, updateKeySha256}`，取 P14 最终明确的发布者/更新验证公钥，不自动从机器私钥库发现。Developer ID、公证/Gatekeeper 与更新元数据签名是独立断言；ZIP SHA-256 不代替发布者认证。

P27 原始证据条目为 `{caseId, file: {path, sha256, bytes}}`；receipt JSON 固定为：

```text
schema = allrice-p27-evidence/v1
caseId / sourceSha / status=passed / execution=real-execution
observedAt（精确 UTC ISO）/ environment / tenantId / runId / command
artifacts（ID → 本次实际产物 SHA-256）
flagSnapshot（14 个准确开关名 → 实测布尔值）
assertions（{name, expected, observed} 列表）
attachments（一个或多个原始观察 {path, sha256, bytes}）
device（客户端为 {id, architecture, osVersion, physical:true}；其余 null）
```

`REQUIRED_CASES` 和 `CASE_ASSERTIONS` 是可执行的固定覆盖清单：四条任务线、工作台/预览/治理/旧版本/迁移恢复/最终 Dev，以及 11 个客户端场景 × 两架构，共 47 个场景；本地命令/Changeset/进程树取消/隔离也须在两台实际设备分别验证。各场景固定子断言不可删除、重复、改名或加入未知成功项；每个 expected/observed 必须对应归一化的真实 runner 观察。签名/更新场景另必须匹配实际发布者和验证公钥。所有非客户端联合收据绑定七份候选产物，客户端绑定 source 与对应 ZIP；兼容重部署的恢复收据额外绑定全部 `rollback/<id>` 目标摘要。不同构建不能借用另一构建的“通过”。

不要写“列出 expected 并回显为 observed”的产品包装脚本。仅可以从**已执行的真实测试结果**生成 receipt，并附原始日志、运行/审批/副作用标识、实际文件/退出码或截图；保留失败报告与修复前记录，修复后重跑固定候选。实际助手场景必须在隔离范围观察到助手开关开启，最终主 Dev 冒烟必须观察到默认关闭；开关配置不是运行成功证据。

时间上限固定为 7 天，未来/格式错误日期也拒绝；这是本版本清单保守时效规则，不声称历史实测结果不存在。超期重新核验相关场景并重新封存，不能把旧收据时间改成今天。任何源码/包/迁移/政策变化均重新固定受影响候选；不使用旧 B5 报告冒充最终 B6。`unknown`、`skipped`、`mock`、缺文件/断言/设备、摘要不符、重复 JSON key、未知 schema/场景都不能通过 RC。

**信任边界**：清单 SHA-256 必须来自 P27 已核对的独立 PR/验收记录，而不是临时对任意未审阅清单计算后当作授权。检查器只证明相对于此可信 pin 的字节完整性与**所声明**证据覆盖，不验证日志真实发生、审批者身份、Apple 服务或 CI 签名链，也不执行实验。提交一整套相互一致的伪造报告仍不能成为真实验收；P27 必须对原始执行来源和授权记录进行审查。本测试文件内的合成 receipt 只验证检查器，**绝不允许出现在发布证据包中**。

## 3. 只读调用与不同门禁

所有参数必须显式提供，不读取 ambient 环境、访问网络/DB、启动进程、执行 SQL、安装包或改文件。以下占位值先替换成已审查的真实绝对路径和独立可信 pin：

```bash
node scripts/acceptance/platform/p28-release-readiness.mjs \
  --manifest /absolute/redacted-evidence/release.json \
  --evidence-root /absolute/redacted-evidence \
  --source-root /absolute/pinned-candidate-checkout \
  --source-sha FULL_FINAL_CANDIDATE_SHA \
  --manifest-sha256 INDEPENDENTLY_REVIEWED_MANIFEST_SHA256 \
  --gate rc

node --test scripts/acceptance/platform/p28-release-readiness.test.mjs
```

| `--gate` | 只检查的条件；不代表执行授权 |
| --- | --- |
| `prepare` | 版本/文件/迁移库存/关闭状态/恢复方案结构和完整性；所有未获证据继续显示 `technicalBlockers` |
| `dev` | 上述条件 + 候选实测材料 + 独立 Dev 授权记录；仅允许最终 Dev 冒烟收据尚未发生，避免部署前要求部署后结果的循环 |
| `rc` | 全部 47 个最终候选真实证据声明，包括最终 Dev 冒烟；不要求 Prod 批准，也不授予它 |
| `tenant` | RC 条件 + 本版本、准确一个租户、准确 enableFlags/迁移/恢复模式的单独授权 |
| `prod` | RC 条件 + 独立 Prod 授权 + 已批准单租户的 `tenant-canary-real-smoke` 原始收据（实际版本/flags/租户一致） |

退出码 0 仅表示请求的**材料检查**成立；2 表示拒绝。JSON 同时返回 `preparationVerified`、`technicalEvidenceComplete`、blockers。即使 0，`deploymentExecuted`、`migrationExecuted`、`flagsChanged`、`authorizationGranted`、`gaDeclared` 永远为 false。P27 的人类可读技术结论和真实版本回执仍不可省略。本工具不作为旧共享 release-gate 的替代，也不自动增加 package script。

每个授权记录包括 `scope/sourceSha/releaseId/approver/record/recordSha256/grantedAt/expiresAt/tenantIds/enableFlags/migrationNames/rollbackMode`；原始批准正文与摘要单独保留。Dev 发版批准不允许直接带 `enableFlags`；单租户批准恰一个 tenant；Prod 明列租户，不用 `*`。空/过期/错版本/错迁移/错恢复/未批准记录拒绝。它们仍只是待核实的批准**记录**，不是检查器认证的签名。

## 4. 开关与签名门禁

草稿明列 B5 的原 13 项执行开关和 P25/P26 的 `ALLRICE_ASSISTANTS_ENABLED`，全部 false。`ALLRICE_WORKBENCH_ENABLED`、现有 UI/认证/provider 配置不是本次扩权目标，保留实际既有值并由 Dev 原始配置证据记录；不能把“未列入本次开关集合”解释为可修改。新增/重命名执行 flag 必须协调更新清单、代码 allowlist 与回归，未知名不默许。

正式客户端 gate `signedClientRequired` 不可关闭。服务端 flag、租户政策、EmployeeVersion/Skill 冻结能力、设备 opt-in、目录授权与逐动作精确审批相互独立；一个 `1` 不授予其他条件，也不把基础助手升级成 Boost/Teamwork。租户灰度必须核对实际代码支持的范围隔离：若只有全局环境开关而无法证明逐租户强制政策拦截，**禁止依靠清单 allowlist 假称单租户灰度**，保留关闭，补实现和实测后再申请授权。

紧急停用先阻止新准入，同时按既有撤销/租约/根取消机制处理运行中动作；关闭 UI、停止派发、取消请求和进程确认停止不是同一状态。未知副作用进入核对，不盲重放、不隐式转云。关闭开关不能抹掉历史或自动清除冻结能力记录。

## 5. 迁移：expand → backfill → contract

本切片不新增/运行 SQL。检查器固定 B5 原有 93 份 migration（编号至 0092）的排序文件名+内容 SHA-256 库存摘要 `ef1e7b033c925c452196271bb402706556b60f39c11b83c9573bdcdb09abe747`，修改旧迁移立即拒绝。集成后所有新增 `.sql` 必须在 `migrations.changes` 恰好列出 `{name, sha256, phase}`；目前 P25 保留 `0093_assistant_runtime.sql`，**其最终内容未在本草稿中假定**。

1. **Expand 准备**：记录目标 DB schema 版本、准确 SQL 摘要、锁/运行时长风险、空间影响、旧/新 Web/Worker/Bridge reader兼容性。只增加兼容结构；旧记录保持可读，不重写已发布历史，新增功能关闭。
2. **Backfill 准备**：仅在确实必要时单列，明确租户范围、分批上限、幂等游标、暂停/恢复、失败核对及审计。不能靠时间猜测回填历史 operation/审批关系。无 backfill 也要在实际迁移收据说明为何不需要；不由空数组推断已检查。
3. **授权执行另行处理**：迁移权限与对应环境、版本、租户范围一致；真实只读 preflight/drain/备份必要性由发布执行者按风险检查。若需要备份/恢复演练，先取得数据访问/位置/保留/恢复目标授权。本工具及本 PR **没有执行数据库备份**。
4. **Contract 延后**：第一次发布不得同批删除字段、旧 reader 或旧格式兼容。另一个版本/工单明确保留窗口、已分发客户端与读写使用证据、迁移完成审计及恢复手段，再取得独立批准；本版本 `contractDeferred` 必须 true。

检查器验证库存与声明，不把 SQL 文件写着 `phase: expand` 当成安全证明；P27 必须查看真实 SQL 并实际验证旧/新混跑、失败中断、重复/恢复 backfill 与数据保护。本脚本不尝试用关键词扫描替代 SQL 审查。

## 6. 恢复选择与演练程序（本 PR 不执行）

默认 `forward-fix-only`：没有已经实测、能读取最新 schema、credential record、journal/outbox/助手 checkpoint 的旧包时，**保持兼容读取器并准备前向修复**。B5 发布历史不是安全回退证明；不得自动恢复旧 Credential reader、删新格式记录、强制重新配对或覆盖用户目录。此模式不伪造 target SHA/ZIP，也不承诺即时恢复；P27 演练应证明停止新准入、排空/核对、状态保留、当前兼容版本恢复，尚未构建的前向修复仍需新 SHA 与复验。

需要 `compatible-redeploy` 时，清单必须绑定另一个完整 target SHA/release ID、其 Web/Worker/双架构实际文件/版本/build ID，并实际证明它们兼容**已写入新状态后的** schema/客户端；测试只拿空库、旧凭证或同名二进制不算。对应恢复收据额外绑定全部 target 文件摘要，不能借用另一旧版本的恢复结果。

演练与将来执行按下列阶段留证：

1. 固定故障症状、影响租户/目标、最后可信版本、源/目标包以及明确恢复授权；不因本页存在而默认获准维护服务。
2. 阻止新高风险准入，核对实际运行树、租约、Bridge journal/outbox、后台进程、浏览器控制与已批准副作用。记录所有已完成/待回执/unknown；无法确认停止则停止切换并处置，不能把取消 ACK 当排空。
3. 保留 Session/历史、配对、目录授权、credential records、账本、checkpoint/outbox、Memory/Skill、成果权限与实际字节。只有验证兼容目标才能切换协调的 Web/Worker/客户端分发；否则保持当前兼容 reader + 关闭新能力，进入前向修复。
4. 恢复后先确认准确 SHA/build/包身份和 flags，再对合成范围复测旧 Session/客户端、配对/目录、撤权/跨租户、已完成副作用不重放、未知核对、任务取消、文件下载和所涉失败邻域。记录实际恢复方式、时间、结果与未解决问题。
5. 任何破坏性 DB restore 都不是普通应用回退，必须另开事件方案评估 RPO/RTO、恢复点之后写入损失、租户影响与授权；不得从本程序推导可覆盖活动数据库。

## 7. P27 最终交接与限制

P27 在预集成、最终 main、最终 Dev 阶段分别固定 SHA/构建/包与事实；预集成通过不能替代最终 main 的 Dev 验证。测试失败/关键安全证据缺失、重复副作用、丢数据、越权或 unknown 未核对均是阻断，不从 failed/skipped 汇总里删除它们凑通过。适用证据与所有阻断闭合后才形成 RC/GA **技术验收**结论；实际租户/Prod 发布仍单独授权、执行与冒烟回执。

范围限制至少保留：完整 Boost/Teamwork/Handoff/开发协作、任意 PTY/宿主 Shell、任意宿主端口/公网隧道、P23 WebSocket/HMR、所有第三方站点/MCP 兼容、未实测 OS 版本、模型计费 E2E 未跑的项目。基础助手两条真实模型任务不能由 P24 PoC 或静态返回值替代；未调用真实计费模型不写“真实模型 E2E”。本检查器只强制登记的代表性 GA 矩阵，不证明所有业务/平台无遗漏。

只读工具的具体限制：最多读取 8 MiB 的 JSON/单个原始文本，单产物最多 256 MiB；更大材料需另行评审的流式支持，不自动忽略。拒绝路径越界、隐藏路径、符号链接/特殊文件，但不是面向恶意并发替换文件系统的 `openat` 沙箱；证据根须受信且验证期间不可变。无需私钥、网络或数据库连接。

本切片自测仅证明检查器能拒绝错误材料，不能生成新的产品验收成功。产品原始报告由 P14/P25/P26/P27 提供，发布执行记录以后按真实授权补充。
