# DSH 复用与替换清单

> 2026-10-27 起，复用 DSH 但和 DSH 默认不同的地方，总览以 Linear MET-225（DSH 定制点清单）为准，规则见 `AGENTS.md` 第 0 节。本文继续保留 `CONTRIBUTING.md` 和 `pnpm dsh:verify` 要求的逐项决策记录（每个 `patch-ledger.json` id）：新增、删除 patch-ledger 项或升级 DSH 时，按 `CONTRIBUTING.md` 更新对应 id 的段落；其余按日期记的流水账不再续写。

## MET-221：只用一代 DSH

2026-10-25 起，AllRice 任何时候只依赖一代 DSH（当前 `0.2.1-rc.2` / `687f282`）。升级时 Worker、Web、Bridge、Office 与维护工具一次性换到新一代，不保留旧包、旧补丁或独立的旧版服务。

- 已删除：`apps/dsh-admin`（独立 DSH 管理控制台，最后版本见 tag `archive/dsh-admin-0.1.5`）、`packages/dsh-web-search-codex`、`packages/dsh-runtime-diff` 的 WebUI 插件、五个 `0.1.5-rc.3` 物理补丁及工作区里旧代的 `packageExtensions`、`overrides`、`patchedDependencies`。锁文件只剩一个版本的 `@deepseek-ai/dsh-*`。
- `pnpm dsh:verify`（CI 执行）由 `scripts/verify-dsh-single-generation.mjs` 拒绝：锁文件任何位置（packages、snapshots、importers 的声明与解析结果、overrides）出现非当前版本或非 registry 来源的 DSH 包，`package.json` 里非精确版本或别名声明，指向其他版本的 `packageExtensions`，以及任何 DSH 物理补丁。`packageExtensions` 只用来补当前一代漏写的依赖元数据。代码里导入的 DSH 私有子路径必须逐项登记在 `compatibility.json` 的 `privateInterfaces`。
- `patch-ledger.json` 改为 schema 2，只登记当前一代经公开接缝实现的协议扩展。
- 旧会话：不含 AllRice 私有事件的历史日志由当前一代的官方格式迁移器向前迁移，迁移后可继续对话（`legacy-official-migration`）；带私有事件的日志被拒绝且不改写（`legacy-format-refusal`）。按用户决定（10-25），迁不了的旧数据是测试数据，切换时不导入，不做只读归档。
- 仍待消除的例外：当前一代仍写 4 种 AllRice 私有事件（官方迁移器不认识它们；V0 日志已实测因此被拒，下次换代很可能同样如此，MET-221 第 1 阶段处理）；Web 的 `apps/web/app/dsh-upstream/` 是 0.1.1 UI 源码拷贝，Web 还按文件路径读取 DSH 包内的 `lib/client.*.js` 浏览器资源（两者随 Web UI 换代单独排期）。

## MET195：原生运行关闭观察

`allrice-observed-native-close-v1` 继续复用固定 `0.2.1-rc.2` 的公开 SDK shutdown、根 Context dispose 与 JSON-RPC transport flush。AllRice wrapper 逐项记录实际返回结果，最终响应排空失败使自身非零退出；Worker 等待原有子进程的 child close/stdio 关闭，并把原 owner、包、boot 与关闭观察写入不可变持久记录。物理退出、语义关闭确认和持久回执分别判断，缺失或失败保留 unknown/unconfirmed，不把历史补成成功，也不重放业务任务。

这是 AllRice 协议与持久登记的接线，不修改 DSH 核心、依赖或物理补丁；物理补丁当时仍为 5 项（MET-221 已全部删除）。回归复用现有 protocol、pool、Worker 关闭测试，以及隔离 PostgreSQL 的 owner/FK、幂等回执读回与退休锁序检查。真实 SDK、最终 transport 排空与实际 Worker 退出仍须按同一候选版本验收，离线夹具或退出码为零不能代替语义证明。若上游公开关闭接口提供等价的可核对回执，可用其替换本层协议字段，保留 AllRice 的精确 owner、租户隔离、不可变历史与 unknown 处理。

## MET194：企业品牌内容业务读取

`allrice-brand-content-read-v1` 通过公开原生工具注册将当前定制员工的品牌业务读取转交现有 Tool Broker。AllRice 负责当前组织、个人实例、来源与任务租约，DSH 保持原模型与 Agent Loop。业务写入复用现有持久 Workflow，采纳、审稿和真实发布回执仍由真人操作；没有 DSH 核心补丁、第二个模型调用器或调度时钟。

当上游提供可以绑定本平台租户业务读取端口的等价接口时，可替换这一层薄工具声明，不能移除 AllRice 的实际来源授权及持久业务回执。回归见 `tool-manifest.contract.test.ts`、`brand-content/workflow-start.test.ts` 与真实隔离的包、业务、步骤恢复 PostgreSQL 检查。站内发布提醒沿用现有 AllRice Automation once，本切片不宣称 MET192 的 DSH Schedule 已上线。

本页是 Allrice 对上游 DSH 的持续复用决策入口，跨 2.x / 3.x 维护。每次升级先检查上游是否已解决我们的适配问题，再决定保留、替换或退役；不能把历史补丁默认当成永久实现。

运行事实仍以 [upstream.json](../../apps/worker/dsh/upstream.json)、[distribution.json](../../apps/worker/dsh/distribution.json)、[compatibility.json](../../apps/worker/dsh/compatibility.json)、[patch-ledger.json](../../apps/worker/dsh/patch-ledger.json) 和依赖锁为准。本页不控制发行渠道、工具授权或候选发布。

## 首要原则：DSH 原生能力优先复用

2026-09-24 用户在 Office 接入复盘中再次明确：**DSH 已有的能力，先复用其原生实现、脚本和工作流程；Allrice 只补实际验证出的缺口与必需的产品接入。不能在没有验证原生路径之前，先写一套同类实现。**

这条原则适用于所有后续 DSH 升级、能力接入和替换工单，包括 MET-144 / MET-145 / MET-146 的 Subagent、Team 复用，MET-156 下挂的 Office、PTC 等 Skill，以及 MET-155 架构改造。历史工单中的自有实现或“本轮不接入”结论，不能代替新一轮原生复用验证。

2026-09-24 MET-160 补充：**先找并验证官方插件的正常接入方式。官方插件够用就直接用；只有确认具体功能或接入缺口，才找官方组件源码做最小适配。** 发布包只有插件入口、不导出独立 React 组件，并不等于不能复用插件。不得以此直接跳过官方插件验证。

### 每个复用工单的执行顺序

1. **先跑原生最小闭环。** 找到官方包、脚本和示例，准备其要求的运行环境，用一个真实任务验证输入、执行和交付。以最小可运行实验开始，控制时间和 token 投入；不先搭完整自有框架或做大范围重构。
2. **区分接入工作与能力缺口。** 租户身份、输入输出映射、文件保存、版本和界面属于 Allrice 接入责任，由薄适配完成。上游不认识 Allrice 的文件对象或业务 ID，不是重写上游能力的理由。缺依赖、缺执行工具或缺文件交付接线时，先补齐环境和接线。
3. **复用可执行能力。** 优先保留原生提供器、脚本、工具和工作流程，尽量不修改上游资源。仅引用 Skill 文案后另写全部执行逻辑，必须如实标为“指导内容复用”，不能算作原生能力接入。不能为了适配自定义接口，提前缩减上游已经能完成的操作。
4. **只对具体缺口补代码。** 自写前在工单记录固定上游版本、复现任务、实际失败或缺失行为，以及为什么简单适配不能满足要求。按证据选取最小补充范围；“更可控”“更符合现有架构”等笼统判断不能单独作为重写理由。上游发布版本是优先验证和复用的起点，接入后的真实结果仍需检查。
5. **按用户任务验收并开放。** 验收实际文件和行为，区分完整完成、部分完成和运行失败，不能仅以 CI 通过、文件存在或运行状态 succeeded 认定完成。接入能力沿用下面的默认开放原则；有重复旧实现时，同步明确替换范围并清理，兼容代码需注明仍承担的责任和退役条件。

工单与 PR 统一写清五项：**复用的上游包与版本、原生实测结果、Allrice 必需适配、证据明确的补充或自写部分、被替换的旧实现与用户端验收结果。** 不增加重复审批或新的后台开关。

### 2026-10-01 · MET164 PR1 本地就绪优先

**Bridge 具备所需能力、资料/账号及可用环境时默认本地优先；本机缺能力或离线时，兼容的云端能力补位。** 用户指定本地或云端、暂停的能力及不上传资料的要求优先。普通成员已配发员工可使用其已就绪能力，不设岗位门槛或逐工具开通。已连接的原生 API/MCP 继续使用连接器，不因本地优先改走浏览器。

本轮复用现有文件执行、原生 Chromium 探测与监督、Colima 沙箱预检、Bridge WSS、OperationLedger、租约、幂等和对账。新增的是现有心跳内的逐能力状态/缺项/实际版本，以及通用 `browser.workspace` 的位置选择适配；没有新增 Agent 循环、调度器或成果面板。未支持、准备中、可用、忙碌、暂停和离线分别显示；旧 v1/v2 文件能力枚举及数量限制保持原样，旧客户端不需声明尚未实现的新能力。

通用浏览器首次调用将位置和设备写入既有审计与浏览器工作区。准备中或忙碌复用任务资源等待和任务时钟，仅重试同一调用的准入；它们不进入云端容量轮转。后续动作使用既定工作区，明确的 `local.*` / `cloud.*` 调用不改端。原始用户消息的明确位置/不上传要求，以及本轮已绑定的本地文件、命令或 MCP 输入共同约束补位；未知结果先读既有账本和本机日志对账，不能自动重放或改端重跑。

Office 仍复用单一 Skill 中固定的 `@deepseek-ai/dsh-skill-office@0.1.7-alpha.2` 原生指引与检查器。本轮便携 Python/原生任务实验只为 PR4 确定适配，不把 Python 包环境称作 OS 沙箱，不报告本地 Office 已可用。当前只交付 macOS 路径，Windows 暂缓。实验、架构实测与 Dev 验证见 [PR1 原生 Office 实验](met164-pr1-native-office-experiment.md)；未实测架构不记为验收完成。

### 2026-10-02 · MET164 PR4 受管本地 Office

单一 Office Skill 继续使用固定 `@deepseek-ai/dsh-skill-office@0.1.7-alpha.2` 的原生 DOCX/XLSX/PPTX 指引与原字节 `check_office.py`。`workspace.export.create` 的 Python 路径增加 `location: auto/local/cloud`；默认在当前员工电脑的 Office 环境实际就绪时本地生成，准备中或忙碌沿用既有等待，明确缺项才云端补位。内容导出与旧结构化 Office 参数保持原语义，不接受被忽略的位置参数。

Allrice 新增的是 Bridge 执行适配：由现有准备流程管理固定 Colima/Lima/Docker CLI、Linux guest 与同源 Python 软件包，复用 OperationLedger、冻结 Run、原 Tool Broker 调用、租约、取消、原字节文件传输及现有成果版本。用户不用另装 Python 或 Docker。私有虚拟机不挂载宿主业务目录；输入按已授权文件对象复制，成果在物理停止后校验并上传。同一未知操作只对账，不重新执行脚本或自动换端。

这项权限来自发布版本的原工具及 Bridge 读写配置，并在新 Run 冻结；实际运行状态不能替代授权。它使用独立的受管运行环境授权，不借用业务目录或 Node 执行授权。正常发布补齐缺失规则，已有明确拒绝、用户暂停与历史冻结配置保留。

当前固定原生软件包仅包含已验证的 macOS Intel 路径；M 系列没有本地运行验收时如实报告缺项，Windows 继续暂缓。生成、公式计算与页面渲染分别报告事实。本地生成不表示公式已重算或排版已审核；允许云端质量检查时仅检查同一成果字节，不重复生成。要求只在本地处理时不外发成果，必须满足的质量要求不可用则明确说明未完成。

固定软件包来源、许可证和重建方法见 [受管 Python 软件包](../../infra/managed-python/README.md)。实际客户端、Dev 页面与文件验证单独记录；软件包构建成功或预检通过不等于已交付。

### 2026-10-02 · MET166 PR1b 本地优先 Python 图表

新增的 `python.execute`（DSH 原生工具名 `python_execute`）是现有双端计算的统一入口，默认选择已就绪的 Bridge，明确缺项时才使用已授权的云端 Python。复用 PR4 的私有运行环境、现有 pandas/openpyxl/Matplotlib/Pillow/Noto、原 PNG 检查器与 OperationLedger；不新增图表生成引擎、镜像或安装流程，也不借用旧 Node 工具的权限或开关。

原始调用和摘要在冻结记录中保留，`location` 与执行时 Python 默认值仅作接线使用。旧 `cloud.process.execute`、旧冻结镜像和原调用参数保持兼容。新客户端在实际探测中文 PNG 和坏文件拒绝后报告图表协议版本；旧客户端未报告时按缺项处理。已开始的本地操作结果未知只对账，不换端重放。

本地成果保留已上传的不可变对象，接到现有版本、引用和下载通道，不复制同一文件或重复扣存储额度。Office 1.6 继续只有一个 Skill，自动装配统一 Python 工具；图表的原对象和 checksum 可作为输入嵌入 Word/PPT。三份 DSH 原生指南、Office 检查脚本与其许可证字节保持不变。真实位置、PNG 尺寸及停止/上传证据应通过实际 Dev 任务核验，接线测试不代表原生环境已交付。

### 2026-10-19 · MET184 显式成果续版

Python 与项目工具继续复用现有 DSH 注册、Worker/Broker、双端执行和 `registerToolBrokerExport` 版本链。`python_execute` 与项目执行的每项 `outputs` 可带 `parentObjectId`；项目 `deliver` 的同名字段指定源码 ZIP 的父版本，与源码比较用的 `baseline` 分开。不提供父版本时仍新建成果系列，不按文件名猜测历史关系；文本导出显式指定 `.csv` 时保留 CSV 文件名和媒体类型。

父版本必须属于同一租户、工作区、用户和会话，格式一致且当前可访问。新发布要求父版本仍是系列最新版本；同一调用的已发布结果可重读历史版本，但仍检查现行权限、对象状态、来源和校验值。项目只接受不可变的文件或文档成果，不把项目快照当作用户交付文件。Bridge 只接收执行所需的路径、格式和文件名，父版本及完整调用摘要冻结在服务端；旧物理协议不接收额外字段。

云端计算成功后若遇到并发续版冲突，仅在有限命令、无外网、原物理结果明确完成且停止、本次没有存储写入、既有最终对象和发布投影均不存在时，记为明确的发布失败。原始退出码、执行结果和字节保留，沿用原回执与用量账本恢复结算，再确认清理；不重新执行脚本。存储、数据库 ACK、外部请求或清理结果未知时保持未确认，不能伪装成安全失败。

本次不修改 DSH 核心、依赖、原生 Office 技能或执行镜像，也不建立另一套成果/补偿系统。客户端构建输入变化，因此构建 Bridge `0.6.0-dev.56`；原生参数往返、真实数据库与本地构建通过不能代替 Intel/M5、云端物理执行及 Dev 普通账号的实际交付验收。

### Office 复盘与纠正方向

MET-157 前期复用了上游指南，却主要通过 Allrice 自定义结构化接口重新实现文档操作。在没有先完成原生对照的情况下扩大自有实现，增加了开发和验证成本，也限制了页眉修改、追加格式化内容、条件格式、原图表更新和新增幻灯片等操作。这是需要纠正的实施选择，不能作为后续 Skill 的默认接入模板。

2026-09-24 的相同模型、相同输入小样本对照中，基础任务两边均完成，Allrice 用时 108.6 秒、原生用时 213.7 秒；复杂任务原生完成所要求的文档操作，当前 Allrice 仅部分完成。原生复杂 Excel 仍有公式缓存为空、打印分页溢出的问题，属于有实测依据的补充范围。纠正方向是让原生文档工作流程承担开放式操作，复用现有文件交付、版本、公式重算和预览；本次实验不代表已完成租户原生接入，也不证明原生在所有任务上更快。下文 PR1/PR2/PR3 记录保留当时实现事实，不构成继续扩大重复实现的依据。

## 默认开放原则：升级能力默认开放

2026-09-24 用户确认，作为测试阶段每次 DSH 升级的持续执行原则：

> **升级带来的能力默认开放，优先复用上游，快速提升性能与体验；在真实使用中测出问题，再及时修复。**

- 每次升级都检查上游新增能力、改进和原先未接入的功能。能复用的优先接入，能替换重复实现的及时替换，不因旧版本曾关闭就沿用关闭状态。
- **默认开放包括默认展示和实际可用。** 已接入能力随升级面向测试租户启用，同步更新运行配置、数字员工工具配置与发布状态、两个后台入口及使用说明。只增加卡片、按钮或“已集成”标签，不算完成开放。
- 优先交付可体验的增量，不等待整个 3.0 架构重构，也不为每项已接入能力重复设置管理员开通步骤。具体命令、文件修改等操作继续走现有授权与审批流程。
- 验收后保持能力开放，供租户持续试用；不能习惯性恢复到升级前的关闭配置。发现实际问题后记录复现和影响，尽快修复并复测；确需暂停时只暂停受影响能力，修复后重新开放。
- 尚未接入、依赖未安装或存在已知故障的能力，记录具体缺口、负责工单和下一步，优先补齐；状态如实标注，不把尚未实现的能力写成已经可用，也不以笼统的“谨慎起见”长期搁置。

### 管理后台的勾选与实际执行

测试阶段以管理员的员工配置为开放入口：勾选 Skill 自动装配所需工具，勾选工具同步配置员工能力；点击“保存并发布所选能力”后，目标租户的执行策略一并启用。不得要求管理员再找隐藏环境变量、手动重复配置租户规则，或先完成一次只读预览才能发布。

`ALLRICE_ENV=development` 下，已实现的执行服务默认开启；Web 与 Worker 共用 `runtimeFeatureEnabled`。显式 `0` 只用于暂停存在实际问题的服务，此时后台必须如实显示暂停并给出发布错误，不能用 `released: true` 掩盖执行端关闭。部署 Dev 时同步更新两端配置，并保持验收后的开放状态。生产环境继续使用显式配置和原发布检查。

配置预览明确标为只读，并区分已授权但未装载的工具与真正缺少的工具。完整试用通过发布后的租户工作台，以当前登录用户和实际员工版本执行。设备目录、连接凭证和具体操作审批继续使用真实资源与正常执行流程；缺少哪项就提示哪项，不用“需平台运维处理”代替诊断。单独选择工具也可以使用，不强制绑定一个 Skill 才授予对应能力。

云端隔离计算属于平台提供的执行环境：部署先验证真实 gVisor 后端并登记固定运行配置，开发环境发布选择了 `cloud.process.execute` 的员工时，为已分配成员自动配置该沙箱的使用授权。不能只登记一个浏览器沙箱就声称支持脚本计算；也不能在验收后停掉计算 VM。Colima 的 `runsc` 配置需保存在 profile 的 `docker.runtimes` 中，避免重启覆盖运行时配置。MCP 工具选择同步装配员工的连接器身份许可，但具体第三方连接仍使用租户真实绑定。

## 员工会话与设置入口整理（2026-09-27）

复用固定版本 DSH 的员工树、会话行和 SettingsPanel，取消侧栏底部独立的“加载更早的工作”。员工内的“展开其余”同时展开已加载会话并按该员工游标继续读取；服务端提供同一租户、工作区、可见范围和归档筛选下的员工总数，让首批之外的员工与已撤回员工历史保持可发现。分页失败在员工下面重试，切换归档、用户或工作区时丢弃旧请求，不放宽私有会话权限。

“能力与环境”从聊天标题栏移入原生设置的独立分区，采用官方 `IconSparkleMedium`，与现有导航图标区分。沿用原能力内容与状态来源，打开检查一次、手动刷新；准备任务保留已有草稿，连接应用在同一个设置面板内切换，本地电脑配对继续使用现有入口。图标补丁与摘要登记在 `native-settings` UI 账本。验收覆盖真实 PostgreSQL 的跨员工翻页和隔离、桌面/触屏展开滚动、失败重试、旧响应丢弃，以及能力状态、草稿和焦点行为。

## 默认开放与可见配置（2026-09-28）

用户明确要求：快速迭代期能力默认开放，系统已有边界直接沿用，不在隐藏页面叠加时长、文件大小、流量或调用次数限制。需要保留的用户选择统一放到可见设置，状态必须区分未连接、客户端待升级、主动关闭与执行错误，不能把所有情况写成“未授权”。

本地浏览器复用 Chromium / Playwright 的原生 storageState（Cookies、Local Storage、IndexedDB），默认在同一用户、设备的专用浏览器保留登录；设置 → 我的电脑提供开关与清除登录。普通成员可以操作，旧 `/workspace/local-browser` 入口跳转到该设置。浏览器默认时长使用平台单任务 1 小时上限并受任务实际截止时间约束，文件使用平台现有 9,000,000 字节传输上限；移除浏览器代理单独的 40 MiB 累计流量和 200 次连接限制。旧 Bridge 升级后自动更新历史自动配置，用户主动关闭和撤销的选择不会被重新开启。

租户隔离、设备配对、实际登录和用户文件选择继续由现有系统负责，不另造授权层。登录资料仍只留在本地专用浏览器，不读取个人 Chrome 资料，不上传到模型；网站自身的登录过期规则照常生效。

同次巡检：云端浏览器也移除独立 10 分钟限制，平台生成的旧默认配置自动生成后继版本供后续任务使用，已启动任务保留原绑定；旧云端授权页跳转到「员工工作方式」。本地服务预览沿用底层服务截止时间，保留旧 Bridge 的预览协议兼容。经验功能在开发环境默认开放，并进入「记忆与经验」设置；本地应用高级连接从旧独立页面移入「已连接应用」。所有文件交付入口取消缺省 1 GiB 隐式配额，仍遵守明确配置的工作区配额及实际存储容量；「账号与用量」展示真实占用、明确配额和统一文件传输上限。

保留的边界：用户主动关闭的开关、租户和设备归属、真实账号登录、任务 1 小时与无进展保护、物理资源容量、底层文件/协议大小。旧工作台不因“默认开放”重新启用；尚未实现的 Team/Boost 不冒充可用能力。后续能力不能依赖只有旧地址才能看到的设置。

## 执行用量原则（2026-09-27）

用户确认：**默认单任务 1 小时时限保留；Token、模型/工具调用次数和费用仅统计，不在执行过程中按累计用量中断任务。** 此原则覆盖订阅、API、父任务、子助手与原生压实，不再通过 `ALLRICE_CODEX_TOKEN_POLICY` 恢复旧用量限制。

缺失用量/价格保留未知，不冒充零，也不作为已完成任务失败的原因。真实执行、交付和子任务完成仍须确认，部分完成与未知副作用不能因已有文件而写成功。死循环、无进展、租约、授权、单次操作超时、实际 CPU/内存和模型协议边界保留。未来按租户任务次数或使用天数限制，放在新任务入口，避免中断已接受的正常任务。

沙箱容量满载应持久排队，容量在启动时按实际执行节点计算，内存压力暂停新领取；预热仅在实测有收益时使用现有 Docker 后端的轻量实现，继续复用 DSH Office 指南、脚本及检查器。详见[云端执行与并发调度方案](cloud-execution-scaling.md)。

## 会话归档接入（2026-09-27）

复用 UI `0.1.7-rc.1` / `46a7f68b0922371ce7144b668b90e377d8e799f4` 的 `ArchiveSession`（悬停按钮、菜单和运行中确认）、`RowActionToast`（撤销、归档筛选入口）、原生行与 `ArchivedFilter`。已核对官方插件入口：依赖 DSH `remote`、Session/Workspace Host 控制器和 slot 宿主；本仓沿用已验证的员工树源码接入，组件行为与样式保留，只适配导入和宿主类型。固定源码、摘要与可重放补丁登记在同一 UI 账本。

Allrice 将归档状态接到既有 `allrice_chat_sessions.archived_at`，普通成员管理自己的会话。“新的工作”右侧使用 DSH 原生归档图标和 Tooltip 作为入口，不单独占一行筛选；点击查看归档列表，可返回当前工作，新建工作也会退出归档列表。服务端按筛选分页，不把前 30 条当作全部历史；按员工归属展示和恢复。归档后可只读回看聊天与成果，恢复后再继续工作。输入、计划继续、文件修改和反馈写入保持归档限制。

列表游标保留 PostgreSQL 微秒精度，避免同一毫秒内更新的会话翻页漏项；使用 35 条同毫秒归档记录验证跨页完整性。

运行中确认基于服务端真实任务和定时任务。归档事务与任务准入共用会话锁，复用停止按钮的持久化助手取消和队列取消请求，同时暂停会话绑定的定时任务；恢复不撤销取消请求、不重启定时任务。停止请求在后台收尾，提示不把请求发出写成进程已经退出。验证使用隔离 PostgreSQL 和无模型 Chromium 场景，不用租户真实任务测试停止。

## 第二批验收后的接线修复（2026-10-01）

Office 1.3.2 继续复用官方指南、原生 Python 库和检查器，仅补充局部修改与重新上传历史成果的参数说明；相同文件通过权限与校验值确认后可继续原版本链。导出失败依据实际工具回执标记未交付，不能把历史文件当作新版。

模型恢复仍由原生 agent loop 决定。已确认的可重试模型失败结束且结算获得持久 ACK 后，允许新的原生调用继续；缺少结束回执或 ACK 时不猜测执行完成，也不重放工具。原生重连事件直接接入工作过程展示，不另写重试调度器。具体修复和验证范围见[第二批验收修复记录](dev-validation/2026-10-01-qa-second-batch-fixes.md)。

## 本轮复核

### 文件交付链接与 Office 参数兼容（2026-09-27）

后续 ETH Run `dc51dbd1` 的首次 Excel 沙箱执行返回失败、无诊断输出；重试交付三个文件且原生 turn 已 completed，但 Allrice 未结算第一次失败的写工具调用，最终错误标为 `ASSISTANT_EXECUTION_UNRESOLVED`。补齐的是 Allrice 记账接线：原生 Office 在文件发布前确认失败时，由执行处理器给当前 Run/调用绑定失败回执，按一次失败尝试结算，允许 DSH 自行修正后正常完成；发布、传输、清理结果不确定时仍不能冒充已完成。首次 Excel 原脚本单独重放通过并保留 6 条公式，现有证据不足以归因于公式或图表；沙箱补齐退出状态和校验诊断，并在退出前排空输出管道，避免丢失大文件或错误报告。DSH 原生文档库、检查器与重试流程继续复用。

Run `851fafd3` 一次成功、无工具失败，仅返回示例文字和图表代码；随后 `f0adbe4a` 的 Excel/PPT 导出分别遇到嵌套 `python.changeSummary` 未声明及 `python.sourceObjectId=null` 类型错误，共四次校验失败后成功。补充模型可见的原生参数声明和 Broker 契约：接受这两个无歧义的元数据写法，保留修改说明，冲突说明明确报错；未知输入文件与校验和检查照旧。清理运行提示中仍推荐旧 `office.kind=edit` 的内容，默认使用现有 DSH Python Office 工作流程。未重写文档执行或渲染。

前端直接使用 `@deepseek-ai/dsh-client-ui-primitives@0.1.7-rc.1` 已导出的 `MarkdownDelegateProvider` 接入现有成果 Dock，保持原生 Markdown 链接、键盘与修饰键行为。补齐该版 `design-platform.css` 的 `--dsw-alias-link` 蓝色映射，避免旧主题使链接继承正文黑色。普通点击当前 Run 已核实的文件链接打开侧栏预览，下载仍由既有 DocumentToolbar 提供；其他网页保留外链行为。历史回复里重复转义的斜杠仅在匹配已鉴权成果 ID 时修复。验证使用真实 DSH 协议参数回放及浏览器点击、主题颜色和精确版本下载检查。

### 原生任务清单：复用 TodoPanel 与 todo_write

2026-09-27，继续使用已启用的原生 `todo_write`（引擎 `0.1.5-rc.3`），补齐 `todo/write` 的公开步骤名称与状态到既有持久化 Run 事件。前端复用固定 UI `0.1.7-rc.1` 的 `TodoPanel`、原样 CSS、官方 `StateDot` 和图标，在输入框上方默认显示；不新增模型调用、轮询接口、执行器或权限开关。

发布包未单独导出面板，因此沿用源码同步账本。适配仅替换宿主类型/翻译入口、移除依赖 DSH Host 的 dock 注册，并让 Allrice 等待或结束时停止未完成步骤的动画。折叠、计数、行布局与滚动沿用原生实现；`scripts/dsh-ui-patches/TodoPanel.tsx.patch` 可重放，来源与校验记录在 UI `upstream.json`。

任务清单沿用原生整表替换语义，包括清空；选取当前会话最新一轮的有效事件，不从其他会话或旧任务推断计划。同一任务恢复后尚未更新清单时保留原快照；新尝试写入后，旧尝试的迟到事件不能覆盖它。刷新/重连读取既有授权事件接口；旧事件只有计数时不虚构步骤。暂停、失败和结束不会把未完成项伪装成成功；清单是员工公开维护的计划，交付仍以文件与执行结果为准。

验证覆盖 Worker 公共字段投影、事件重放/乱序/去重/清空，以及完整 ChatFlow Chromium 的更新、输入焦点、窄屏、暂停、失败、刷新恢复与会话切换。

### MET-155 PR3：保留已有对账实现，统一配置与工作方式

2026-09-27，业务对账沿用现成的冻结脚本、云端执行与 XLSX 导出，使用 PR1 同一依赖装配和发布链路。仅升级 SOP 到 1.0.1，使其遵循成员自动工作设置，消除不必要的预先等待审批；没有重写脚本、Office 或报表引擎。三批实际删除/保留范围和验收要求见 [PR3 记录](allrice-3.0/reconciliation-and-acceptance.md)。

### MET-155 PR2：开发协作流程资源化（历史，MET-210 PR2b 已退役）

2026-09-27，复用既有 DSH Subagents、冻结 Skill Bundle、候选账本、沙箱及交付能力。新增 Allrice `development-cooperation` Skill 承载现有角色 SOP；Worker 从本次冻结资源读取对应角色说明，保留真实引用和程序校验。后台统一从技能页装配，移除开发工具专用装配按钮。未选择新 Skill 的旧包保留兼容提示。没有新建 Team 或开发执行框架；具体职责与回退见 [PR2 ADR](allrice-3.0/development-skill-adr.md)。

### MET-155 PR1：复用现有能力装配与发布

2026-09-26，基于 main `bb4cc68`，引擎 `0.1.5-rc.3` / Web UI `0.1.7-rc.1` 均保持不变。继续使用已有 manifest、Skill Bundle、`requiredToolRefs`、草稿装配器和发布冻结链路；没有重写 DSH Skill 执行。实际补充仅为 Allrice 的手选工具来源、静态依赖收敛和后台解释。取消 Skill 只移除无其他来源的自动依赖，历史工具不猜测删除；编辑来源不进入运行包或 DSH 复用指纹。

后台沿用 MET-159 的默认开放、按需连接和成员设置，清理手动配置 MCP、重复成员授权和固定逐次审批的过时指引。真实浏览器经 HTTP / PostgreSQL 验证共享依赖、单独保留、发布与回退；职责、兼容及验证边界见 [PR1 ADR](allrice-3.0/capability-configuration-adr.md)。PR2 / PR3 继续复用现有开发协作与对账交付，不为 3.0 重建已完成的 Office 或工作台。

### MET-160：官方 UI 复用与后续同步

设置入口复用官方 `Modal` 与 `SettingsRoot` 双栏导航：账号用量、已连接应用与电脑配对统一进入设置，普通成员无需管理员角色或额外浏览器授权表单。完整设置插件绑定 DSH 宿主 `remote.settings` / ConfigForm / onboarding，故保留原生面板源码并接 Allrice 既有业务组件；不复制宿主模型/插件配置为无效租户开关。来源与补丁纳入同一 UI 同步账本。

固定 Web 组件版本 `0.1.7-rc.1` / `46a7f68b0922371ce7144b668b90e377d8e799f4`；Worker 引擎仍为 `0.1.5-rc.3`。官方 DockLayout、PDF 发布组件、CodeBlock 直接使用；员工树因原生 WorkspaceBrowser 固定工作区管理菜单和缺少员工轨配置，文件树因宿主 cwd/RPC 接口不适用于对象存储，取原生组件源码并记录最小适配。原生 store、折叠、标签/分栏、目录生命周期与缩放不另写一套。完整插件验证、实际文件结果、边界与回退见 [工作台复用记录](../features/native-workbench/README.md)。

已替换旧扁平员工会话展示和单成果固定容器；既有 Office 渲染、文件权限/版本、Diff/反馈及 Markdown 仍承担业务责任，不能因接入原生容器而删除。新入口默认展示，无新增管理员开关。`pnpm dsh-ui:verify` 校验 UI 来源/依赖/导出，`pnpm dsh-ui:sync` 从固定官方提交重放补丁；今后每次升级先检查官方是否已提供可替换这些适配的配置。测试夹具保留生产的 ESM 懒加载边界，依赖安装必须能从锁文件完整复现。

会话右缘的轮次导航复用同版官方 `TurnNavigator` 组件、原样 CSS 和有界预览函数；发布入口尚未单独导出该组件，因此采用已有源码同步方式，只替换宿主类型导入并绑定局部官方主题变量。Allrice 负责已有消息/运行关联、中文提示、消息锚点及回看时暂停自动跟随，不另写导航条、悬停预览或虚拟列表。至少两轮且正文宽度足够时默认展示，成果栏挤占空间或手机窄屏时沿用官方隐藏规则；预览不调用模型、不新增 Token 消耗。来源、类型补丁与依赖已登记，后续官方提供独立组件导出时优先改为直接导入。

消息尾部的复制、赞/踩、日期、反馈分类弹窗复用同版官方 `MessageIconActions`、`MessageFeedbackActions`、`FeedbackDialog` 及原生 controller；不提供「在新对话中分支」。完整插件依赖 DSH Host RPC，发布入口未独立导出组件，因此沿用源码同步，只适配宿主类型、DOM timer 类型和 React StrictMode 生命周期。Allrice 接既有 `allrice_run_feedback`、租户身份和后台处理记录，评价不创建模型任务。文件修改统一在当前聊天中提出，成果栏只提供预览、下载和版本对比，不再增加独立修改表单和修改记录。入口默认可用，无新增开关；交互、重试和数据边界见 [租户反馈](../features/tenant-feedback.md)。

用户消息同样直接接入既有 `MessageIconActions`：气泡下方显示本地时间和复制按钮，今天只显示时分，同年其他日期显示月日与时分，跨年补年份；沿用原生跨午夜更新和复制成功对勾。与员工回复一致，桌面端通过原生 `data-actions-reveal="hover"` 在鼠标悬停或键盘聚焦时显示整行，离开后隐藏并保留占位，无 hover 的触屏设备保持可见。替换旧「你 + 时分」行，只复制本条用户正文，不混入时间或附件元数据，不新增时间格式器、剪贴板实现或上游补丁。

会话切换沿用官方 `ui-session` 按 Session binding 保留快照、切换时立即选中对应快照的行为。完整 controller 依赖 DSH Cordis Host/session bindings，不能直接绑定 Allrice 租户 HTTP 历史；因此仅在既有 `useSession` 中补上最多 8 个会话的内存缓存、最近 2 个会话及悬停/键盘聚焦预加载。再次打开立即显示对应历史并后台更新；首次未加载的会话显示加载提示，不再残留上一会话。缓存按组织、工作区、用户清空，不写浏览器持久存储；旧请求、权限撤回和本地消息提交均有失效保护。原生会话树组件保持不变。后续官方提供独立 Session 数据源时优先替换该 HTTP 适配。聊天顶部旧“交互与任务记录”技术信息区移除，实际待批准动作与任务状态仍保留。

- 日期：2026-09-24；负责工单：[MET-154][met154] PR-4。固定候选兼容升级与图片转换局部退役已合并，Dev 普通任务、恢复及 M5 真实开发交付均已验收，临时配置已恢复；业务归属见各项原工单，模块化归 MET-155。
- Allrice 基线：`a77c640`；已核对 main 的 CI、Dev 已验收代码及全部开放 PR。
- 复核范围：当前 `0.1.1-rc.2` 源码 `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` → 已安装候选 `0.1.5-rc.3` 源码 `a4c74a91e06b00fe0b0937bde982170c526cc842`。
- `0.1.7-alpha.2` / `00102833dfaee1da9f48a3a8eae9d34005a75218` 只作为前瞻研究。下表所有上游链接固定到对应源码 SHA。
- 精确包差异、协议矩阵、迁移实测和发布阻断项见 [本轮升级基线](dsh-upgrades/met154-rc3-baseline.md)。PR-2 已完成受限组合、私有事件迁移和助手接口适配；实现与发布限制见 [候选兼容验收](dsh-upgrades/met154-rc3-compatibility.md)。`installedChannel=candidate` 本身不证明部署或晋级；实际 Dev SHA、真实账号/旧会话/重启及 MET-144 开发交付结果见 [PR-4 验收](dsh-upgrades/met154-rc3-dev-validation.md)。本轮 Dev 已验收，不代表 Prod 晋级。PR-3 的具体删除、接口差异与保留理由见 [复用收敛记录](dsh-upgrades/met154-rc3-reuse.md)。

状态含义：**保留**＝上游没有承担对应 Allrice 责任；**可复用待验证**＝有重叠但还不能删旧路径；**适配后替换**＝已找到替代接口，待通过同等行为验证；**已替换**＝删除旧路径的 PR 和证据齐全；**明确不接入**＝本轮不启用该执行面。来源存在不等于产品已启用，也不等于验证通过。本轮仅图片准入后的引用转换标记为“已替换”；所属生命周期适配整体保留。

以下记录保留 MET-154 当时的实现与验收事实，其中“本轮不接入”“临时配置已恢复”不构成后续默认关闭的政策。后续升级和能力接入执行上面的“默认开放”原则。

## ChatFlow 原生交付卡片与连续文档预览（2026-09-27）

预览状态修复：沿用原生 Dock 的当前标签判断，仅在可见的计划/修改审查中刷新动态状态；普通已发布文件和隐藏标签停止五秒轮询。读取错误独立于提交/对比错误，成功后清除过期读取提示；短暂后台失败保留已加载页面，权限撤销仍清除内容，首次失败提供重试入口。成果列表错误仅在列表展示，避免把可用文件误报为服务不可用。

固定 WebUI `0.1.7-rc.1` / `46a7f68b0922371ce7144b668b90e377d8e799f4`，复用 `ui-deliverables` 的 `PresentedFileCard` 和原生响应式卡片 CSS，以及已安装的 `FileTypeIcon`、`Menu`。官方完整插件的文件动作槽依赖 DSH Host 的工作区路径、事件订阅和本机应用打开服务；Allrice 浏览器已有鉴权文件对象与服务端交付事实，因此保留卡片的独立预览按钮、动作槽和原生布局，只将桌面 Host 状态接线替换为既有侧栏预览与鉴权下载。没有复制文件管理器或桌面打开服务；来源、源码哈希和最小适配补丁纳入 `dsh-ui:verify`。

Office 继续使用已接入的页面渲染与公式结果。所有已渲染页面共用现有 DSH `ZoomViewport`，保留原生适应宽度、比例菜单及手势缩放，删除逐页按钮和重复成功说明。Allrice 仅补灰色画布、白纸阴影、连续页间距及实际错误/截断提示；计算详情默认折叠，零公式不占一行。最多八页的既有预览限制仍明确提示，完整文件可从卡片菜单或侧栏下载。

## ChatFlow 原生正文与过程分组（2026-09-25）

2026-09-27 用户消息气泡补齐原生换行规则：现有 `MessageItem.module.css` 仍固定在 `b150a551`，直接展示文本时缺少长 JSON/URL 的断行及原文空白保留；官方 `ui-chat` 在 `46a7f68b0922371ce7144b668b90e377d8e799f4` 已由气泡设置 `white-space: pre-wrap` 和 `word-break: break-word`。Allrice 的 `userBubble` 薄适配仅补齐这两条原生规则，保留已固定的气泡尺寸、字号和源码校验；后续同步新版气泡时删除此适配。换行仅影响显示，不改变消息正文或复制内容。

正文直接使用 `@deepseek-ai/dsh-client-ui-primitives@0.1.7-rc.1` 已导出的 `MarkdownText`，退役 Allrice 的 react-markdown 正文渲染、重复排版 CSS 和自有闪烁光标。流式文字原样交给官方增量解析器，复用其已完成块缓存；不在每次追加时重新做 Allrice 全文 Markdown 解析。

回复/工具边界使用同版官方 `ProcessState`。该类未独立导出，沿用现有源码同步机制，登记固定提交 `46a7f68b0922371ce7144b668b90e377d8e799f4`、SHA 和补丁。补丁仅涉及导入适配、原样摘取两个工具状态谓词及移除无用 catch 变量。Allrice 将已有公开回复和中文步骤映射为原生节点；每段回复保留独立位置，工具组单独折叠，结束后不把中间回复藏入工作过程，也不搬动/重复最终回复。

保留的接入责任：用户级输出偏好（默认统一输出）、员工身份、中文公开步骤、总耗时、Allrice 鉴权文件链接及静态预览的外部图片限制。下载链接只在正文结束后按当前会话的真实成果列表适配；无可信文件匹配则不改写。服务端事件转换、持久化和 SSE 传输仍为 Allrice 实现，不能将此次展示复用描述成整条输出链路与 DSH 完全一致。

验证包含：分批真实浏览器消费 SSE、追加文字时已完成段落保持同一 DOM 节点、结束后回复位置不变、回看时不自动拉到底部、偏好关闭时不泄露中间正文、历史重载与文件预览/下载。源码校验纳入现有 `dsh-ui:verify`，Worker 锁文件依赖保持原值，不升级运行引擎。

## MET-159 PR4：员工代办应用连接（2026-09-24）

新建的成员应用连接直接使用 `@deepseek-ai/dsh-mcp-client@0.1.5-rc.3`，固定源码 `a4c74a91e06b00fe0b0937bde982170c526cc842`。先用未修改的发布包、真实本地 HTTP MCP 服务跑通匿名发现和 `ctx.tools.execute`，再接入 Allrice；没有另写 MCP 发现器、工具命名器或 Agent 循环。

`allrice-managed-native-mcp-v1` 只向原生 HTTP transport 注入宿主 `fetch` 和官方 MCP SDK `OAuthClientProvider`，并关闭断线重试。DSH 负责原生工具名、schema、注册与执行，官方 SDK 负责登录发现、注册、PKCE、换取及刷新凭据；Allrice 补成员身份、加密保存、网络边界、现有操作账本和普通成员的连接管理。工具输入 schema 原样保留，不能错误地套用 DSH 输出 schema 的较小子集。

员工已配置 `cloud.mcp.call` 即可为当前用户连接应用，不再先要求管理员创建连接、配置工具矩阵或重发员工。登录复用原生 User Questions 和既有持久化等待：完成后续跑原任务，等待释放 Worker，登录答案不等于批准远程写操作。用户可以断开、恢复或删除自己的连接；删除个人连接清除服务端凭据，共享连接只影响当前成员。界面不把排队或发现失败显示为连接成功。

旧 `client_kind=sdk` 连接继续保留原工具名、已冻结任务和审批兼容；新托管连接使用 `dsh`。只有旧连接与在途任务均迁移、名称与摘要对应关系验收后，才删除旧 SDK transport。上游直接提供宿主 fetch/authProvider 与禁重连配置后，移除本补丁。独立「已连接应用」页面与任务内登录已接入；MET-159 PR5 已将同一连接组件接入 MET-160 原生 Settings。成员可直接查看、登录、断开和删除；能力面板区分可按需建连与具体账号的实际连接状态。详见 [PR5 记录](allrice-2.0/met159-workbench-settings.md)。验收范围及第三方账号限制见 [PR4 记录](allrice-2.0/met159-managed-connections.md)。

## MET-157 Office 1.3.1：原生流程已接入（2026-09-24）

当前默认复用原样 DSH 格式指南、原样执行的检查脚本，以及 python-docx / openpyxl / pandas / python-pptx 工作流程。Allrice 仅接文件授权、隔离执行、版本下载、公式缓存与页面预览；旧 typed 编辑只保留历史冻结包兼容，不再并行扩写。三个旧切片已收敛为直接面向 main 的 PR #100，#98、#99 关闭并由它取代。

真实租户已完成此前固定编辑接口不能完成的 Word 样式/页眉、Excel 条件格式/图表和 PPT 图表/新页/讲稿操作。最终 Excel v4 缓存 20/40/60/120、预览两页，图表完整同页。验收还定位并用 Docker init 修复既有预览服务的子进程回收问题；未增加自有回收器或改写文件内容。完整结果、失败与修复边界见 [原生接入验收](../features/office/native-validation.md)。下面 PR1–PR3 记录是历史事实，不再代表当前默认实现或合并路线。

## ChatFlow 交付成果栏原生拖拽复用（2026-09-24）

复核 WebUI 固定版本 `0.1.1-rc.2` / `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` 的 `packages/client/ui-layout/src/client/AppFrame.tsx` 后，复用其 DragHandle 指针捕获、动画帧节流、拖拽起点及容器测量方式，并直接使用已有 `.detailsCol` / `.handle` 样式。MIT 来源与适配位置登记于 WebUI `upstream.json` 和 `THIRD_PARTY_NOTICES.md`，不增加依赖，不修改上游副本。

Allrice 仅补充产品接线：将固定 38% 右栏改为 360px–70vw 可调宽度，按用户/租户/工作区记忆宽度，支持双击或 Home 恢复默认、方向键调整和指针中断清理；窄屏继续使用原有抽屉。用户界面统一称“交付成果”，左右标题栏共用 56px 高度。验收覆盖实际拖拽、上下界、刷新与切换账号、断点切换、草稿保留和标题栏底边对齐；无需新增开关或管理员配置。

## MET-157 Office PR3 质量与预览（2026-09-24）

Office 1.2.0 默认接入独立 LibreOffice 计算与页面渲染，继续复用 alpha.2 的“重算—检查—交付”工作方法；没有移植 DSH Shell，也不重新实现公式引擎。普通与共享公式的实际结果回填原 XLSX 缓存，Word/PPT 原字节保留，租户工作台直接显示页面与公式错误。保持单一 Skill 和现有文件/版本/鉴权链路；没有新增管理员开关。

渲染子进程不能建立 IP 连接，不挂载租户凭据；预览按文件哈希缓存，重启后重建。数组/溢出公式及外链数据明确标为未检查。公式求值不代替业务核对，渲染成功不等于排版验收。真实 Dev 上传、原文件修改、公式求值、Word/PPT 成果交付、版本下载和预览重启恢复已通过，详见 [Dev 验收记录](../features/office/dev-validation.md)。保持 Office 默认开放；三个堆叠 PR 合并后再关闭 MET-157。

## MET-157 Office PR2 复用复核（2026-09-24）

继续固定 `00102833dfaee1da9f48a3a8eae9d34005a75218` / alpha.2 的 Office SOP；引擎仍为 rc.3。本次把“检查原文档、保留原包、定点修改、公式与缓存分开处理”的方法接入现有 document.read / export.create：单一 Office 1.1.0 默认提供 Word 原生表格、Excel 多表与公式、PPT 可编辑图表，以及原文件文字/单元格修改。没有新增后台能力开关；发布新员工版本后直接使用。

执行仍复用 Allrice 已有 docx / ExcelJS / PptxGenJS / JSZip，增加固定版本 xmldom 作 XML 定点修改。没有复制或安装上游 Python 执行器，也没有另建文件库。实测二进制保留、权限、版本与恢复证据见 [Office README](../features/office/README.md)。公式重算、视觉验收和真实 Dev 闭环留在 PR3，不能用包结构成功替代。

退役条件：由 Allrice 的薄适配把受控文件对象映射到原生任务输入，并把产物接回原文件与版本链；原生路径通过同一组二进制/权限/恢复回归后，替换重叠的本地格式适配器。不要求上游原生理解 Allrice 专有文件对象或租户模型，也不以缺少该接口为由继续重写文档能力。回退需同时恢复应用、Office 1.0.0 目录与员工已发布版本；历史文件与冻结包继续保留。

## MET-157 Office 增量复用（2026-09-24）

基于 main `5dddcc3` 开始单一 Office Skill 接入；#96、#97 已先合并且 main CI 4/4 通过。Office 1.3 改为原样复用固定 alpha.2 的三份格式指南和实际执行的检查脚本，补齐 Python 文档库与现有隔离沙箱接线，DSH 引擎和插件组合不变。新配置合并 document-analysis、structured-deliverable，已发布和在途包继续使用原内容；管理员选中后自动装配现有工具，没有新增 Office 开关。

当前交付边界、来源、PR2/PR3 缺口和回退方法见 [Office README](../features/office/README.md)。旧入口只从新配置选择中退役；旧内容保留到所有历史版本与会话无需恢复之后，不能仅因新增 Office 就删除。当前默认通过原生 Python 工作流程编辑文件；Allrice 保留文件授权、版本、公式缓存和页面预览。旧 typed Office 编辑仅兼容历史冻结包，不再并行扩写。实际复用的是指南、检查脚本和文档库工作流程，未安装完整上游三技能提供器。

## ChatFlow 排队消息原生复用（2026-09-24）

固定 WebUI `0.1.1-rc.2` / `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`，复用 `QueueDock.tsx` 的单条直显、多条折叠、等待操作回执交互，原样引入 `QueueDock.module.css` 和六个原生图标。来源及差异记在 WebUI `upstream.json`。

Allrice 只把原生组件的会话 Store / updateQueue 换接现有 PostgreSQL followups / commands：删除、取回编辑和立即引导都修改原队列项；编辑带回已有附件，已有草稿保留。未执行消息不进入聊天流，也不提前计入模型历史。Worker 继续负责 FIFO 消费，浏览器关闭和刷新不影响任务，无新调度器或开放开关。立即引导沿用原生输入采纳凭据，收到请求不等于模型已经采纳；带附件消息按下一轮完整处理。

替换旧“发送方式”下拉框和排队 assistant 占位。原生上游使用行内编辑，Allrice 为文件附件改为取回完整输入框；服务端对已领取消息拒绝编辑/撤回，并在撤回已释放队首时唤醒下一条。数据库隔离集成与浏览器验收覆盖队列持久化、FIFO、编辑附件、撤回、原生引导和会话切换。

### 会话思考与执行状态折叠（2026-09-24）

固定 WebUI `0.1.1-rc.2` / `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。先复核原生 `ReasoningRow`、`DisclosureRow`、`ToolCallTree`：直接引入 `DisclosureRow` 组件、未修改的两份 CSS 与 Think 图标，复用鼠标/键盘折叠和运行中扫光动效。导入路径及字符串类名连接仅做本仓适配，来源记录于 WebUI `upstream.json`。

Allrice 的公开事件不含原生推理正文，因此不伪造 ReasoningRow 的正文内容；原生 ToolCallTree 按单次调用组织，没有 Allrice 点分工具名或跨调用统计。只补中文工具分组、调用次数及服务端耗时接线。工具累计时间明确为累计值，缺少起止事件不补零。同一 call ID 的原生/标准回执只计一次；失败原因、未确认结果和真正的子助手保留在折叠过程，需审批的操作面板继续直接显示。

默认开放，无额外开关：日常任务不显示空助手壳；回答首字出现后隐藏思考/执行微状态。验收覆盖 9 次行情查询合成一行、键盘展开、真实员工名称、手机布局、服务端等待计时及失败恢复。回退可整体撤销此展示适配，不改变原始事件、任务时钟或执行授权；上游提供同等聚合接口后替换本地分组逻辑。

## 已登记的适配责任（无物理补丁）

`patch-ledger.json` 的 `patches` 只记录当前一代 DSH 的协议扩展；每项都必须是 `protocol-extension`、指向 AllRice 自己的文件并在本页有入口。DSH 包本身不打补丁；Next 等非 DSH 补丁另行治理。

`pnpm dsh:verify` 同时检查单代规则与本清单，并输出 `dshPackages` 和 `dshVersion`。回放场景列表仅表示已配置，不代表本命令执行过这些测试；真实回放继续由已有 CI/验收入口执行。

以下条目的复核日期/版本统一继承“本轮复核”。测试路径以仓库根目录为起点。退役必须在同一 PR 删除相应旧实现、更新机器清单并留下验证结果；一项适配中的少量机制可退役，不代表它承担的整项治理责任可以删除。

### allrice-durable-native-question-wait-v1

- MET-231 首轮复核 F1–F4：可信程序来源与原 Run/pause 编入 Host 生成的顶层 questionId，复用 strict v1 checkpoint 字段，不新增 PG 列/表或日志字段；legacy 在采纳答案前校验原 pause；模型 item/call ID 不能指定此顶层 ID。旧无标记题按普通题读取、不能 decide 当前 pause，进度门须重新提问。当前 Run 的程序题随公开 `turn.started` 更新网页投递 turn，Host 只接受当前 turn；PG 消费精确 Run/题/投递 turn 的 `question_resolved` 回执，已采纳后跨同 Run turn 仅凭既有 turn 记录收据结算，不扩大旧题提交权。回归包含真消息 API→PG claim→production Host/adapter→PG consume 与双子级结算换 turn。

- MET-231 原生恢复共同前置（2026-10-30 用户选择先恢复普通对话委派、网页控制与旧 Workflow 后接）：DSH 0.2.1-rc.2 `subagents.waitForChildren(exactRoot)` 负责创建/释放/结算屏障；AllRice 仍拒绝任何其他 live Agent，随后已受理 typed input 结算与同根/同题/当前 Worker 租约重验，才写原 legacy checkpoint/cancel；根 idle 后 finite accounting flush 再验租约，避免等待正被该题阻塞的根迭代器。只加门卫和租约接线，不等被题阻塞的整根 `session/wait`，不为 park 强停子级；30 秒触发值和恢复协议不变。守护：`native-subagent/question-runtime.test.mjs`、既有 `task-wait-native.integration.test.ts` / `task-wait-worker.integration.test.ts`；MET-225 更新 L07。

- MET-228 legacy 停放后停止（2026-10-30 主会话核定 A+B；Dev c99 复现）：DSH rc.2 公开 `agent.cancel({kind:'user'},{keepInbox:true})` / `whenIdle()` 结束旧轮，普通新输入用 `agent.followup()`；不增加 wake 或答案路由。AllRice 统一终态事务在既有 root→clock→Job→runtime 锁序内，按完整租户/属主/会话与同一 active Run 释放停放遗留投影，使用被锁 runtime 的 owner，不要求 Job 仍有 worker；绝不清新 Run 的归属。既有 claim FIFO 回退仅识别同属主终态 Run 且其唯一 Job 已终态完成、五项执行归属全部清空的历史残留；只有终态回执、仍持 owner/lease（即使已过期）或 Job 尚非终态时继续等原生 release。不新建扫描器/表/状态、不重发消息。属于租约和单向账本，原生物理 close、授权与超时依据不变。守护：`task-native-wait.integration.test.ts` 的无 owner/换 owner/超时/撤权/FIFO 回归，以及 `run-delivery-worker.integration.test.ts` 的真实30s park→stop→普通新轮；MET-225 修改 L07 legacy旧等待修复补记，不为旧30s桥本身补依据。

- MET-210 PR4（2026-10-28 主会话草稿任务）：平台 settings 中的 `native_question_mode` 默认 legacy；timed 直接配置 `dsh-tool-ask-user` 的 mode/timeout，默认偏好省略 timeout 跟随 DSH。`attachWait` 和 `ASK_TIMED_OUT` 复用 PR3 回答方，题 ID 使用原生 Session + callId。`sessionProjections.stateOf(..., 'userQuestions')` 在原生事件和 ensureRoot 后单向投影到 PG；不写第二份折叠器。DSH settled 只有 callId/answers，题正文保留自首次原生 active 快照；native_present 只镜像当前投影成员资格，原生移除不删除首次题和撤权事实；source_run_id 保留首次出现的 Run，停止只撤销该 Run 的题。closed_at 仅是停止/开关回拨的授权门卫，不改原生状态。平台切换和有效偏好进宿主指纹。维护/Workflow 程序题沿用 PR3 边界；旧助手分支由 PR2b 删除；生产 detach、迟到回答路由仍待 PR5/PR6。迁移 0226 为加法式；部署后旧版本不认识迁移，按部署工具门禁禁止直接回滚，配置回拨只撤权、不回退 schema。守护：native-questions.integration、runtime-pool、allrice-question-detach-native；MET-225 拟修改“问题卡等待时长”和“问题卡旧实现”。
- PR4c（2026-10-28 本轮授权）：工作方法/定时授权接受 DSH `tool/result` 的 question_resolved 或 `user-question-reply` 的 question_replied，绑定完整题 ID、原生 settled 答案摘要及已消费命令属主，不要求原提问 turn。现有精确确认标签（包含卡内 custom 精确标签）、有效期和其他校验不变。普通聊天文字无题目证据不能授权。`closed_at`/平台 legacy 阻止旧题提交，返回 question_expired，未加迟到路由。AllRice 产品 UUID Session 前缀的完整 native 题 ID 不截断、不受 legacy 显示 ID 长度限制；legacy ID 上限不变。程序题不进入原生投影，保持原 UUID 与证据路径。此段属权限门卫/单向审计，原生日志词表/字段不变，reader 的 messageId/questionId 原本就是无长度上限 text（与基线文件 SHA256 相同），仅入口完整题 ID schema 放宽，故 journal current/readsFrom 保持 1；描述按兼容入口变更更新，旧 corpus 和长 ID 实际原生日志均验证读取。私有 ask_user 收据删除留 PR9。
- PR4 独立补测修正（2026-10-28）：启用必须将首次原生题正文及 source_run_id 与准备凭证的题/来源相等绑定，后续消费 Run/turn 仍可不同。mode 回拨同事务撤权并刷新受影响会话的活跃 Run 时钟/截止时间；投影和授权事务先持 mode SHARE，再持既有业务或 703→root→clock→Job 锁，回拨持 mode UPDATE 后按稳定 Run 顺序获取上述运行锁。停止不反向获取 mode 锁。确定性锁等待用例覆盖回拨/投影、回拨/停止收尾、授权与回拨两种提交顺序；不新增审批语义。
- PR4 独立 r2 修正（2026-10-28，本轮主会话确认）：后续 Run 消费原生定时答案时，once/recurring 从已核验题目的首次 source_run_id 读取同主体/会话的原始人类请求，复用现有内部消息排除；频率解释与精确确认卡比较沿用该原文。当前消费者仍须持有效租约，答案仍需 settled/属主/摘要证据且只准创建一次；不要求首次 Run/turn 继续存活，不引入新审批或状态。
- ID：`allrice-durable-native-question-wait-v1`；归属 MET-153；**保留**。
- Allrice：[allrice-dsh-waits.mjs](../../apps/worker/dsh/allrice-dsh-waits.mjs)、[allrice-dsh-inputs.mjs](../../apps/worker/dsh/allrice-dsh-inputs.mjs)。负责静止提问检查点、确切答案采纳、同 Run 续接和派发未知不重放。
- 上游：[rc.3 Session 持久化][persistence]提供历史格式迁移和恢复机制，不承担 PostgreSQL 租约/问题授权。[v0 迁移校验][v0-validation]拒绝未知历史事件，单纯向当前词表注册私有事件不能解决这个迁移问题。
- 退役条件：候选原生机制覆盖静止边界、持久答案幂等及续接意图，且 Worker 权威检查仍在；当前无整项替代。先完成显式私有事件迁移，不删除事件或标记 ignorable 来通关。
- 验收：`dsh-legacy-replay.test.ts`、`task-wait-native.integration.test.ts`、`task-wait-worker.integration.test.ts`，以及数据库 `task-native-wait.integration.test.ts`。回退需同时保留私有事件读写能力与原格式副本。
- MET-210 PR3（方案 v4.5）：连接应用、进度暂停这两类程序题复用 `dsh-user-questions` 的 `askTimed` / `attachWait` / `ASK_TIMED_OUT`；从展示时起计时，以 Run 冻结的属主偏好和 Worker 空闲回收释放点为准，释放点 0 保留阻塞 `ask`。模型工具的 timed 配置和旧 30 秒挂起留给后续 PR。
- MET-210 PR2b 删除 `allowAssistants` / `ALLRICE_ASSISTANTS_ENABLED` 和旧助手阻塞程序题分支。平台维护修复 Run 按既有 `repairTask` / `ALLRICE_MAINTENANCE_OUTPUT_TOKENS` 保留阻塞，Workflow 边界不变。到期与 detach 一样先结算已受理回答的写盘。守护：`allrice-program-questions-native.test.mjs`、`timed-progress-worker.integration.test.ts`。

### allrice-durable-progress-guard-v1

- MET-231：直接复用同代 `dsh-user-questions` 的 `DELEGATED_CALLER`、程序问答和 `dsh-subagent` 的父子消息/结果。child 的连接工具保留真实 `needsLogin` 给实际父级，不能替 child 冒充 root 或当真人授权。进度中间件复用 RunAdmission 的真实 ownership 找根；内部 Symbol 来源标记与 Run/提问 turn/pauseId 只作门卫，模型可控的题 ID 不授予 idle 回答或 pending 成功。当前 Run 的真实程序题经原 typed input 和 Worker 租约复核可在根 idle 时回答；到期先封新调用，再由 adapter 关闭确切 Host、公开 drain/账本 flush，沿原 Worker 当前 pause/lease 核验返回等待。根已 idle 时不再依赖另一个 turn/end；未知关闭不伪报成功。保留原 pause 承接、取消和其他问题等待语义，不改 Workflow 分支、生产 profile、timed/detach 或 PG 状态。守护：`native-subagent/question-runtime.test.mjs`、`timed-progress-continuation.integration.test.ts`；MET-225 更新 L08 和子级未决真人需求行。

- ID：`allrice-durable-progress-guard-v1`；归属 MET-153；**保留**。
- Allrice：[allrice-task-progress.mjs](../../apps/worker/dsh/allrice-task-progress.mjs)、数据库 `task-progress.ts`。模型/工具事实交给持久暂停策略，用户选择继续/取消；调用次数仅统计。
- 上游：[重复工具提醒][repeat]是模型提示策略，[Goal driver][goal]是目标推进机制，都没有等价的租约、跨进程暂停状态和精确决策账本。
- 退役条件：上游提供可接入现有权威状态的等价事实回调与暂停机制，并覆盖失败、空进展、取消和重启；PR-2 已适配 `user-questions/request`，保持原策略，不引入固定调用次数上限或第二套 Agent 循环。
- 验收：`task-progress-native.integration.test.ts`、数据库 `task-progress.integration.test.ts`。回退保留暂停记录和原决策版本，不通过清空状态“恢复”。
- MET-210 PR3：非旧助手 Run 在 `llm/stream`（消息入历史之后）出卡，到期凭宿主 `session.user-question-pending` 和本 Run 未决暂停账本以 `succeeded + waitingForUser` 收尾，跳过经验抽取；下一普通 Run 首次建行时在同一事务搬移同 org/workspace/session 的最近到期暂停，源 Run/job 必须 succeeded、暂停未决未取消且已释放租约；停止、失败、超时和仍在跑的 Run 不承接（主会话 10-27，Opus/Fable 首次复核）。平台维护修复 Run 不承接，保持原检查位置与阻塞 ask；MET-210 PR2b 删除旧助手分支。非维护 compaction 先 flush 工具回执，再做模型 admission；只跳过出卡及到期抛错，第三次失败落账后仍拒绝模型调用。新卡或回答清除 adapter 旧到期证据。Workflow 模型/技能步骤保持原阻塞程序题，不 pending、不以 waitingForUser 结束、不跨 Run 承接；已有 Workflow 路由分支通过既有释放点 0 选择阻塞 ask，冻结偏好仍传入宿主。回答前保留 Run/租约，回答后正常完成，不新增 Workflow 状态或字段（主会话 10-27 第二轮复核决定；跨 Run 续接 Workflow 不在 PR3 范围）。
- 依据与接缝：用户 10-27 要求到期保持暂停；`dsh-user-questions` 0.2.1-rc.2 README 的 Role / Runtime invariant 只覆盖工具题投影，程序题不持久；跨 Run 搬移属现有门卫与账本的作用域修正。守护：`timed-progress-continuation.integration.test.ts`（热/冷宿主、继续/取消/再次到期、隔离反例）、`timed-progress-worker.integration.test.ts`（真实 Worker 的二轮接线、维护边界及 Workflow 阻塞后正常完成）和 `subscription-worker.integration.test.ts`（Worker 账本确认与成功收尾）。回滚保留两端历史及决策行，不反向复制暂停。

### allrice-durable-task-clock-v1

- ID：`allrice-durable-task-clock-v1`；归属 MET-153；**保留**。
- Allrice：[allrice-task-progress.mjs](../../apps/worker/dsh/allrice-task-progress.mjs) 通过公开模型/工具事件向 Worker 投影普通 Run 活动；权威计算在 `packages/database/src/task-clock.ts`。
- 上游：[子助手的 idle、结算与 Inbox 状态][subagent]可提供更精确的事实，但不拥有 Allrice 的 PostgreSQL 时钟、并发参与者和跨 Worker 租约。
- 退役条件：可以替换重复的 idle 探测，不能迁走权威时钟。需要证明助手活跃/工具未知时不暂停、多个参与者时间取并集、等待不耗预算、接管不重置。
- 验收：`task-clock.integration.test.ts`、`task-wait-worker.integration.test.ts`。回退读取同一时钟表，不能另起内存计时器。

### allrice-repository-review-native-v1

- ID：`allrice-repository-review-native-v1`；归属 MET-210；业务工具，保留普通独立仓库复核 Job 的门卫/账本。
- 依据：用户 2026-10-28 / 29 PR2a 独立复核修复派工；DSH `@deepseek-ai/dsh-tools@0.2.1-rc.2` 的公开 `defineTool` / `ctx.tools.register` / `agent.ctx.tools.restrict`。当前 restricted profile 的 tools 服务由既有 Host 注册 `platform_repository_review`，以 `allrice/tool-call` 回到 Worker；Agent 创建时将完整继承工具集限制为此工具，原生 `ask_user_question` 也不可用。
- AllRice 声明与 Broker DTO 严格校验保持一致，identity、冻结候选、作者排除、原始 CI pre/postflight、意见与交付仍来自普通 Job 与不可变成果；Job → 身份/凭证锁序和等待后租约复查与 heartbeat 一致。明确停用员工通过既有 Job `cancel_requested_at` 永久撤回已完成 proof 权限，保留成功历史；重新启用不清除标记，自然租约过期不撤销历史证据。DSH 拥有原生 function call、工具结果和后续模型步骤；不使用 XML 工具循环或旧 assistant report。
- 来源与升级：本项修改原生 `.mjs`，**执行包内容 ID 会变化**，既有 artifact/nativeTools 指纹随实测内容更新；未升级 DSH 依赖或修改上游。升级时核对公开工具注册、声明参数、Host/Worker allowlist 与 Broker 结果。
- 验收：`dsh-repository-review-native.test.ts`、`test/p25/repository-review.integration.test.ts`；真实 Worker → Host → PostgreSQL 的完整工具名单、越名单提问无问题卡/挂起、function-call 转发及两连接 heartbeat/工具锁交错；真实停用入口与完成/proof 消费双向交错，重新启用仍拒绝旧 proof。上线仍须独立复核、CI 和发布后 Dev 验收。

### allrice-development-workflow-v1（已退役）

- MET-210 PR2b 删除旧开发协作工具、角色协调代码、随包 Skill 与专属 UI/API；执行适配从 patch-ledger 删除。2026-10-29 主会话按 `decommission-gate-plan.md` §4 选择先退役执行器：8 张专属表与所有原行/引用仍是被动历史，在收敛台账如实登记，数据销毁后移。
- 原生 DSH 子代理的状态与生命周期不由 AllRice 重建。本次不提前启用 PR3 原生子代理；仓库复核已是普通独立 Job，见 `allrice-repository-review-native-v1`。
- 0229 只禁用精确内置 Skill ID `d78b3556-821a-5550-bf13-d9dd84b9bbe0`。普通历史发布版本引用的冻结 bundle 保留，不再作为可装配入口。

### allrice-assistant-required-delivery-v1（已退役）

- MET-210 PR2b 删除旧 wrapper/controller、quiet report 私有调用、助手 report/采纳/结算权威；9 张专属表及其全部行、费用与 failed/unknown 原样保留为待销毁被动历史，`compatibility.json.privateInterfaces` 清空。
- 普通 Run 交付沿用 DSH `runOnce` 的候选接缝与普通 Job 当前租约、不可变成果核对；无第二套 Agent 状态机。必须与 PR1c #635 同次发布，不能单独部署资格放开或残留旧执行器。
- 0097 通用订阅不可变守卫、0146/0147 通用记录守卫、runtime roots/budgets/operations/reservations/run_links 及普通历史/文件保留。本阶段不删旧 child、专属成果或任何 FK 必需来源，不新增旧表生产查询/兼容层。破坏性候选与完整测试冻结在 `2970378c58a5550cd8fc825776e2e50841fc9d72`；其停止与共享引用门禁属于后续数据销毁审查，不装入当前活动迁移。
- `0229_retire_legacy_assistant_configuration.sql` 仅移除旧配置键并禁用精确内置 Skill；它仍前移回滚下限：旧二进制的 strict schema 要求 assistants，且不认识新迁移名，不能因旧表仍在就直接回滚。正常停写/快照/原样副本演练仍由发布负责人执行；保留数据不证明旧 Host 停止，历史 stop 缺口及17表销毁仍未完成。当前结构测试为 `assistant-configuration-retirement.integration.test.ts`；真实 before/after 两成员群体见 `retired-assistant-delivery.integration.test.ts`，不再宣称17表消失。

### allrice-workbench-native-changeset-v1

- ID：`allrice-workbench-native-changeset-v1`；归属 MET-147；**保留**。
- Allrice：[allrice-workbench-native-tools.mjs](../../apps/worker/dsh/allrice-workbench-native-tools.mjs)。向模型表达已有 Broker 的提案格式，不能直接应用到设备。
- 上游：[Tool presentation][presentation]可复用描述/展示机制，不拥有 Allrice 目标绑定、Bridge 授权、精确审批、artifact 身份或文件 CAS。
- 退役条件：上游声明能力能无损描述既有契约，且模型看到的 schema、Broker 校验与交付血缘完全一致；平台执行边界不退役。
- 验收：`dsh-protocol-runtime.test.ts` 中交付血缘契约、`workbench-native-tools` 相关测试以及 changeset/Bridge 回归。回退保留未决审批的原始目标与内容哈希。

### allrice-bounded-native-search-v1

- ID：`allrice-bounded-native-search-v1`；归属 MET-150；**保留**。
- Allrice：[allrice-jsonrpc-runtime.mjs](../../apps/worker/dsh/allrice-jsonrpc-runtime.mjs) 的 Broker 搜索回调；负责限额、审计、结果裁剪和完整结果文件。
- 上游：[tool-web][web]具备搜索/网络工具；具备相同工具名不代表满足租户来源策略和持久结果授权。
- 退役条件：上游可挂接现有 Broker，完整结果仍为受控 artifact，重复调用与超大结果验证通过；不允许原生直连绕过审计。
- 验收：`dsh-adapter.test.ts` 中 native search 单 turn/工具事件路径及现有搜索 Broker 测试。回退复用已有操作身份，结果未知不重试副作用。

### allrice-jsonrpc-lifecycle-v1

MET-229 PR3b-1a adds an internal `session/subagent-summary` read for the existing Host's exact root. `allrice-native-query.mjs` composes public 0.2.1-rc.2 Session/query/projection/subagent services; exact reads use `openAt: never`, without a search index. Catalog/header/own-descriptor checks and text-only final output are SaaS gatekeeping/display; each native cut keeps live/prepared provenance. Prepared synthetic closers and native inactive never prove activation completion, and cumulative fork usage is not billing. The separate cold composition installs no Agent, model or writer. Tests: `allrice-native-query.test.mjs` and the actual Host fixture; retirement when the public SDK exposes equivalent scoped summary reads. No new private interface, PG mirror, external endpoint, tenant routing or delegation activation; those gates remain in PR3b-1b/PR3d. Reverting this read surface does not grant an older generation permission to write current logs.

MET-229 PR3b-1b exposes that persisted summary through the existing authenticated Web/Worker transport. Gatekeeping resolves the current owned business Session, tenant/workspace, immutable origin and native pin, then rechecks authentication and the complete target after reading. Storage wiring selects only the deployment namespace and approved same-generation reader. Public JSONL `open(..., 'read')` supports a persisted prefix beside an active writer: no owner/close admission is needed, and this endpoint always reports prepared/unknown. No execution, Job/binding write, live routing, retry layer or new private API is added. This is root-approved option A (2026-10-30), not delegation/UI restoration; live control remains PR3c and activation PR3d. Tests: `native-subagent-authorized-query.integration.test.mjs` plus the original E1/E2/E8. These SaaS authorization checks remain necessary even if DSH supplies the summary DTO directly.

MET-231 PR3c C1 now prefers the existing local Host after scope, root-origin, pin and business-generation checks; the Host rechecks its exact Agent/Session/epoch. This is root-approved gatekeeping and one-way display (2026-10-30 C1 task), not a second lifecycle owner. Reads never acquire/touch/lease, and closing or unconfirmed Hosts refuse the hot read. A local miss retains the original prepared/unknown reader, without claiming global coldness or forwarding to other Workers. Nullable `running` comes only from an exact live Agent's native status, separate from residency `activity`; title uses the public `foldSessionTitle` on the exact own suffix. The initial task excerpt is the first own user-message text block, matching the native tool's prompt block and excluding appended continuable instructions. Diagnostic nodes remain visible. No PG state, private import, model/title generation, stream, UI or control is added. Tests extend the real Host and authorized Web/Worker entrypoints; Dev hot/cool verification remains required before declaring the panel delivered.

MET-226 删除初始化中退役供应商的专用拒绝分支。供应商仍由 `@deepseek-ai/dsh-llm-pi-ai` 的 `providers` 配置声明；恢复由 DSH 原生模型解析处理未配置路线。此次不修改 profile、Codex 设置、助手状态或生命周期。

- ID：`allrice-jsonrpc-lifecycle-v1`；归属 MET-85；**已替换**（图片准入后的有序引用转换）；生命周期扩展保留。
- Allrice：[allrice-jsonrpc-runtime.mjs](../../apps/worker/dsh/allrice-jsonrpc-runtime.mjs)、[allrice-dsh-runtime-compatibility.mjs](../../apps/worker/dsh/allrice-dsh-runtime-compatibility.mjs)。承担发行身份、Broker、会话恢复、压缩和 typed input 的受控桥接。
- 上游：[SDK server][sdk] / [wire types][wire]新增 inline image admission、初始化就绪和 reasoning effort 校验，但 SDK inline image 不传递 `name`，不能直接替代现有有名附件。PR-3 改用 rc.3 新增的 [AttachmentStore.admitPromptContent][attachment-admission]，复用原生准入及有序引用转换，并删除 `admitDshPromptImageBlocks`。上游握手版本仍为 `0.0.1`，不能用它替代 Allrice 发行版本核验。旧 `Session.events` 读取及内容事件格式已有变化。
- 保留范围：`prompt` 只把现有 wire images 标记为原生图片片段，保留 display name；SDK 继续创建消息身份与排队。租户授权、冻结附件及校验和仍在 Allrice。SDK 覆盖名称后才考虑删除这层 wire 桥接，不开放默认工具组合。
- 验收：`dsh-images-native.integration.test.ts` 覆盖真实存储拒绝边界、整批拒绝、名称/顺序、消息 ID 与进程重启；已纳入 `dsh:golden-replay`。实现与验证见 [PR-3 记录](dsh-upgrades/met154-rc3-reuse.md)。回退此局部替换可在相同 rc.3 构建恢复原 helper；这不授予 v3 历史降级到 rc.2 的资格。

MET181 公司组合验收发现固定 `dsh-tool-ask-user@0.1.5-rc.3` 的 Consumer 未将 `detail` 传给原生 `userQuestions.ask`，完整公司/部门影响说明因此被数据库精确确认校验拒绝。AllRice 的 [method question 适配](../../apps/worker/dsh/allrice-method-questions.mjs) 仅保留同一 live Agent 最近一次服务端 prepare 回执；原生问题的 ID、正文、标题、选项与单选标志完全一致时，补回唯一缺失的说明。新准备、过期、取消、关闭、恢复和首次提问会失效旧缓存；问题通知与原生等待检查点保存同一完整内容。缓存不是批准，数据库仍校验当前候选、测试、权限及真实答案采纳证明。没有更改上游包、通用问题大小或提问/等待协议。

回归包含原生 prepare→ask→完整通知→落盘等待→新进程恢复→一次答案采纳与续办，以及篡改、过期、跨 Agent、迟到回执和二次使用拒绝。上游固定版本直接保留 `detail` 后，经同一回归可删除此有界补字段逻辑；不能删除 AllRice 的精确批准边界。

### allrice-final-delivery-v1

- ID：`allrice-final-delivery-v1`；归属 MET-184；**保留平台交付适配**。复用固定 `0.2.1-rc.2` 的公开 Agent、turn、消息日志、steer 和工具 middleware；不修改 DSH 核心、不增加另一套 Agent 循环。DSH 不持有 AllRice 成果对象、当前权限或业务完成事务。
- MET-210 PR1b 来源端口：不开助手的根 Run 通过通用 job/member/conversation/native binding 权限闭包读取 `turn.started`，不查助手表或 `run_links`。原生持久消息核验后的 proof 与该组来源锚点绑定，`completeJob` 重读并拒绝来源变化；资格仍由后续 PR1c 与旧层删除同窗放开。
- Worker 将当前根 Run 的真实成果版本、授权与 Office 字节检查事实交给独立的 Markdown/GFM 链接检查器。独立路径复用 SDK `session/wait`，停止并等待输入投递，随后以公开 `Agent.runMaintenance` 持有当前日志；私有 proof 绑定原生消息、序号和 Run 来源，直到 Job 同一事务重验权限、租约、来源与事实摘要。模型正文、工具参数和公开事件不能签发该凭据。
- 独立交付的 `active_turn_id` 保留到 `completeJob` 原子重验与终态释放；原检查点继续保存，但仅凭已注册完成守卫，在写前和写后复核同一来源、答复和租约。用量/压力仍记录，不新增压缩；失败、取消由既有所有权清理，未采用独立交付的普通路径保持原检查点边界。
- MET-210 #632 独审修复：真实通知订阅覆盖公开 wait、输入暂停和候选内部的最终 wait；来源读取等待同一事件队列落库，后代结算唤醒的根 turn 不从 journal 补造 PG 来源。交付失败保留已完成调用与中断调用的可信用量小计及完整性，沿既有 Run/attempt 私有凭据进入路由与模型账本，不重复累计、不把未知用量当零。
- 候选拒绝不撤销公开 wait 或候选来源请求已确认的用量完整性；新 turn、进程丢失、事件处理失败仍保持未知。原生 runtime-progress 等待经既有 PG 暂停/租约校验后走原等待出口与检查点，不要求最终成果 proof；普通答复丢失 proof 仍失败，不从缺失回执推断等待。
- 既有成果已就绪而答复链接缺失、无效或正文为空时，Worker 在根 `session/wait` 后发起同一 Agent/AllRice Run/模型最多一次文字修正。公开 `steer` 的平台来源 notice 产生一个新原生 turn，不是人工消息或新业务 Run；不能在 `agent/turn-stopping` 内等待当前根。复用原内容授权、任务进度记账和执行取消信号；工具、重试和压缩被拒绝。原答复和成果不改写，已有效答复不增加模型请求，Worker 收尾不再投递迟到输入。旧助手同 turn 修正/独立预留分支在 PR2b 删除。
- 新 Run 的检查协议按独立批准的精确 artifact ID 冻结；旧包/旧 origin 保留原协议。冷恢复只能由当前 Job/lease/turn 持久事实重建完成边界，不能用“最后一条回复”猜测归属或重新发送原任务。
- Office 首交沿用原 checker、publisher 与版本链：真实保存字节中的公式缓存缺失、错误或不完整不能记完整交付。同系列有效修订可解除旧版义务，常数版本不能消除已观察到的公式义务；旧版仍可下载。此技术检查不证明金额、公式语义、缓存新鲜度、视觉质量或全部业务要求。
- 回归：`native-subagent/final-delivery.test.mjs`、`p25/run-delivery.integration.test.ts`、`p25/run-delivery-worker.integration.test.ts`、`final-delivery-commit.integration.test.ts`、`final-delivery-references.pg.test.ts`、`office-first-quality-publication.integration.test.ts`。旧助手专属冷恢复、模型预留和 rollout 测试随旧执行层删除；普通租约、撤销、来源并发和 Office 缓存边界保留真实 PostgreSQL 回归。普通资格放开 PR1c 必须与 PR2b 同次发布；两成员升级和问题卡回执以最终组合 SHA 单独验收，不能以删除分支的定向通过代替。
- 退役条件：上游提供可绑定同一持久 turn/当前租约且可组合 AllRice 事务提交的公开完成边界，并通过输入竞态、冷恢复、取消/未知用量、权限撤回、原字节/旧版本和普通网页交付回归；可替换对应适配，AllRice 成果与权限事实仍由平台负责。

### 随 0.1.x 退役的条目（2026-10-25，MET-221）

`dsh-admin-webui-private-entrypoint-v1`、`allrice-admin-authenticated-origin-pnpm-v1`（管理员 WebUI 与其 client-connection 补丁）、`allrice-private-session-migration-v1`（0.1.5 格式迁移与 JSONL 持久化补丁）、`allrice-managed-native-mcp-v1`（由 `allrice-managed-native-mcp-public-v2` 取代）和 `dsh-pi-ai-premature-websocket-close-v2` 只服务于 `0.1.5-rc.3` 的独立管理员与保留主机，已与该代一起删除。历史说明见 git 历史和 tag `archive/dsh-admin-0.1.5`。

## 值得复用的上游能力

| 稳定 ID / 能力                     | 上游存在性与 Allrice 当前状态                                                                                | 决策、验收与退役条件                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cap-agent-team` / 协作开发        | [旧源码][old-team]已有 private Team 实验，rc.3 已公开发布；Allrice 未挂载 Team，已有受控 message/report/stop | 可复用待验证。优先 mailbox 幂等、版本 CAS、事件等待。只有同一候选测试/审查/交付链不退化才替换机制；不替代跨进程队列或上线 Teamwork 产品模式。                                                                                                                                                                                                                           |
| `cap-sdk-image` / 图片准入         | rc.3 [SDK][sdk]新增 encoded-image 准入；Allrice 已有附件桥接                                                 | 适配后替换。通过附件顺序、伪 MIME、超限及撤权路径，再删除重叠代码。                                                                                                                                                                                                                                                                                                     |
| `cap-compaction` / 压缩            | 旧版已有 compaction；Allrice 已调用 `ctx.compaction.compactNow`，不是新能力                                  | 保留原生复用。验证新 [压缩策略][compaction]的安全区间、模型路由、手动 busy 拒绝和上下文投影；不自建摘要主循环。                                                                                                                                                                                                                                                         |
| `cap-plan-goal` / Plan、Goal       | [Plan][plan]、[Goal][goal]在旧版已有，Allrice 未启用它们的产品流程                                           | 明确不接入本轮运行面；研究 SOP/上下文表达。未来必须映射精确审批、权威时钟与取消，不另建自动重启循环。                                                                                                                                                                                                                                                                   |
| `cap-session-reference` / 会话引用 | 旧版已有 [Session Reference][reference]；Allrice 已接入显式会话选择和原生引用快照                            | 已复用 `SessionReferenceResolver.prepare` 的文本投影、节选、警告和持久背景消息；见下方 `allrice-session-reference-v1`。已有标题检索工具继续保留。                                                                                                                                                                                                                       |
| `cap-code-mode` / Code Mode        | 旧版已有 [tool presentation][presentation]；“代码式展示”不能等同执行沙箱                                     | 明确不接入本轮运行面。需区分展示、PTC 执行与本地命令权限；新执行权限另列产品范围。                                                                                                                                                                                                                                                                                      |
| `cap-ptc` / PTC workflow           | [workflow-ptc][ptc]存在于 alpha.2，不在 rc.3 包组合                                                          | 明确不接入。可研究编排表达；Node VM 不是安全边界，文件策略不限制网络，总时限仍需调用方管理。须在既有隔离执行器中验证授权、取消、账本和计时，才讨论替代。                                                                                                                                                                                                                |
| `cap-office` / Office Skill        | [skill-office][office]，固定 `00102833dfaee1da9f48a3a8eae9d34005a75218` / alpha.2；运行引擎仍为 rc.3         | MET-157 PR1 复用 DOCX/XLSX/PPTX 工作方法为单一 Office Skill 的冻结内部资源，合并旧文档阅读与交付入口，默认启用现有读写链路；MIT 来源与改动见 [Office provenance](../../skills/office/references/provenance.md)。未引入上游 Python 执行器；PR2 已扩展原生表格/图表和定点原包编辑；PR3 已接入真实公式求值与租户页面预览，Dev 闭环验收单独记录，不把渲染成功当成排版正确。 |
| `cap-landlock` / OS 文件限制       | rc.3 [sandbox-local][sandbox]有 Linux bwrap→Landlock 路线，旧源码也有相关后端                                | 可复用待验证。评估作为现有隔离内的附加限制；必须识别 partial enforcement、网络和内核共享边界，不能替换 VM/Bridge 授权。                                                                                                                                                                                                                                                 |
| `cap-hooks` / Hooks                | [hook-protocol][hooks]及 Codex/Claude bridge 是实际包名，不能假定存在通用 `dsh-hooks` 包                     | 明确不作为授权门禁接入。失败通常不阻断、exit 2 才阻断，且执行依赖 shell；可学习事件扩展设计，Allrice 授权检查仍在 Broker 前。                                                                                                                                                                                                                                           |
| `cap-completion-wakeup` / 连续唤醒 | [alpha.2][alpha-release]修正连续后台/一次性助手完成后的默认唤醒上限；不推定 rc.3 已有该修复                  | 可复用待验证。逐次结果都需同一授权父节点与 durable delivery ID；验证长协作、取消、重复结算和用量，才删旧唤醒包装。                                                                                                                                                                                                                                                      |

本表条目由 MET-154 完成本轮复核，后续能力模块/Skill 封装由 MET-155 承接。按首要原则推进接入与默认开放，不因模块化尚未完成而推迟可用能力交付。暂停或回退针对具体问题，保留正在使用的依赖、数据和已开放的其他能力。

### allrice-session-reference-v1

- ID：`allrice-session-reference-v1`；**原生服务复用，保留平台适配**。Worker 直接依赖现有锁文件中的 `@deepseek-ai/dsh-session-reference@0.1.5-rc.3`，不升级引擎、不修改上游源码。
- 租户入口：输入框“＋ → 引用会话”，标题搜索、分页、最多三个来源、可移除标签。普通排队任务携带引用；编辑恢复标签；含引用不能作为 steer 发送。支持不同员工的有权读取会话，附件单独添加。
- 权威：[数据库适配](../../packages/database/src/workspace/session-references.ts)检查当前成员、租户、工作区、来源可见性和归档状态。发送时锁定来源并捕获正文；目标不能扩大来源可见范围，后续也不能通过修改目标可见范围公开私有引用。排队任务开始再次检查授权，不静默跳过已失效来源。
- 持久化：迁移 `0112_session_references.sql` 为消息增加服务端快照列；浏览器只提交唯一会话 ID，消息 API 只返回标签。第一次成功提交保留快照和摘要哈希，幂等重试使用原快照。冻结员工 prompt snapshot 携带来源，不扩展员工工具、Skill 或文件权限。
- 复用：[运行时适配](../../apps/worker/dsh/allrice-session-references.mjs)仅对显式授权快照开放独立 `readSurface`，调用官方 resolver；以原生 `session-reference` 背景消息紧跟对应用户消息进入原生 pre-step 和持久日志。Allrice 正文投影没有 DSH 原始日志序号，明确使用 `capturedThroughSeq: null` 并省略 native format version，平台保留真实消息 ID、捕获时间和哈希，不伪造日志事实。
- 内容：只捕获已完成的用户/员工正文，不含工具日志、系统消息、附件字节或递归引用。每来源最多最近 200 条、64 KiB 文字；原生预览再限制 12 KiB，附真实截断说明。未挂载 spill 文件存储，超出预览的内容不会通过文件工具隐式开放。引用增加模型上下文，但不另调用模型生成摘要。
- 验证：真实 PostgreSQL 的快照/幂等/越权/可见性/撤权用例，真实 rc.3 stdio 和 JSONL 重启回放用例，以及桌面与窄屏选择/移除/发送浏览器用例。
- 回退：新增列可保留；使用新消息内容字段后旧版严格 schema 不能直接读取新消息，需先停用引用入口并使用兼容读取版本，不能声称任意旧二进制可无损降级。

## 持续维护规则

每次升级同时落实默认开放和能力说明更新。运行控制台读取 `apps/web/app/runtime-console/dsh-capabilities.json`，明确标注已集成、上游待接入和仅前瞻版本已有的能力；该清单只负责展示，实际启用还需落实运行配置与数字员工发布。验收要从测试租户入口确认能力确实可用，并记录交付后持续开放的状态。

管理后台的数量与开启状态读取 Worker 实际安装包、运行配置、功能开关及租户员工已发布版本，每 10 秒刷新；上游能力目录仅用于说明。Worker 心跳超过 20 秒或读取失败时显示未知，不用静态目录数量补位。具体数据来源见 `apps/web/lib/runtime-capabilities.ts`。

1. 每次上游升级、适配新增/删除或源码补丁变更，都在同一 PR 更新有关条目；保留理由也要注明新复核日期与固定 SHA。
2. `pnpm dsh:verify` 检查每个 ledger ID 在此有入口，并拒绝第二代 DSH 包和任何 DSH 物理补丁；评审仍需核对内容，不能只补一个 ID。
3. 每条至少保留稳定 ID、Allrice 路径/原工单、上游包/源码 SHA、存在/启用差异、决策、权威边界、验收、退役条件、回退方式和实现 PR。退役记录保留，不抹掉历史。
4. 上游新版本的研究快照放在 `dsh-upgrades/`，从本页链接；机器发行文件只随实际兼容实现更新。历史日志夹具保持原字节，不用新版本重新生成来冒充兼容。
5. 不以“减少多少代码/节省多少 token”替代行为验收；有测量再填写收益。PR-2 已更新候选依赖及发行事实；PR-3 只删除一段重复转换，不减少 ledger 条目或物理补丁数量，不改变工具集合。
6. 本轮新增或重新评估的能力需记录默认开放状态；未开放项写明具体技术缺口或已知问题、负责工单与下一步。不能把“入口已展示”作为“能力已开放”的验收结果，不能在验收结束后无故关闭已可用能力。
7. Office 验收必须从租户聊天入口完成三格式并发生成、交付和预览/下载，不能用单个工具或已有文件代替整项任务。DSH 的并发调用由 Allrice 沙箱按实际容量排队，继续复用上游 Office 脚本与检查器；见 [2026-09-27 并发交付回归](allrice-2.0/office-concurrent-export-incident.md)。

[met154]: https://linear.app/metasnowsky/issue/MET-154
[persistence]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/session/session-persistence-jsonl/README.md
[v0-validation]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/session/session-format-v0-to-v1/src/validation.ts
[repeat]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/guard/repeat-tool-reminder/README.md
[goal]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/goal/goal-round-driver/README.md
[subagent]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/subagent/subagent/src/index.ts
[team]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/experimental/agent-team/README.md
[old-team]: https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/experimental/agent-team/package.json
[presentation]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/core/agent-tool-presentation/README.md
[web]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/web/tool-web/README.md
[sdk]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/sdk/server/src/server.ts
[wire]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/sdk/protocol/src/types.ts
[compaction]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/compaction/compaction-basic/README.md
[plan]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/plan/plan-mode/README.md
[reference]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/context/session-reference/README.md
[ptc]: https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/workflow/workflow-ptc/README.md
[office]: https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/skill/skill-office/README.md
[sandbox]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/sandbox/sandbox-local/README.md
[hooks]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/hooks/hook-protocol/README.md
[alpha-release]: https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.2
[attachment-admission]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/attachment/attachment/src/index.ts

### Office 原生工具接入补齐（MET-157 PR3）

`allrice-office-native-v1`：将 `workspace.file.list` 接入现有 DSH 原生工具循环；补齐 `workspace.document.read.includeStructure` 与 `workspace.export.create.office`，`content` 与 `office` 二选一。使用现有 DSH 注册接口与 Allrice Broker，不增加 Agent 循环或权限开关。真实固定版本 DSH 子进程回归覆盖文件列表返回、结构读取、三种格式生成和原文件定点编辑，防止仅后端支持而模型接口缺失。

引用上下文在入队时随原生 inbox 消息持久化；pre-step 接纳后移除适配器暂存字段，紧接用户消息插入原生 session-reference 消息。进程在接纳前重启也能从 inbox 恢复固定内容，无需重读来源或依赖内存映射。

#### 2026-09-27 · MET-160 设置视觉适配复核

复核官方 `native-settings` 0.1.7-rc.1（`46a7f68b0922371ce7144b668b90e377d8e799f4`）。沿用 Modal、焦点锁定、Esc 和恢复焦点；AllRice 的 `settings-design.module.css` 负责冷灰外观与尺寸，窄屏以原生 select 切换同一 sections slot。`SettingsRoot.tsx` 的样式接入及移动导航补丁、源码摘要已更新到 UI 账本。账号退出、连接管理、电脑能力开关与个人偏好仍由 AllRice 原业务组件处理，无新增 DSH 宿主权限。

## 图片发送衔接（2026-09-28）

固定官方 Web UI `0.1.7-rc.1` / `46a7f68b0922371ce7144b668b90e377d8e799f4`。
复用 `ui-attachment` 的 `MessageImage` / `ImageGallery`、原始 CSS、官方
`ImageLightbox`，以及 `ui-conversation` 的 `HistoricalImageCache`、`nextPaint`。
原生插件入口注册 Conversation image slots；当前 Allrice ChatFlow 不运行该
Host/Session slot 装配，文件引用也没有原生必填的 width/height。本次沿用已建立的
固定源码与补丁校验方式接入组件，保留缓存接管、请求去重和作用域释放实现，不另写图库。

Allrice 的必要适配是：先显示发送快照，再走现有附件/消息 HTTP 接口；实际确认后把
本地预览所有权交给原生缓存；认证文件读取使用现有签名接口，缓存按公司/工作区/用户/
会话隔离。消息失败恢复原草稿，已上传的附件重试不重复上传。新会话、排队消息和会话
切换仍遵守既有提交归属。普通文档保留现有输入框的上传/重试控件。

具体补充：从本地预览探测尺寸，历史文件缺少尺寸时在原生组件加载后补齐；慢网浏览器
用例捕获原图替换时偶发一帧尚未解码，因此在原生缓存释放预览前完成解码。替换旧的
`MessageImageGallery` 自制图库、固定正方形 CSS 和每次重挂载重新签名的处理。
WebUI 账本 `message-image-send` 记录三份原生文件及一个原生函数摘录；后续升级重放
补丁校验，上游提供相同的解码交接或 Allrice 改用完整 Session slots 时移除相应适配。

验证：真实 Chromium/React 下阻塞上传及签名返回，检查文字/图片立即进入会话、确认和
历史刷新过程无空白帧、图片比例稳定、原图预览可关闭、失败重试复用上传结果；覆盖
桌面与手机宽度。缓存用例检查跨用户隔离、请求合并和离开会话后的 URL 回收。

### `dsh-pi-ai-premature-websocket-close-v2`

Run 917f3a15 exposed a pinned pi-ai classification gap: `WebSocket closed 1006` fell through to `PI_AI_ERROR`. Run 4299ba50 also exposed premature close `1000`: pinned pi-ai emits this error only before receiving a response terminal event. The dependency patch maps these observed closes to `TRANSPORT` (1000 must have no reason suffix), reusing DSH’s provider policy (at most two request retries) and existing Worker usage-ledger checks. It does not retry authentication/policy failures, replay tool calls, or restart the whole prompt. After native recovery ends, Worker persists the original failure code as terminal and keeps existing results visible. Remove this patch when the pinned upstream includes equivalent classification.

## Codex 明确过载的错误归类（2026-10-13）

责任登记：`allrice-codex-overload-normalization-v1`（AllRice 协议扩展）。

Run `95cc7925` 的原生错误为 `PI_AI_ERROR`，原文为
`Codex error: Our servers are currently overloaded. Please try again later.`。
当前固定的 DSH `0.1.5-rc.3` / pi-ai `0.85.1` 将这种无数字 HTTP 状态的
错误归为通用错误，未触发已有的正常请求重试。另一个 Run `22664651`
只有一般性的 processing error，缺少原始 HTTP 状态和结构化错误码，不能据此
断言是过载或 DSH 内核故障。

AllRice 的 [model-errors 扩展](../../apps/worker/dsh/allrice-model-errors.mjs)
仅在 `openai-codex`、终止类型 `error`、原始代码 `PI_AI_ERROR`、完整消息
精确匹配上述过载原文、请求未取消时，将代码归为 `SERVER`；保留消息和已有
字段，不补造 HTTP 状态或 request ID。安装在公开的 `llm/stream` 接口，位于
结算与进度观察器内部，使记账和原生 loop 观察到相同终止事实。

继续使用原生 `agent/request-error` 的正常策略（最多两次重试和可取消退避），
每次新模型调用仍需独立授权与结算。没有整轮重跑、第二套调度器或工具重放。
明确的订阅终止回执仅在原有结算 ACK 策略允许时继续，未知 token 用量仍为
未知；缺失 ACK、无终止回执、取消、认证/配额/请求错误和未识别的通用错误
均不因此扩大重试权限。尤其不将 Run `22664651` 的一般处理异常加入白名单。

验证使用生产 JSON-RPC 入口、固定原生 DSH loop/retry、真实 pi-ai 和本地
SSE 测试端点，覆盖已有工具结果保留且工具只执行一次、恢复成功、连续失败
到达两次上限、结算未确认以及退避期间取消。测试 grant 和结构化 wire code
均为合成值，不冒充历史请求原始数据，不调用收费模型。上游包源码、版本、
物理 patches 和锁文件保持不变。

将来上游原生分类正确保留这类暂时性错误，且同组 wire/loop/结算回归通过后，
删除本扩展和入口注册；不把普通版本升级或函数级探针当作完整修复证据。

### MET179：分层共同要求与上下文失效

登记 ID：`allrice-employee-content-authorization-v1`；使用现有 DSH `0.1.5-rc.3` 的公开 middleware，不增加物理补丁。

共同要求沿用 employee-content 的不可变来源与发布记录，Run 只冻结已启用引用；部门、个人权限及明确纠错在实际使用时复查。内容授权代独立于 native thread 的配置与进程生命周期，依赖由已绑定 Run 引用推导，不复制正文。失效后同 Run 不换代重放；新 Run 使用新的 native session ID 和受限消息白名单 bootstrap。

MET-236（用户 2026-10-29 决定“按 DSH 收敛，停旧自动候选链”）：普通 Worker 不再从累计计费 input 推导上下文压力，不再生成旧 40k 自动摘要及其记忆候选，也不把旧自动摘要注入 live kernel。`@deepseek-ai/dsh-token-meter` 的 `contextPressure` 是当前请求的单向计量投影；`dsh-session-persistence-jsonl` 的原生日志负责同代续聊，`dsh-compaction-basic` 通过 meter 决定原生压缩，既有 summary `maxTokens: 8192` 不变。首次或新内容授权代仅导入已授权消息窗口，沿用原生覆盖回执去重；不另造摘要或恢复生命周期。历史 checkpoint/checksum 与记忆记录保持可读，旧 checkpoint 编码只保留给冻结日志兼容向量，主动记忆入口保持。

AllRice 通过公开的 `llm/stream` middleware 请求 Worker 校验，覆盖原生重试和 compaction，并保留原生循环、摘要器与模型传输。工具执行前复用相同校验。`allrice/content-authorized` 仅证明本次授权检查与引用装配，不代表模型已完成任务或 Knowledge 文件已读取。Skills 注册、加载与共同要求的装配仍分别留证。

本切片未增加 DSH 核心补丁。若上游提供可绑定平台租户权限与持久化来源依赖的等价 dispatch gate，并通过普通更新、撤回、压缩、恢复及跨会话引用回归，可迁移并撤销此适配层。场景按需加载在后续 PR3b2 实施。

### MET179 PR3b2：工作场景原生渐进加载

`allrice-progressive-scene-provider-v1` 使用固定 DSH 的公开 Skill Provider list/get 和 session/event、llm/stream。目录不带正文；Worker 按冻结引用与当前权限、lease 提交读取回执后才返回内容。原生 get（包括不可调用 slash 的探查）只算读取；匹配的成功 tool/result 才登记采用，下一派发等待采用事务。场景读取接入既有 content generation，撤权后压缩、恢复和跨会话引用同样失效。跨 Run 使用独立原生线程，保留已授权的普通历史，避免上一场景的工具结果或 summary 自动沿用。可删除条件：上游提供同等租户来源读取/采用持久化接口后替换适配；没有改动 DSH 核心或另造 Skill/Agent 循环。

### 2026-10-14：执行时限与后台计算复用复评

固定上游仍为 `0.1.5-rc.3`。工具外层超时继续复用
`@deepseek-ai/dsh-tool-call-timeout-policy`，时限直接声明在原生工具的
`timeoutMs`；移除 JSON-RPC 注册器按工具名称再覆盖一次的清单。已支持审批和资源
排队的工具保持原有效时限，Python 补齐同一等待策略，避免还在排队就被三分钟
外层等待切断。脚本的执行预算仍由授权后的执行器管理，不把外层等待时限当作计算预算。
原生注册器与 policy 的测试覆盖超过原 Python 等待上限、工具超时等待收尾、上级取消
不误分类；没有另建计时器或重试循环。

后台长计算的原生复用方向是 `dsh-jobs` 的 producer 接口及 `dsh-tool-jobs` 的
`job_output` / `job_list` / `job_kill`。现有 `dsh-jobs-local` 实测支持等待超时继续
运行、取消后先进入 stopping、执行器提交停止回执后进入终态。它是进程内注册表，
不能代替 AllRice 已有的租户授权、持久操作身份与跨 Worker 对账。AllRice 应仅实现
受控 producer：沿用原 operationId、Run、原始工具调用和成果版本，将物理停止和
清理回执接到原生 `done`。普通宿主 bash 不应因此对租户开放。

当前 SDK 的 JSON-RPC request signal 只放弃本地等待，不发送远端终止。接入后台
producer 时必须补齐实际取消接线，并验证父 Run 收尾、owner 释放、Worker 中断、
跨 owner 隔离及未知结果不重放；不能把请求已取消当成容器已停止。DSH 原生
`job_output` 的等待超时也不能再映射成计算失败。

本次仅收口原生工具时限声明。后台长计算尚未接入；现有 Python 默认 30 秒、最大
60 秒的计算限制仍保留。后续接入须通过长于 60 秒的有效计算、无输出计算、取消、
恢复核对与成果只交付一次的实际验证，再调整服务端冻结的计算预算。模型 idle
补救层处理的是不响应 abort 的 transport，不能因为 DSH 也有 watchdog 就未经
复现删除。所有复用判断按实际源码和验证记录更新，不把本页方案视为已交付能力。

### 模型断流诊断与当前步骤续做（2026-10-15）

责任登记：`allrice-observed-model-recovery-v1`（AllRice 协议扩展）。

Run `9620a5c1` 的本地五分钟等待截止只能证明没有新的归一化输出，不能证明供应商
断线或已完成。AllRice 在自有 `llm/stream` 包装内按请求观察 SSE 字节、心跳和结束
事件；只记录计数与枚举，不保存响应内容、URL、凭证或思考文本。WebSocket 没有
公开的逐帧观察接口时明确记录 `unobserved`，不能把它标为“没有心跳”。

超时后先取消该请求的 HTTP 读取，或调用 pi-ai 公开的、按 session 限定的 WebSocket
清理。只有旧 `next()` 与 `return()` 都结束、所观察连接关闭、原生工具都有结果且
没有活跃子助手，并收到 Worker 结算确认，才将本地 TIMEOUT 交给已有 DSH 重试策略。
同一原生 turn 最多重试两次，沿用已有上下文与 CSV/JSON 等工具成果；不再投递原始
任务，不推定报告生成成功，不补造 token usage。关闭无法确认、取消、撤销授权、
额度不足或结算失败继续停止。默认五分钟的语义输出等待上限保持不变；只有心跳
不会无限延长等待。重试仍会经过现有权限、内容授权和用量准入检查。

隔离验证了官方 `@deepseek-ai/dsh-timeout@0.2.1-alpha.3` 发布包（npm 完整性校验）：
同一个不响应取消的 iterator，rc.3 在 30ms 期限后仍挂起，alpha.3 在约 31ms 拒绝。
修复来源是[官方提交 dbb150f](https://github.com/deepseek-ai/deepseek-harness/commit/dbb150ff0e589ec5b34a261c201a853affe71a29)。
但 alpha.3 的 pi-ai adapter 要求整套 DSH `0.2.1-alpha.3`、Cordis `~4.0.5-alpha.2`
及 pi-ai `^1.1.0`，与当前 `0.1.5-rc.3` / `4.0.2` / `0.85.1` 不兼容，因此不做
单包替换，也不进入真实模型验收或升级。DSH 核心、锁文件与已有补丁均未改变。

退役条件：官方统一版本通过现有原生日志、权限、用量、工具、流式及真实任务验收，
且能证明取消后旧请求停止，才移除重复的等待保护。业务诊断与结算确认仍由 AllRice
负责。原生运行时的本地 SSE 三种故障、WebSocket 关闭、限次、取消和无 ACK 测试
分别在 `allrice-model-errors-native.test.mjs`、`allrice-codex-output-bound-wire.test.mjs`。

## MET187 PR1：个人 Skill 安装与原生采用

复用公开 `FileSystemSkillProvider` 解析独立附件、现有 AllRice frozen Provider 和 DSH `skill`/slash 加载；不增加 DSH 核心补丁。原始来源与解析正文各自固定，个人版本不进入平台审核目录。`allrice-jsonrpc-lifecycle-v1` 内部窄 RPC 在返回个人正文前核对精确绑定，继续由 `allrice-employee-content-authorization-v1` 的 generation/llm-stream 检查守住重试、压缩与历史撤权。普通执行权限在个人 Skill 装配之前计算，现有 catalog 摘要覆盖组合后全部正文。详见 [个人技能](../features/personal-skills.md)。

## MET192 public SDK / approved new roots (0.2.1-rc.2)

`allrice-jsonrpc-lifecycle-v1` now composes the public SDK through `allrice-sdk-root.mjs`. One process Host owns one business root; only the SDK owns and releases its AgentHandles. Existing MET193 bounded drain governs recovery/close failures. No private SDK session map or creation methods are accessed.

旧助手执行器和 `queueHostSubagentPrompt` 私有接缝已在 MET-210 PR2b 删除；以下为 MET-228 / PR3a 的候选接线，不代表生产委派已恢复。

`allrice-jsonrpc-lifecycle-v1` 的 [Run 门卫](../../apps/worker/dsh/allrice-run-admission.mjs) 复用同代公开 `agents.isOwnedBy`、`subagent/start`、`workingDirectory.ensure`、`tools.guard` / `tools/pre-execute`、`agent/request` / `llm/stream`。真实父链及 canonical cwd 随请求校验；Worker 按有序 start 事实复核真实调用者。工具逐次复用与 PR1 共享的租户/成员/员工版本/Run/租约/期限授权（只读、不加行锁）；交付入口独有的 workbench 开关、execute 模式仍由交付入口检查，逐 action 策略保持原处。根和子级模型逐次复用已冻结的通用订阅预检，不另设模型路线。legacy 进度问题续接从当前授权根取得完整身份；单向进度回执仍在事件发生时固定原 Run，传输时不重新归属。身份观察只服务门卫及既有单向进度/工具审计，不镜像子级执行状态。

提前结束统一关闭输入、处理问题，再公开 `drainDescendants`、取消根且不保留 inbox、SDK shutdown/recover；正常完成仍以公开 `session/wait` 为准。无活跃 Run 拒绝模型，等待期间 steer 绑定 Run；现有输入回执记录真实采纳 turn，SQL 只读现有 `turn.started` 证明同 Run。四类归属为门卫、租约和单向账本；没有新增存储后端、PG 字段/表、私有接口、容量限制或重试。旧生命周期适配的基线分类仍待主会话核定，本 PR 不把它整体改称已回归。

验收见 [原生接缝测试](../../apps/worker/test/native-subagent/README.md)、`run-delivery-worker.integration.test.ts`、`run-delivery.integration.test.ts` 和数据库 `runtime-governed-bridge.integration.test.ts`。测试专用 profile 安装原生委派工具；生产 profile、UI 和默认值保持本阶段授权范围，子级账单、网页控制及生产安装分别等 PR3b/c/d。

`allrice-managed-native-mcp-public-v2` composes official SDK 2.2 transport with the exported DSH tool-definition adapter. Per-request AllRice authorization, DNS-pinned egress, cancellation, frozen names/schema, unknown-effect classification and zero automatic transport reconnect retries remain required. It does not copy the upstream client plugin.

`allrice-private-v4-payload-validation-v2` keeps the four exact AllRice event payloads and chronology in AllRice. Historical private V0/V3 files are never opened as new V4 roots or rewritten: the installed generation refuses them, and no Worker keeps an older reader (retained slots were removed in MET-221). Unsupported migration remains an explicit refusal.

The five physical 0.1.5 patches and the old administrator host were removed with that generation (MET-221, 2026-10-25). The workspace now resolves one DSH generation, so no importer can borrow another generation's Cordis/DSH services; `pnpm dsh:verify` enforces it.

New 0.2.1 execution additionally requires an immutable business INSERT origin, which records the release seal (`ALLRICE_DSH_NATIVE_ARTIFACT_ID`) as provenance only; a context without one is refused as incompatible and never backfilled (MET-221). Removed invariant plugins have no published 0.2.1 exports: native factory ownership/session persistence validation and AllRice lease/pin/deadline/cancel gates are verified by actual SDK and SQL tests, rather than loading unsupported paths.

### MET231：普通员工原生委派组合（2026-10-30）

`allrice-jsonrpc-lifecycle-v1` 直接安装同代公开 spawn/fork providers、`dsh-tool-subagent`、control/list-agents；深度和并行由原生 `SubagentRuntime.Config` 执行（默认 1/8），不设累计上限，不开放模型选择。Cordis 公开 `disabled` 在不合资格时不安装 provider/工具；不以根 Agent mask 隔离子级。静态 approval never 保持无真人审批消费者的拒绝语义；获准组合恢复 `includeRuntimeContext`。

用户 10-30 选定先恢复普通对话、旧流程后接及网页逐子控制后补。Worker 只在普通员工分支传入原 Run 的服务端冻结 `nativePreferences.subagents`；本轮实际 selectedWorkflow、repair/review、preview/internal/technical 不选择该组合。有效执行策略无匹配 `assistant.delegate` 规则时跟随原生允许；deny/ask、无效/缺失、disabled、plan_only 和平台 deny 仍关闭。旧 Run 不补默认值、不重算；出生 artifact 保持原来源，执行仍用当前已封印 primary。

已授权定时等来源若最终走同一非 Workflow 员工 Run，沿用相同冻结资格和原 Run/订阅/交付门卫，也可获得委派；定时控制器和引擎不变。`native-schedule-once-product.ts` 经既有 `prepareNativeOnceChatRunInTransaction` 入队，冻结 owner 偏好；来源定时不等于经验整理的 `InternalKernelRequest`，也不让其获得新建另一后台任务所需的真人授权。

SaaS 门卫复用原真实树、租户/成员/员工/内容和冻结订阅检查；启用要求已有 Run authority 与逐调用归根端口。已有 Host 指纹同时包含冻结偏好和生效原生配置，变化时关闭旧 Host 后重建；不新增 PG 状态、子租约或生命周期。账本与问答/收树分别依赖 MET229 及 PR3d 提问运行前置。守护：正式 profile Host、普通 Worker/Workflow 负例、冻结策略与热池/冷恢复测试；网页逐子停止/消息/热过程及 Dev 真实模型验收由后续回执单列。

## MET192 固定 UI 0.2.1-rc.2 兼容升级（2026-10-18）

Web 九个已用包固定0.2.1-rc.2，另显式登记 primitives 实际引用的同版 util-code-language。12组来源在官方 commit `687f282e8625c6b8d11ff58211a90524be2e4317` 上重放；新的 ProcessState 复用同源小型 group-tree 分类器。来源账本分别核实组件、原文、适配补丁、实际PDF/Excel软件资产，以及10个Web公共包间所用依赖的解析版本，避免未声明的上游依赖借到旧CLI的brand类型或运行代码。版本补全仅作用于这些确切0.2.1-rc.2包，不全局覆盖旧引擎依赖。

保留 AllRice 身份/权限/store、对象文件服务、公开进度和既有队列；设置modal与归档toast继续用现有宿主，不装上游设置/onboarding/快捷键或另一套后台。会话标题接AllRice displayTitle；未接入的新原生动作槽不会转交旧动作回调。上下文/隐藏思考仍遵循现有展示边界。

`collapsedSessionRows` 在新版消失且watermark语义不同，因此明确独立固定旧0.1.7-rc.1来源，保留五条普通会话与运行项；不将其冒称新版watermark实现。顶层0.1.1-rc.2样式/独立摘录仍如实保留旧来源pin。本次只升级12组组件与实际npmUI软件，不声称旧样式已全部迁移。

PDF/Excel将现有LoadingIndicator传给真实原生正文的必需loading注入值，动态chunk仍仅在打开文件时从本地同源接口加载。真实并发预览回归覆盖chunk注册、解析阶段反馈和原生可读内容；类型、来源、浏览器和实际Dev按版本留证。MCP/调度依旧复用当前Worker和原生Host，未因为UI升级增加另一套执行服务。

### MET198：统一 Dock、紧凑文件页与人类终端

沿用固定的 `ui-dockkit@0.2.1-rc.2`、原生 store 和 `openContent.replaceTab`；标签、分栏、浮动、全屏、关闭及恢复不另造状态机。紧凑文件列表复用原生类型图标和菜单，上传/参考设置仍走 AllRice 文件权限与幂等回执；主对话和桌面输入默认 14px。顶部模块统一选中态，定时图标按当前会话出现，复用已有右栏列表/详情。左侧保留全局自动化导航；会话行时钟经已登记宿主槽接入，原生活动状态优先。经验、工作流沿用原有服务，本轮不另做手机导航。

真实人类终端完整消费同版 `ClientTerminals`、`RemoteStream`、`TerminalBody` 及 Bridge 的 `TerminalController` / `LocalSubprocessRuntime`，不复刻 xterm、PTY 或重连状态机。集中适配只负责 AllRice cookie/登录身份、当前会话、设备与目录授权，以及既有 Bridge WSS 的窄传输和浏览器 Storage 作用域；Web 原生资产保持完整并登记固定 SHA。`0.6.0-dev.58` 客户端只有实际声明 `humanTerminalVersion: 1` 才被网页采用。授权目录是初始 cwd，不是 OS 沙箱；此人类 shell 不产生 Agent Run，不调用模型、不自动喂入聊天历史，也不回放断线输入。

切页或暂时断网保留后台 PTY，显式关闭、确定撤权和 Bridge 退出等待原生清理；授权证据 unknown 且租期过期时停止输入、保留 PTY，不误杀或冒称清理完成。x64/arm64 SEA 的独立终端副资源由固定 manifest 校验，使用既有数据库登录与授权事实，不增加 SQL migration。若上游直接支持相同的身份、Bridge 传输和 Storage 能力，应退役对应集中适配；不能以图标、编译或合成回归替代最终双架构包与真实 Dev 联合验收。详细行为和交付门槛见[原生工作台说明](../features/native-workbench/README.md#met-198桌面统一工作台)。

### MET199：账号阅读偏好与原生过程展示

复用固定 `ui-chat@0.2.1-rc.2` 的四档 presentation policy 和当前答案代次的手动开合规则；来源与必要 import 适配记录在 UI 账本。先验证原生模块注册及完整插件的注入契约：现有 SaaS 外壳没有原生 `uiSession/uiConversation/configForms` 服务，不能只加载 bundle 就获得完整聊天宿主。继续沿用既有源码适配边界，把公开的 Run、答案代次、最终回复、已采纳插话及真正进入下一轮的输入投影给原生策略，不为阅读偏好新增一套 Session 或执行宿主。

`fontSize/transcriptView/collapseTiming` 与原有 `streamingOutput` 共用 `/api/v1/me/preferences` 和认证用户主键。PATCH 原子更新实际提交的字段，旧客户端的单一流式开关保存不重置新字段；默认正文14px、详细、回答结束后。正文字体复用现有原生 theme token，派生变量在会话边界重算；代码11px和终端13px保留原生默认，不提供配置。设置菜单移除经验记录，经验能力与正式工作台入口不变。以上均为展示偏好，不更改模型执行配置、权限或工具记录。

## MET200：原生上下文覆盖与按需工具参数（2026-10-24）

继续固定 DSH `0.2.1-rc.2`、官方 commit
`687f282e8625c6b8d11ff58211a90524be2e4317`；没有新增上游补丁或替换依赖。
`allrice-jsonrpc-lifecycle-v1` 增加窄的 `session/bootstrap-coverage` 能力：从公开
`Session.snapshotEvents()` 读取已采纳消息的 AllRice 来源摘要，按原会话、代际、
SQL 消息 ID 和内容匹配。压缩及冷恢复仍由原生 SDK/persistence 负责，无第二份历史
或摘要存储。未确认覆盖的历史保守导入，工作流步骤不冒充整段聊天，仓库修复与审核
保留原有历史隔离；旧 artifact 未声明此能力时沿用原 bootstrap 行为。

`allrice-managed-native-mcp-public-v2` 的父级工具增加只读 `describe` action。
完整目录保留名称、描述、风险和 schema 摘要；精确参数按需经过原有 frozen/current
授权选择取得，执行仍重新检查批准和未知效果。必须实际验证批准 carrier 同时支持
该输入和工具声明；旧 carrier 保留完整 schema。子助手的已冻结只读执行边界不扩大，
由主员工查询后传入精确 schema。schema 变化继续使运行配置指纹失效。

后台 Run 诊断只复用对应批准 artifact 的公开 persistence `open(id, 'read')`、
`handle.read()` 与 `expandAssistantStream()`，从 SQL 的原生回执定位确切 Run 切片。
不启动 SDK/Agent，不建索引或迁移 journal，不合成缺失 turn 结束；只返回事件类别、
时间、次数和用量，隐藏内容、思考、工具参数/结果及路径。缺失或不支持的原生事实
保留 unavailable/partial，供应商 wire 时间仍为 unknown。新 adapter 内容必须独立
测量、批准并通过 Dev 验证；保留的旧原生包和其存储不随本次变更重绑。

### MET-229：公开模型调用的归根账本（第二片）

沿 `allrice-jsonrpc-lifecycle-v1`，只在员工 Worker 私有 accounting port 存在时组合公开 `llm/stream` 观察。每次实际调用固定 UUID 和原根/Run/route；原准入检查在 start 交付之后执行，账本错误不触发模型重跑。正常、失败/取消和 legacy park 在原 drain/close 边界交付，现有 tenant→route 事务内读取原 facts、聚合并封口；不新增锁层、状态或终态修复。

原生四桶互斥，input 统一含 read/write cache；沿用当前二价估算，缺桶/缺价/未确认交付保持 unknown，订阅证明仍 N/A。fork/replay前缀不收费。普通调用不要求 task clock；不新增 PG lifecycle writer，不承诺跨重启完整 activation 审计。只用当前 primary 的真实 capability，不更改旧 origin 来源记录。

pi-ai 会省略零 cache；仅有实际 finish 证明且原始有效桶与公开 exact total 严格相等时，将真正 undefined 的 cache 计为已知0并保留 total。缺 total/有余量的缺桶，以及非法桶或已给但冲突的 total 保持 unknown；不按 provider 名字猜，不升级历史事实。

旧 assistant/message 投影没有实际 finish 凭据，缺 cache 仍未知。结算事务逐调用重验已给 total 与四桶之和；矛盾时保留用量小计、完整性为 false、金额为 null，不改原事实。

依据：`dsh-llm` 公共 stream/TokenUsage、`dsh-subagent` 原生谱系与树等待，MET-229 root 2026-10-30 第二片核定。归属为 SaaS 账本、门卫、既有存储/租约接线；无 DSH patch 或私有接口。升级时复核 stream 异常/usage、实际授权顺序和 close/park 交付；原生若提供 SaaS root billing 后再替换本接线。生产委派仍由 PR3d 独立启用。

本片只迁移普通 employee 原生根及其本轮后代/repair。`selectedWorkflow` 每个 step 可重新 bind，仍走原 caller；它不是一次固定 root-port 的生命周期，继续使用修正后的 I+R+W 投影及 cache knownness，不能称为逐调用完整账本。

3d 启用前须核定 selectedWorkflow 是否共享委派 profile，以及未迁移调用的归根合同；本片不增加开关或替它选择启用行为。运行池按 accounting 能力隔离普通与旧 caller，切换方向均不能沿用对方的 port 或计数。
