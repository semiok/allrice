# AllRice 员工左栏公开接线（MET-276 / M1-14）

离当前目标还差什么：本候选交付共享真实左栏、公开 sidebar 槽和客户端重挂端口；正式 DEntry mount/transport、同 origin 的员工原生草稿隔离、跨根附件和阅读位置恢复仍未绑定。浏览器用例已写，当前受 M1 资源限制未运行；不能把本票记为员工入口迁入完成或正式 SSO 已通过。

## 原生对照与批准范围

基线 #900 `d8f6ed3fa01bdd6e5d72e55702eb703e5e670d00`。冻结 M1-01 v1.0 §3/8；已确认 rev2 与用户当前左栏外观。实现复用 DSH `0.2.1-rc.2` 的 `sidebar`、`layout.toggleSidebar/selectPanel`、原生 `schedules` 页面、`uiWorkspace.openSession` 和 SessionReference 生命周期。

AllRice 保留自己的 logo WORKSPACE、创建/归档、员工卡、线程行、5 条预览/展开其余、详情和设置入口。`ChatSidebarFrame`、`EmployeeSidebarView`、`SidebarSettingsTrigger` 从当前产品代码提取，3.x wrapper 的权限、HTTP/SSE、后台子会话读取和设置页保持原归属。4.0 bundle 不 import 这些 wrapper，也没有 `/api/v1/...` 的旧请求 fallback。

**既有样式来源：** Frame/View 继续使用仓库已存在、带来源声明的 `dsh-upstream/AppFrame.module.css`、`SidebarRoot.module.css`、workspace Rows/样式、SettingsRoot 样式（旧 0.1.1 来源例外）。它们属于当前 AllRice 外观，不是本票重新复制的 rc.2 原生样式。没有新增 DSH 源码副本、私有包深导入或改写上游 CSS。AllRice 自有 sidebar palette 从 `styles/base.css` 移至共享 `sidebar-palette.css`；两入口引用同一文件。

SaaS 自补仅为已批门卫的 UI 接线与业务呈现：不新增认证、权限/租户状态、数据库、Agent 状态机、后台入口或定时页。自动化调用原生 `layout.selectPanel('schedules')`；设置按钮调用 MET-279 员工设置 owner，不落到旧后台。

## 五面与公开符号清单

| 面            | 当前接口/归属                                                                                                                                                         | 权限和未绑定边界                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 后端/私有数据 | 本票无新服务/表。员工、线程、归档数据由原 owner 返回 `Workspace`/`Session`/既有 archive projection                                                                    | 其他模块只能提供公开数据/命令；UI 不查内部表，不复制 DEntry 权限逻辑                        |
| MCP           | none                                                                                                                                                                  | 左栏呈现不是模型能力；不开放员工创建/设置/权限给模型                                        |
| 员工 UI       | native client 模块导出 `bindEmployeeSidebar(ctx, port)`；`EmployeeSidebarPort/EmployeeSidebarSnapshot` 定义在 `packages/dsh-web-composition/src/employee-sidebar.tsx` | 必须由可信 owner 注入全部真实命令和稳定快照；无默认/静态/成功桩。未注入时不替换原生 sidebar |
| 后台          | none                                                                                                                                                                  | 本票不提供管理员或 3.x 后台“最小入口”                                                       |
| 开关/权限     | DEntry owner 的现有 policy/admission/mount                                                                                                                            | 本票不新建 env、名单或默认代际；MET-271 还没有正式 mount，故没有接入实际入口                |

共享呈现允许符号：`chat-sidebar-frame.tsx#ChatSidebarFrame`、`employee-sidebar-view.tsx#EmployeeSidebarView`、`sidebar-settings-trigger.tsx#SidebarSettingsTrigger`；其使用的业务类型仍由现有 `chatflow-types`/archive owner 定义。该清单是本票共享 UI 端口，不把 app 内部业务函数列为跨模块 API。

`EmployeeSidebarSnapshot.tree` 包含真实业务数据和 `onSelectSession/onEmployeeNavigate/onNewSession/onDetails/onPrepareSession` 命令；archive 必填并保留分页/错误语义。快照由 owner 的 `subscribe/getSnapshot` 发布，错误保留 owner 的实际信息。创建、详情、归档、员工设置回调必须由 owner 完成真实操作，不能把夹具里的调用记录器用于产品。

## 客户端根的创建与销毁合同

`@allrice/dsh-web-composition/employee-client` 导出 `EmployeeClientNavigation`，泛型 `Mount` 直接接受后续真实 `DEntryMount`，不复制另一份准入 schema。

| 方法                              | 输入/结果                                                            | 必须由 owner 保证                                                                                              |
| --------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `admit(selection, signal)`        | 员工实例/thread 选择器 → `{mount, nativeSessionId}`；失败原样 reject | 身份、当前权限、generation、原生 root 绑定由真实 DEntry/会话 owner 核；不能由显示名/native 字符串选择任意 Host |
| `create(mount, lifetimeSignal)`   | 完整可信 mount → `EmployeeClientRoot`                                | 绑定真实受管 HTTP/WS/resource 和原生 Client/Cordis。创建失败须自行清理已取得资源；本端口不猜 URL/端口/secret   |
| `root.openSession(id, signal)`    | 同 remountKey 内的原生会话选择                                       | 使用原生 retain/open；不同 key 不调用旧 root 的 openSession 冒充切换                                           |
| `root.abort()`                    | 等待实际 I/O 收敛                                                    | lifetimeSignal 已先 abort；必须停止所有旧 HTTP/WS/资源 reader                                                  |
| `root.releaseSessionReferences()` | 释放旧引用                                                           | 所有 owner retain 的 SessionReference 都释放；不是取消 Host Agent 执行                                         |
| `root.destroy()`                  | 等待旧 Client/Cordis 根销毁                                          | 完成后才允许 create 新根；异常阻止后续挂载                                                                     |

员工变化在新准入前关闭旧根；同员工 revision/binding 等 key 变化在确认后先关旧根再创建。每次选择仍须重新准入，同 key 只复用客户端，不缓存旧权限。快速切换中止旧准入/创建，晚到结果关闭，不重放旧选择；admission 失败关闭旧根并保留错误。没有自动重试、Run 重放、VM 开机或降代。

**存储上下文是 create owner 尚未满足的前提。** remountKey 只是根生命周期标识，不是 localStorage 安全命名空间；传一个客户端 namespace 字符串不构成隔离。正式 owner 须发布可核对的浏览器存储隔离/原生公开 namespace 方案，且与认证、person/employee/profile/binding 对应。本票不自行选新域名、改认证或覆盖 `window.localStorage`。未绑定的 create 不能用于正式员工入口。

## 草稿、附件、阅读位置：真实边界

下表当前均为读源或已写测试，**尚无本候选浏览器执行结果**。

| 能力     | 同原生根内切线程                                                                                                      | 销毁/重建根或跨 Host                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 草稿     | 公开声明 persisted；新用例经真实 editor + `conversation.input.for(binding.ctx).state` 验证，待运行                    | 原生 key 是 `dsh.conversation.${sessionId}`，同 origin 同 ID 会共享；新用例明确断言此负向事实并保存 JSON，待运行。不同测试 origin 的隔离不等于正式 AllRice 路由已批准             |
| 附件     | 原生 runtime owner 跨 session navigation 保留；新用例真实文件 picker + public InputState，待运行                      | 原生描述为 runtime-only；新根没有旧 File/receipt ownership。没有公开跨根恢复/重新准入接口，本票不拷旧 upload receipt 或伪装成功；同员工 revision/binding 变化也不能复用旧 receipt |
| 阅读位置 | `ChatViewSlotProps.chatScroll` 公开 read/save；原生根内使用原生 anchor；新用例真实 wheel + 实际 viewport 恢复，待运行 | 原生实现是 ui-chat apply 内 Map，根销毁后丢失。现有公开 registry 没有只替换该注入 capability 的 decorator；本票不复制 ChatView、不 DOM 采样保存。跨根恢复仍缺接缝                 |

直接源码依据均为锁定 `0.2.1-rc.2` 的发布产物，只读，不作为私有 import：

- ui-conversation `lib/types/client/contract/views.d.ts:19-21` 声明 draft persisted；`lib/client.js:4426,4438,4471,4488` 定义 `dsh.conversation` 和 session suffix。
- client-store `lib/index.js:112-123,151-152` 直接读写当前 window localStorage、按 scopeKey 后缀持久化，无根存储 namespace 注入。
- ui-conversation `lib/types/client/service.d.ts:114-124` 声明 runtime-only 附件及跨 session navigation owner；公开 `InputState.attachmentIds` 同样注明 runtime-only。
- ui-chat `lib/types/client/contract/slots.d.ts:232-269` 导出 `ChatScrollPosition` 与 read/save；`lib/client.js:13116,13259-13265` 为根内 Map。

## 验证、证据和交付状态

本候选只完成串行轻量 build/typecheck/lint。所有单元、原生 profile、旧入口浏览器、视觉/Astra/联合门禁和 Dev 验收由主线绑定提交后执行。新 browser 文件已加入 `scripts/ci-manual-environments.yml` 的 browser 资源；没有放宽原测试时限、断言或重试。原 installed-profile suite 使用同一安装 helper，保留原 90s setup/60s 行为时限。

`employee-sidebar.browser.test.ts` 使用真实 tarball、两个独立同代 Host、同一 browser context、合成业务端口和同 native ID，零模型。保留 same-origin 双根负向；不同 origin 只验证原生存储行为。创建/详情/归档/设置仅验证公开命令派发，不冒充业务 owner 的实际写入或 SSO。

截图基准使用共享真实 Frame/View、同一合成 port 数据、固定时间 `2026-11-21T12:00:00Z`、DPR1、reduced-motion、1440/390×亮暗，记录实际浏览器版本/平台；这是原样提取组件的对照，不是旧截图的像素替换。原生默认左栏宽 280，基准按当前测量宽度渲染；不改原生宽度策略。资源许可后由主线逐图检查，当前没有“已逐屏比对”结论。

**已测体积风险：** 公开 primitives 根出口正常打包会保留 Shiki/Katex/字体。本候选 client 约 6.24 MB（JS 4.67 MB、CSS 1.57 MB，未压缩传输口径）；相对原隐藏控件插件明显增大，未测加载时间，无性能改善结论。未深导入私有原子模块或改上游包；需要上游细粒度公开出口/正式懒加载接缝才能消除该风险。

MET-225 待主线登记：新增“4.0 左栏复用现有 AllRice 员工/线程呈现，经原生 sidebar 槽与可信 mount 端口；旧外观样式沿既有来源；自动化直原生 schedules，设置仅员工 owner”。正式 transport/存储恢复仍未接通，不标已发布/已回归。该条是接法/入口差异，不另建 Agent 语义。

风险发现途径：新旧 browser/单测与 installed-profile 的旧 M1-13 断言；存储 alias 负向 JSON、截图和 owner mount 失败错误。无新运行时巡检/告警，正式健康项由 MET-222/入口 owner 收口。
