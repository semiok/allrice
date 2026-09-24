# DSH 复用与替换清单

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

## 本轮复核

### MET-160：官方 UI 复用与后续同步

设置入口复用官方 `Modal` 与 `SettingsRoot` 双栏导航：账号用量、MCP 与浏览器配置统一进入设置。完整设置插件绑定 DSH 宿主 `remote.settings` / ConfigForm / onboarding，故保留原生面板源码并接 Allrice 既有业务组件；不复制宿主模型/插件配置为无效租户开关。来源与补丁纳入同一 UI 同步账本。

固定 Web 组件版本 `0.1.7-rc.1` / `46a7f68b0922371ce7144b668b90e377d8e799f4`；Worker 引擎仍为 `0.1.5-rc.3`。官方 DockLayout、PDF 发布组件、CodeBlock 直接使用；员工树因原生 WorkspaceBrowser 固定工作区管理菜单和缺少员工轨配置，文件树因宿主 cwd/RPC 接口不适用于对象存储，取原生组件源码并记录最小适配。原生 store、折叠、标签/分栏、目录生命周期与缩放不另写一套。完整插件验证、实际文件结果、边界与回退见 [工作台复用记录](../features/native-workbench/README.md)。

已替换旧扁平员工会话展示和单成果固定容器；既有 Office 渲染、文件权限/版本、Diff/反馈及 Markdown 仍承担业务责任，不能因接入原生容器而删除。新入口默认展示，无新增管理员开关。`pnpm dsh-ui:verify` 校验 UI 来源/依赖/导出，`pnpm dsh-ui:sync` 从固定官方提交重放补丁；今后每次升级先检查官方是否已提供可替换这些适配的配置。测试夹具保留生产的 ESM 懒加载边界，依赖安装必须能从锁文件完整复现。

会话切换沿用官方 `ui-session` 按 Session binding 保留快照、切换时立即选中对应快照的行为。完整 controller 依赖 DSH Cordis Host/session bindings，不能直接绑定 Allrice 租户 HTTP 历史；因此仅在既有 `useSession` 中补上最多 8 个会话的内存缓存、最近 2 个会话及悬停/键盘聚焦预加载。再次打开立即显示对应历史并后台更新；首次未加载的会话显示加载提示，不再残留上一会话。缓存按组织、工作区、用户清空，不写浏览器持久存储；旧请求、权限撤回和本地消息提交均有失效保护。原生会话树组件保持不变。后续官方提供独立 Session 数据源时优先替换该 HTTP 适配。聊天顶部旧“交互与任务记录”技术信息区移除，实际待批准动作与任务状态仍保留。

- 日期：2026-09-24；负责工单：[MET-154][met154] PR-4。固定候选兼容升级与图片转换局部退役已合并，Dev 普通任务、恢复及 M5 真实开发交付均已验收，临时配置已恢复；业务归属见各项原工单，模块化归 MET-155。
- Allrice 基线：`a77c640`；已核对 main 的 CI、Dev 已验收代码及全部开放 PR。
- 复核范围：当前 `0.1.1-rc.2` 源码 `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` → 已安装候选 `0.1.5-rc.3` 源码 `a4c74a91e06b00fe0b0937bde982170c526cc842`。
- `0.1.7-alpha.2` / `00102833dfaee1da9f48a3a8eae9d34005a75218` 只作为前瞻研究。下表所有上游链接固定到对应源码 SHA。
- 精确包差异、协议矩阵、迁移实测和发布阻断项见 [本轮升级基线](dsh-upgrades/met154-rc3-baseline.md)。PR-2 已完成受限组合、私有事件迁移和助手接口适配；实现与发布限制见 [候选兼容验收](dsh-upgrades/met154-rc3-compatibility.md)。`installedChannel=candidate` 本身不证明部署或晋级；实际 Dev SHA、真实账号/旧会话/重启及 MET-144 开发交付结果见 [PR-4 验收](dsh-upgrades/met154-rc3-dev-validation.md)。本轮 Dev 已验收，不代表 Prod 晋级。PR-3 的具体删除、接口差异与保留理由见 [复用收敛记录](dsh-upgrades/met154-rc3-reuse.md)。

状态含义：**保留**＝上游没有承担对应 Allrice 责任；**可复用待验证**＝有重叠但还不能删旧路径；**适配后替换**＝已找到替代接口，待通过同等行为验证；**已替换**＝删除旧路径的 PR 和证据齐全；**明确不接入**＝本轮不启用该执行面。来源存在不等于产品已启用，也不等于验证通过。本轮仅图片准入后的引用转换标记为“已替换”；所属生命周期适配整体保留。

以下记录保留 MET-154 当时的实现与验收事实，其中“本轮不接入”“临时配置已恢复”不构成后续默认关闭的政策。后续升级和能力接入执行上面的“默认开放”原则。

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

## 已登记的 10 项适配

以下条目的复核日期/版本统一继承“本轮复核”。测试路径以仓库根目录为起点。退役必须在同一 PR 删除相应旧实现、更新机器清单并留下验证结果；一项适配中的少量机制可退役，不代表它承担的整项治理责任可以删除。

### allrice-durable-native-question-wait-v1

- ID：`allrice-durable-native-question-wait-v1`；归属 MET-153；**保留**。
- Allrice：[allrice-dsh-waits.mjs](../../apps/worker/dsh/allrice-dsh-waits.mjs)、[allrice-dsh-inputs.mjs](../../apps/worker/dsh/allrice-dsh-inputs.mjs)。负责静止提问检查点、确切答案采纳、同 Run 续接和派发未知不重放。
- 上游：[rc.3 Session 持久化][persistence]提供历史格式迁移和恢复机制，不承担 PostgreSQL 租约/问题授权。[v0 迁移校验][v0-validation]拒绝未知历史事件，单纯向当前词表注册私有事件不能解决这个迁移问题。
- 退役条件：候选原生机制覆盖静止边界、持久答案幂等及续接意图，且 Worker 权威检查仍在；当前无整项替代。先完成显式私有事件迁移，不删除事件或标记 ignorable 来通关。
- 验收：`dsh-legacy-replay.test.ts`、`task-wait-native.integration.test.ts`、`task-wait-worker.integration.test.ts`，以及数据库 `task-native-wait.integration.test.ts`。回退需同时保留私有事件读写能力与原格式副本。

### allrice-durable-progress-guard-v1

- ID：`allrice-durable-progress-guard-v1`；归属 MET-153；**保留**。
- Allrice：[allrice-task-progress.mjs](../../apps/worker/dsh/allrice-task-progress.mjs)、数据库 `task-progress.ts`。模型/工具事实交给持久暂停策略，用户选择继续/取消；调用次数仅统计。
- 上游：[重复工具提醒][repeat]是模型提示策略，[Goal driver][goal]是目标推进机制，都没有等价的租约、跨进程暂停状态和精确决策账本。
- 退役条件：上游提供可接入现有权威状态的等价事实回调与暂停机制，并覆盖失败、空进展、取消和重启；PR-2 已适配 `user-questions/request`，保持原策略，不引入固定调用次数上限或第二套 Agent 循环。
- 验收：`task-progress-native.integration.test.ts`、数据库 `task-progress.integration.test.ts`。回退保留暂停记录和原决策版本，不通过清空状态“恢复”。

### allrice-durable-task-clock-v1

- ID：`allrice-durable-task-clock-v1`；归属 MET-153；**保留**。
- Allrice：[allrice-assistant-runtime.mjs](../../apps/worker/dsh/allrice-assistant-runtime.mjs) 向 Worker 报告真实 idle；权威计算在 `packages/database/src/task-clock.ts`。
- 上游：[子助手的 idle、结算与 Inbox 状态][subagent]可提供更精确的事实，但不拥有 Allrice 的 PostgreSQL 时钟、并发参与者和跨 Worker 租约。
- 退役条件：可以替换重复的 idle 探测，不能迁走权威时钟。需要证明助手活跃/工具未知时不暂停、多个参与者时间取并集、等待不耗预算、接管不重置。
- 验收：`task-clock.integration.test.ts`、`task-wait-worker.integration.test.ts`。回退读取同一时钟表，不能另起内存计时器。

### allrice-development-workflow-v1

- ID：`allrice-development-workflow-v1`；归属 MET-144；**保留**（PR-3 已复核；原生派发已复用，剩余为平台治理）。
- Allrice：[allrice-assistant-runtime.mjs](../../apps/worker/dsh/allrice-assistant-runtime.mjs)、数据库 `development-cooperation.ts` / `development-workflow.ts`。现有 message/report/stop 已使用原生子助手，不是从零搭建消息系统。
- 上游：[rc.3 subagent][subagent] 用 `sendMessage` 取代旧 `followup`，PR-2 已改用 Host 专用 `queueHostSubagentPrompt` 保留 Queue 与 coordinator 来源，不能用会唤醒接收者的 `sendMessage` 冒充旧 quiet report。冷恢复使用官方 session-query-sqlite 的 `openAt: never`，仅启用精确读取，不创建索引或注册模型查询工具；[Agent Team][team]有持久排队→目标采纳→ACK、任务 revision CAS、事件等待和中断后保留 Inbox，可借鉴这些机制。
- 退役条件：只替换重复派发/唤醒/等待路径；固定候选 SHA、同版本测试、独立审查、文件 CAS、租户授权和交付证据仍由 Allrice 核验。Team 的单进程任务板不能成为 PostgreSQL 队列的第二个权威来源，`writeScopes` 也不是锁。
- 验收：数据库 `development-cooperation.integration.test.ts` / `development-workflow.integration.test.ts`、`apps/worker/test/p25/assistant-production.integration.test.ts` 和 MET-144 真实交付链。回退必须排空候选助手树，不能让旧/新两个协调器同时投递。

### allrice-assistant-required-delivery-v1

- ID：`allrice-assistant-required-delivery-v1`；归属 MET-151；**保留**（PR-3 已复核；原生结算通知仍需平台授权后唤醒）。
- Allrice：[allrice-assistant-runtime.mjs](../../apps/worker/dsh/allrice-assistant-runtime.mjs)。report 权限、输出 grant、证据结构、幂等通知和可修正参数错误都属于 Allrice 合约。
- 上游：[子助手结算][subagent]、[alpha.2 完成唤醒修复][alpha-release]可降低消息适配成本，但 native idle/结束仍不等于已提交可验收结果，alpha 修复也不能推定 rc.3 已包含。PR-3 核对后保留 `guardSettlement` 与 delivery 去重，具体差异见 [复用收敛记录](dsh-upgrades/met154-rc3-reuse.md)。
- 退役条件：原生唤醒保留真实平台 report、拒绝重复/换父节点通知，且不制造成功。需逐段删除旧唤醒包装，而不是只增加一条新路径。
- 验收：`assistant-native-delivery.test.mjs`、数据库 `assistant-output.integration.test.ts` / `assistant-output-budget.integration.test.ts`。回退保留 durable delivery ID，避免第二次投递。

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

- ID：`allrice-jsonrpc-lifecycle-v1`；归属 MET-85；**已替换**（图片准入后的有序引用转换）；生命周期扩展保留。
- Allrice：[allrice-jsonrpc-runtime.mjs](../../apps/worker/dsh/allrice-jsonrpc-runtime.mjs)、[allrice-dsh-runtime-compatibility.mjs](../../apps/worker/dsh/allrice-dsh-runtime-compatibility.mjs)。承担发行身份、Broker、会话恢复、压缩和 typed input 的受控桥接。
- 上游：[SDK server][sdk] / [wire types][wire]新增 inline image admission、初始化就绪和 reasoning effort 校验，但 SDK inline image 不传递 `name`，不能直接替代现有有名附件。PR-3 改用 rc.3 新增的 [AttachmentStore.admitPromptContent][attachment-admission]，复用原生准入及有序引用转换，并删除 `admitDshPromptImageBlocks`。上游握手版本仍为 `0.0.1`，不能用它替代 Allrice 发行版本核验。旧 `Session.events` 读取及内容事件格式已有变化。
- 保留范围：`prompt` 只把现有 wire images 标记为原生图片片段，保留 display name；SDK 继续创建消息身份与排队。租户授权、冻结附件及校验和仍在 Allrice。SDK 覆盖名称后才考虑删除这层 wire 桥接，不开放默认工具组合。
- 验收：`dsh-images-native.integration.test.ts` 覆盖真实存储拒绝边界、整批拒绝、名称/顺序、消息 ID 与进程重启；已纳入 `dsh:golden-replay`。实现与验证见 [PR-3 记录](dsh-upgrades/met154-rc3-reuse.md)。回退此局部替换可在相同 rc.3 构建恢复原 helper；这不授予 v3 历史降级到 rc.2 的资格。

### dsh-admin-webui-private-entrypoint-v1

- ID：`dsh-admin-webui-private-entrypoint-v1`；归属 MET-100；**保留**。
- Allrice：[dsh-webui-compatibility.mjs](../../apps/dsh-admin/dsh-webui-compatibility.mjs)。隔离私有 `@deepseek-ai/dsh/lib/bin.js`、启动参数与管理员入口。PR-2 新增受信任 Host 插件，经父子进程 IPC 提交原生 `authenticatedUrl`；网关内部交换和定时更新 cookie，浏览器仍只持有 Allrice 管理员会话。HTTP/API 的 Host 与 Origin 必须先通过网关校验。
- 上游：[rc.3 CLI manifest][cli]仍以 `lib/bin.js` 暴露可执行文件；这不是稳定的 Allrice 管理 API。[client connection][connection]内部已有较大改动，需要连同下一项源码补丁核对。
- 退役条件：上游有满足同等参数和管理员访问边界的稳定入口，或 Allrice 不再需要原生管理员 WebUI；否则继续集中封装，不能把 Web Host 作为租户后端。
- 验收：`apps/dsh-admin/dsh-webui-compatibility.test.mjs`、管理员 gateway 授权回归及真实启动。回退使用成套 CLI、UI 资源和补丁，不能只换 Worker。

### allrice-private-session-migration-v1

- ID：`allrice-private-session-migration-v1`；归属 MET-154 PR-2；**保留**。
- 实现：[私有事实预检](../../apps/worker/dsh/allrice-session-compatibility.mjs)、`patches/@deepseek-ai__dsh-session-format-v0-to-v1@0.1.5-rc.3.patch` 和 JSONL 持久化包的对应补丁。新增四种精确 log-only 事件；主线程与内嵌 verifier 使用相同 payload 校验，Session 运行时使用同一词表。
- 复用原生 v0→v1→v2→v3 迁移、序号/引用重映射、只读句柄、代际文件及单写入者租约；平台预检会话/turn/答案/续接关系。不丢弃私有事实、不伪造答案采纳证明、不覆盖唯一源文件。
- 验收：`dsh-legacy-replay.test.ts` 的源字节不变、等待迁移、重复答案/重启续接、未知格式/事件、损坏事实与并发写入拒绝。带私有事实的 seeded/child 日志明确拒绝，不能默认为根会话。
- 退役条件：上游提供同时覆盖迁移校验器、运行时和独立 worker bundle 的版本化下游事件注册机制；届时先通过同一旧日志测试，再删除两个物理包补丁与运行时词表扩展。候选写入 v3 后禁止旧二进制继续旧历史。

## 机器 ledger 之外的源码补丁

稳定 ID：`allrice-admin-authenticated-origin-pnpm-v1`；归属 MET-100；**保留，升级时重新验证**。

[pnpm-workspace.yaml](../../pnpm-workspace.yaml) 的 `patchedDependencies` 还登记了 [client-connection 补丁](../../patches/@deepseek-ai__dsh-client-connection@0.1.5-rc.3.patch)：已认证 HTML 的 `allrice-dsh-admin` 标记让管理员 UI 使用受控网关。这是一个实际第三方包源码补丁，与 ledger 中的协议适配分开核查，不能漏审。

rc.3 [connection 实现][connection]补丁已按新 transport/ownsHost 实现重新移植；保留服务端原生认证，并用真实原生 WebUI 启动、登录、API、Host 和跨域拒绝测试验证。退役需证明新的正式远程连接入口在既有管理员认证、Host 检查和回环服务限制下工作，并通过未登录/非管理员拒绝测试。HTML 标记本身不是权限凭证。回退需要旧锁文件、旧补丁、网关和 UI 同时兼容。详见 [管理员架构](dsh-admin-console.md)。

## 值得复用的上游能力

| 稳定 ID / 能力                     | 上游存在性与 Allrice 当前状态                                                                                | 决策、验收与退役条件                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cap-agent-team` / 协作开发        | [旧源码][old-team]已有 private Team 实验，rc.3 已公开发布；Allrice 未挂载 Team，已有受控 message/report/stop | 可复用待验证。优先 mailbox 幂等、版本 CAS、事件等待。只有同一候选测试/审查/交付链不退化才替换机制；不替代跨进程队列或上线 Teamwork 产品模式。                                                                                                                                                                                                                           |
| `cap-sdk-image` / 图片准入         | rc.3 [SDK][sdk]新增 encoded-image 准入；Allrice 已有附件桥接                                                 | 适配后替换。通过附件顺序、伪 MIME、超限及撤权路径，再删除重叠代码。                                                                                                                                                                                                                                                                                                     |
| `cap-compaction` / 压缩            | 旧版已有 compaction；Allrice 已调用 `ctx.compaction.compactNow`，不是新能力                                  | 保留原生复用。验证新 [压缩策略][compaction]的安全区间、模型路由、手动 busy 拒绝和上下文投影；不自建摘要主循环。                                                                                                                                                                                                                                                         |
| `cap-plan-goal` / Plan、Goal       | [Plan][plan]、[Goal][goal]在旧版已有，Allrice 未启用它们的产品流程                                           | 明确不接入本轮运行面；研究 SOP/上下文表达。未来必须映射精确审批、权威时钟与取消，不另建自动重启循环。                                                                                                                                                                                                                                                                   |
| `cap-session-reference` / 会话引用 | 旧版已有 [Session Reference][reference]；Allrice 使用授权后的历史检索                                        | 可复用待验证。引用解析可以借鉴，但必须证明租户隔离、会话 ACL、冻结 Skill 和只读范围，才能替换自有引用适配。                                                                                                                                                                                                                                                             |
| `cap-code-mode` / Code Mode        | 旧版已有 [tool presentation][presentation]；“代码式展示”不能等同执行沙箱                                     | 明确不接入本轮运行面。需区分展示、PTC 执行与本地命令权限；新执行权限另列产品范围。                                                                                                                                                                                                                                                                                      |
| `cap-ptc` / PTC workflow           | [workflow-ptc][ptc]存在于 alpha.2，不在 rc.3 包组合                                                          | 明确不接入。可研究编排表达；Node VM 不是安全边界，文件策略不限制网络，总时限仍需调用方管理。须在既有隔离执行器中验证授权、取消、账本和计时，才讨论替代。                                                                                                                                                                                                                |
| `cap-office` / Office Skill        | [skill-office][office]，固定 `00102833dfaee1da9f48a3a8eae9d34005a75218` / alpha.2；运行引擎仍为 rc.3         | MET-157 PR1 复用 DOCX/XLSX/PPTX 工作方法为单一 Office Skill 的冻结内部资源，合并旧文档阅读与交付入口，默认启用现有读写链路；MIT 来源与改动见 [Office provenance](../../skills/office/references/provenance.md)。未引入上游 Python 执行器；PR2 已扩展原生表格/图表和定点原包编辑；PR3 已接入真实公式求值与租户页面预览，Dev 闭环验收单独记录，不把渲染成功当成排版正确。 |
| `cap-landlock` / OS 文件限制       | rc.3 [sandbox-local][sandbox]有 Linux bwrap→Landlock 路线，旧源码也有相关后端                                | 可复用待验证。评估作为现有隔离内的附加限制；必须识别 partial enforcement、网络和内核共享边界，不能替换 VM/Bridge 授权。                                                                                                                                                                                                                                                 |
| `cap-hooks` / Hooks                | [hook-protocol][hooks]及 Codex/Claude bridge 是实际包名，不能假定存在通用 `dsh-hooks` 包                     | 明确不作为授权门禁接入。失败通常不阻断、exit 2 才阻断，且执行依赖 shell；可学习事件扩展设计，Allrice 授权检查仍在 Broker 前。                                                                                                                                                                                                                                           |
| `cap-completion-wakeup` / 连续唤醒 | [alpha.2][alpha-release]修正连续后台/一次性助手完成后的默认唤醒上限；不推定 rc.3 已有该修复                  | 可复用待验证。逐次结果都需同一授权父节点与 durable delivery ID；验证长协作、取消、重复结算和用量，才删旧唤醒包装。                                                                                                                                                                                                                                                      |

本表条目由 MET-154 完成本轮复核，后续能力模块/Skill 封装由 MET-155 承接。按首要原则推进接入与默认开放，不因模块化尚未完成而推迟可用能力交付。暂停或回退针对具体问题，保留正在使用的依赖、数据和已开放的其他能力。

## 持续维护规则

每次升级同时落实默认开放和能力说明更新。两个后台共用 `packages/dsh-runtime-diff/capabilities.json`，明确标注已集成、上游待接入和仅前瞻版本已有的能力；该清单只负责展示，实际启用还需落实运行配置与数字员工发布。验收要从测试租户入口确认能力确实可用，并记录交付后持续开放的状态。

管理后台的数量与开启状态读取 Worker 实际安装包、运行配置、功能开关及租户员工已发布版本，每 10 秒刷新；上游能力目录仅用于说明。Worker 心跳超过 20 秒或读取失败时显示未知，不用静态目录数量补位。具体数据来源见 [管理员架构](dsh-admin-console.md)。

1. 每次上游升级、适配新增/删除或源码补丁变更，都在同一 PR 更新有关条目；保留理由也要注明新复核日期与固定 SHA。
2. `pnpm dsh:verify` 检查每个 ledger ID 在此有入口；评审仍需核对内容，不能只补一个 ID。也必须审查 `patchedDependencies`，一个 ledger 条目可对应多个物理源码补丁，不能用条目数代替补丁清点。
3. 每条至少保留稳定 ID、Allrice 路径/原工单、上游包/源码 SHA、存在/启用差异、决策、权威边界、验收、退役条件、回退方式和实现 PR。退役记录保留，不抹掉历史。
4. 上游新版本的研究快照放在 `dsh-upgrades/`，从本页链接；机器发行文件只随实际兼容实现更新。历史日志夹具保持原字节，不用新版本重新生成来冒充兼容。
5. 不以“减少多少代码/节省多少 token”替代行为验收；有测量再填写收益。PR-2 已更新候选依赖及发行事实；PR-3 只删除一段重复转换，不减少 ledger 条目或物理补丁数量，不改变工具集合。
6. 本轮新增或重新评估的能力需记录默认开放状态；未开放项写明具体技术缺口或已知问题、负责工单与下一步。不能把“入口已展示”作为“能力已开放”的验收结果，不能在验收结束后无故关闭已可用能力。

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
[cli]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/apps/cli/package.json
[connection]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/client/connection/src/client/index.ts
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
