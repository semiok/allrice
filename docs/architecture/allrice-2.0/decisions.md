# AllRice 2.0 架构决策记录（P00）

> 日期：2026-09-07；子工单：[MET-109](https://linear.app/metasnowsky/issue/MET-109)。
>
> 本组 AR2-ADR 标识用于2.0设计，不覆盖既有[ADR-0001](../adr-0001-v1-core-contract-authority.md)。

“采纳”表示P00确定设计约束；“待实验”表示实现选型仍须在指定切片取得证据，不表示已经落地。阶段/PR顺序只以[执行总表](https://linear.app/metasnowsky/document/allrice-20-执行总表阶段依赖pr-与验收门禁-df09b0b1e681)为准。

## AR2-ADR-001：复用业务权威与公共契约

**状态：采纳。责任：105/106/107/108。**

背景：已有Session/Run、ExecutionTarget、Artifact/DeliverableVersion、StoragePort、审批和DSH运行边界。为新工作台复制这些模型会形成两套授权和状态。

决定：`@allrice/contracts`继续提供可执行跨边界schema；PostgreSQL保存业务状态，StoragePort保存内容，DSH仍是Harness。逐能力扩展，不整体更换Session/Run/交付库。SaaS运行协调与DSH模型循环职责区分，受控助手不引入第二套Agent Loop。

代价/拒绝项：需要兼容迁移、版本映射和老客户端测试；不采用浏览器localStorage或仅内存连接作为权威。P01明确ID/版本/事件映射，P03-a建设共享操作账本，P06整合版本化Review；P00不增加表或schema。

验收触点：C1/C3/C6/C7；旧数据可读、重放防重、身份和权限不漂移。来源：[现有基线](baseline.md)、[ChatFlow Runtime](../chatflow-runtime.md)。

## AR2-ADR-002：本地CLI能力由Bridge受控执行

**状态：执行边界采纳；具体OS隔离后端待P02实验。责任：106/107。**

决定：网页经服务端治理和Bridge执行真实程序/参数、构建、测试及获准项目依赖安装；普通员工使用图形入口。首版结构化程序+参数，固定获准工作目录、最小有效环境、受控网络与资源，审查可追溯输出/退出码和取消。后台服务及有限非PTY输入分别管理，不开放任意交互式Shell或新本地模型循环。

程序名白名单、execFile和Git worktree都不是OS安全边界：`pnpm test/build/install`可能执行任意项目或依赖脚本。审批绑定的程序、参数、输入、基线、安装源/锁文件/脚本、环境与策略变化时复检；执行端仍要阻止工作范围外文件/网络/凭证访问及失控子进程。realpath检查与原子rename不能直接宣称抗TOCTOU或原子CAS。

待实验：P02在隔离测试目录验证OS方案的真实文件/网络/子进程/资源边界，M与Intel分别记录；不可行时限定能力并报告，不能降级为裸执行。P05验证真实进程树停止；P09-a/b/c分别交环境诊断、受控安装、后台/有限输入，避免一个扩权大PR。

不承诺：双架构编译成功等于双平台通过、`cd`等于路径隔离、Shell参数结构化等于无副作用。来源：[Bridge v0.2](../../../apps/rice-bridge/README.md)；参考[Antigravity CLI形态](https://antigravity.google/docs/cli/overview/)及[沙箱说明](https://antigravity.google/docs/cli/sandbox/)，不据其说明推断AllRice隔离已完成。

## AR2-ADR-003：WSS加速传输，持久账本决定执行

**状态：采纳方向；协议字段/兼容窗口由P01确定。责任：106。**

决定：Bridge主动出站WSS，保留HTTP兼容/降级。协议包括认证、版本/能力协商、连接替换、心跳、消息ID、ACK、有限流式输出和恢复。领取、租约、准入、结果和审计继续持久化；不同传输竞争同一执行权。

共享账本P03-a和设备journal/outbox P03-b分开，云端与助手不等待设备部分。业务幂等operation ID跨重连不变，attempt/lease区分重试权；结果缺失不能证明未执行。非幂等动作结果未知时核实，不承诺任意外部副作用“exactly once”。

代价/拒绝项：新增断连、旧连接、消息丢失/乱序、重启、背压与截断测试；不以换WSS为由替换浏览器SSE，不先关HTTP。P11/P12切片实现，现有HTTP可先验证P05。来源：[Bridge持久化](../../../packages/database/src/bridge.ts)、[SSE权威](../chatflow-runtime.md)。

## AR2-ADR-004：可选Bridge与通用云执行分支

**状态：端云职责采纳；Cloud Runner隔离实现待P15验证。责任：106/107/105。**

决定：没有Bridge也能完成获准云端数据处理和正式交付；本地文件原地修改/本机进程/本机私有网络操作必须在目标设备。每个动作选择明确target，云任务不依赖本地PoC或journal。

Cloud Runner使用隔离的短生命周期执行环境；文件系统/进程/资源/租户隔离、默认受限出站、最小身份、无宿主敏感挂载，输出按StoragePort持久化后环境可销毁。Docker、gVisor等为候选实现而非已采纳的安全证明；P15 ADR补充实际后端/限制/测试后才启用相应能力。

转云要核对输入版本、资料用途/传输授权、目标策略及预算；不自动上传整个本地目录，不用云副本冒充本地落盘。取消、崩溃、销毁后交付可读及跨租户拒绝必须实测。来源：[现有ExecutionTarget](../../../packages/contracts/src/operations.ts)、[C4/C6契约](contracts.md)。

## AR2-ADR-005：浏览器与开发预览有独立执行身份

**状态：边界采纳；具体访问通道待P21～P23验证。责任：105/106/107。**

决定：复用Managed Browser的云端路线；本地通过Bridge启动/连接受控独立Profile，不默认操纵员工个人Chrome或继承其Cookie。人工接管与Agent互斥，来源URL/时间/目标和上传下载权限可追溯；撤销后不得继续。

工作台静态工件预览不运行同源脚本，不自动加载泄露任务信息的外链。开发服务器预览必须证明目标浏览器实际可达，访问通道绑定tenant/target/端口/有效期，与主站登录身份隔离；不能把localhost URL当跨网路由，不能默认开放公网隧道。

代价/拒绝项：新增Profile生命周期、凭证、恶意HTML/SVG/重定向、端口越权、停止后通道关闭测试。只读Console/Network也可能含秘密，必须最小采集及脱敏。来源：[Managed Browser契约](../../../packages/contracts/src/operations.ts)、[C8](contracts.md)。

## AR2-ADR-006：采纳Cline经验，优先验证可复用Web Diff

**状态：采纳研究/适配路线；组件引入待P07实验。责任：105/107。**

决定：Diff、精确审批、连接恢复、MCP和修改恢复借鉴Cline；优先实验其独立Web Diff组件，再决定适配或基于同一前后文本契约自建。审批权威仍是AllRice，不能复制Cline Task/模型循环或VS Code宿主信任模型。

候选来源：[cline/cline固定提交的tool-diff.tsx](https://github.com/cline/cline/blob/dac3b35ba485dbab3b5a73aca239b0d07ce071cf/sdk/packages/ui/components/agent-chat/tool-diff.tsx)，提交`dac3b35ba485dbab3b5a73aca239b0d07ce071cf`，路径`sdk/packages/ui/components/agent-chat/tool-diff.tsx`。P00仅记录出处，不复制或安装外部代码。

P07进入适配前须记录：固定源码和依赖版本、LICENSE/NOTICE及文件特殊许可、宿主/样式/运行依赖、实际改动与维护责任。用纯Web环境验证大文件/二进制降级、虚拟化、键盘/窄屏、版本锚点/行评论、恶意内容以及SSR/构建兼容。若候选不可用，记录实验失败原因和替代设计，不能只凭截图宣称已经采纳实现。

许可核对是工程门禁，不在P00断言某段外部代码可任意复制；许可证、性能与AllRice实际适配均待实验。来源链接在2026-09-07核对可访问，具体实现证据由P07补齐。

## AR2-ADR-007：基础助手通过DSH适配，先验证再开放

**状态：受控协作方向采纳；P24 固定版本真实 PoC 通过，产品开放仍待 P25/P26/P27。责任：108/106/107。**

决定：在单一DSH Harness边界内提供基础Subagents，子任务只获得父权限与自身政策的交集，拥有parent/root关联、有限并发/深度/数量和共享根预算；持久化消息与结果、根取消、冷恢复、迟到结果和产物冲突必须可核实。

当前固定版本见[upstream.json](../../../apps/worker/dsh/upstream.json)。包存在、插件可配置或写完S0契约不等于受控委派/审批转交/全树取消已经实现。P24真运行PoC确定可复用接口和缺口，P25/P26交付基础助手，P27联合验收。

2026-09-08 P24 实测补充：原生 continuable、直接父身份、never 审批策略、quiet report、child-first drain 和 JSONL 冷恢复可复用；单个 interrupt 不取消孙任务。原生 inbox 事件**可以持久化**，但 admission ACK 不保证已经到达 flush 检查点；SIGKILL 分别验证了已 flush 的 FIFO 恢复和未 flush 窗口丢失。平台仍必须补 durable outbox/result inbox、native ID 映射、根取消/预算及恢复前租约校验。原生策略拒绝不授予高权限；独立平台 proposal 经 P04 精确批准后由 Broker 执行的真实 PG/HTTP/Bridge 联测通过。详见[P24 实测与后续硬门禁](p24-dsh-collaboration-poc.md)；生产 profile 保持受限，未开放助手。

不复制另一套OpenAI/Cline Agent Loop；不直接让助手共享无限权限或把同目录并行写入当协作。完整Boost、Teamwork、正式Handoff与开发协作增强在S8；产品内独立核验能力不受开发期Gemini退出影响。来源：[DSH Harness适配](../dsh-harness-adapter.md)、[C1/C5/C6](contracts.md)。

## AR2-ADR-008：连接器、Skill与经验复用现有治理

**状态：采纳。责任：106/107/105。**

决定：MCP服务须有租户绑定、凭证生命周期、工具发现/能力变化处理及逐工具授权。云端连接器和本地stdio进程分别验收；本地MCP经过Bridge同一进程管理与断线策略，不因“连接成功”放开全部工具。是否使用特定托管连接器供应商由具体适配实验决定，不新增旁路治理。

Skill正文、资源、脚本依赖与来源记录进入现有版本发布和冻结快照，Memory/规则候选经人工审核后只影响后续合法任务。Hooks/Sidecars自动执行不进入GA；不以Skill提示词代替强制防护，不因研究新生态重写现有发布体系。

P16/P17验证真实MCP任务和失败生命周期；P18/P19/P20完成版本化业务包、确定性对账交付及人工经验生效。来源：[现有能力基础](../agent-capability-foundation.md)、[C2/C8](contracts.md)。

## 决策变更规则

采纳的语义约束变化需写原因、影响契约/样例/旧版本、回退方式并同步相关MET与执行总表。待实验项按上述候选取得证据后更新状态；缺设备/证书/服务如实保持未验证，不用P00文档合并代替技术结论。
