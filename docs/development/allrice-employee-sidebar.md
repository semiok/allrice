# AllRice 员工左栏公开接线（MET-276 / M1-14）

离当前目标还差什么：本候选交付共享真实左栏、公开 sidebar 槽和客户端重挂端口；正式 DEntry mount/transport、同 origin 的员工原生草稿隔离、跨根附件和阅读位置恢复仍未绑定。浏览器用例已写，当前受 M1 资源限制未运行；不能把本票记为员工入口迁入完成或正式 SSO 已通过。

## 原生对照与批准范围

基线 #900 `d8f6ed3fa01bdd6e5d72e55702eb703e5e670d00`。冻结 M1-01 v1.0 §3/8；已确认 rev2 与用户当前左栏外观。实现复用 DSH `0.2.1-rc.2` 的 `sidebar`、`layout.toggleSidebar/selectPanel`、原生 `schedules` 页面、`uiWorkspace.openSession` 和 SessionReference 生命周期。

AllRice 保留自己的 logo WORKSPACE、创建/归档、员工卡、线程行、5 条预览/展开其余、详情和设置入口。`ChatSidebarFrame`、`EmployeeSidebarView`、`SidebarSettingsTrigger` 从当前产品代码提取，3.x wrapper 的权限、HTTP/SSE、后台子会话读取和设置页保持原归属。4.0 bundle 不 import 这些 wrapper，也没有 `/api/v1/...` 的旧请求 fallback。

**既有样式来源：** Frame/View 继续使用仓库已存在、带来源声明的 `dsh-upstream/AppFrame.module.css`、`SidebarRoot.module.css`、workspace Rows/样式、SettingsRoot 样式（旧 0.1.1 来源例外）。它们属于当前 AllRice 外观，不是本票重新复制的 rc.2 原生样式。没有新增 DSH 源码副本、私有包深导入或改写上游 CSS。AllRice 自有 sidebar palette 从 `styles/base.css` 移至共享 `sidebar-palette.css`；两入口引用同一文件。

SaaS 自补仅为已批门卫的 UI 接线与业务呈现：不新增认证、权限/租户状态、数据库、Agent 状态机、后台入口或定时页。自动化调用原生 `layout.selectPanel('schedules')`；设置经原生 shell 的真实 launcher 打开员工设置，不落到旧后台。

MET-279 cold-profile 接线：独立 profile 停用 Host apply 为 noop 的 ui-sidebar UI row，AllRice 首次声明 `sidebar.settings`，经自身公开 props.renderSlot 渲染原生 General 的唯一 SettingsRoot。没有动态夺权/rebind、复制 shell、私参或 CSS 隐藏。Workflow 的 guarded renderLauncher 渲染共享 `SidebarSettingsButton`，由原生 shell 提供 row；3.x wrapper 仍渲染原 row + 同一 button。未绑定可信 sidebar owner 时该独立 profile 没有 fallback 左栏，不能提前切换正式入口；下表“未注入不替换”仅指客户端注入等待，不代表禁用 native UI 后仍有原生栏。

设置集成浏览器文件为 `settings-integration.browser.test.ts`，调用 Workflow 原5cases并增加唯一shell/真实安装composition fiber公开Cordis卸载重建/新owner props稳定性。使用明确合成business owner与账号，未替代真实旧3.x业务port；固定时间、1440/390亮暗截图及首败原件均有输出接线，实际执行由主线排资源。单元/离线注册/SSR不是Host/DOM或业务迁移验收。

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

`dispose()` 必须保留已发生的 teardownFailure 并 reject，包括取消后迟到根的销毁失败；重复 dispose 不重试关闭，不把“active 已清空”视为销毁成功。对应单测保留同一失败对象与全部 cleanup 的实际调用次数。

**存储上下文是 create owner 尚未满足的前提。** remountKey 只是根生命周期标识，不是 localStorage 安全命名空间；传一个客户端 namespace 字符串不构成隔离。正式 owner 须发布可核对的浏览器存储隔离/原生公开 namespace 方案，且与认证、person/employee/profile/binding 对应。本票不自行选新域名、改认证或覆盖 `window.localStorage`。未绑定的 create 不能用于正式员工入口。

## 草稿、附件、阅读位置：真实边界

下表当前均为读源或已写测试，**尚无本候选浏览器执行结果**。

| 能力     | 同原生根内切线程                                                                                                      | 销毁/重建根或跨 Host                                                                                                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 草稿     | 公开声明 persisted；新用例经真实 editor + `conversation.input.for(binding.ctx).state` 验证，待运行                    | 原生 key 是 `dsh.conversation.${sessionId}`，同 origin 同 ID 会共享；新用例明确断言此负向事实并保存 JSON，待运行。不同测试 origin 的隔离不等于正式 AllRice 路由已批准                                                                                             |
| 附件     | 原生 runtime owner 跨 session navigation 保留；新用例真实文件 picker + public InputState，待运行                      | 原生描述为 runtime-only；新根没有旧 File/receipt ownership。没有公开跨根恢复/重新准入接口，本票不拷旧 upload receipt 或伪装成功；同员工 revision/binding 变化也不能复用旧 receipt                                                                                 |
| 阅读位置 | `ChatViewSlotProps.chatScroll` 公开 read/save；原生根内使用原生 anchor；新用例真实 wheel + 实际 viewport 恢复，待运行 | 原生默认 Map 随根销毁。持有完整 ChatViewSlotProps 的合法 owner 可包装公开 read/save，以可信 person/employee/profile/session/remount scope 保存 canonical ChatScrollPosition；公开合同支持，但本票 owner 未绑定、跨根未实测。不能因缺独立 decorator 判定绝对不可能 |

直接源码依据均为锁定 `0.2.1-rc.2` 的发布产物，只读，不作为私有 import：

- ui-conversation `lib/types/client/contract/views.d.ts:19-21` 声明 draft persisted；`lib/client.js:4426,4438,4471,4488` 定义 `dsh.conversation` 和 session suffix。
- client-store `lib/index.js:112-123,151-152` 直接读写当前 window localStorage、按 scopeKey 后缀持久化，无根存储 namespace 注入。
- ui-conversation `lib/types/client/service.d.ts:114-124` 声明 runtime-only 附件及跨 session navigation owner；公开 `InputState.attachmentIds` 同样注明 runtime-only。
- ui-chat `lib/types/client/contract/slots.d.ts:232-269` 导出 `ChatScrollPosition` 与 read/save；`lib/client.js:13116,13259-13265` 为根内 Map。

scroll owner 只能传递/保存原生 `ChatScrollPosition` 纯 UI 值并保留完整原生 props，不能取代原生滚动算法、DOM 采样、复制 ChatView、保留旧根 callbacks 或引入 Agent 状态机。不同员工同 ID、同员工 revision/binding 更换都须隔离。当前 sidebar owner 仅拿 SidebarOwnerProps，不持有完整 ChatViewSlotProps；ChatView 也未直接 runtime export。公开 slots ledger 检查不等于可修改 component/inject，shadow 时直接复制 native child 声明会撞单 declarer，因此不能凭 registry 类型宣布已接通。

## 验证、证据和交付状态

本候选只完成串行轻量 build/typecheck/lint。所有单元、原生 profile、旧入口浏览器、视觉/Astra/联合门禁和 Dev 验收由主线绑定提交后执行。新 browser 文件已加入 `scripts/ci-manual-environments.yml` 的 browser 资源；没有放宽原测试时限、断言或重试。原 installed-profile suite 使用同一安装 helper，保留原 90s setup/60s 行为时限。

`employee-sidebar.browser.test.ts` 使用真实 tarball、两个独立同代 Host、同一 browser context、合成业务端口和同 native ID，零模型。保留 same-origin 双根负向；不同 origin 只验证原生存储行为。创建/详情/归档/设置仅验证公开命令派发，不冒充业务 owner 的实际写入或 SSO。

侧栏点击还接入可控的零模型 `EmployeeClientNavigation` owner：实际创建/销毁独立 Cordis Context、真实 retain/release SessionReference、取消 ReadableStream，检查同 key、跨员工、revision、拒绝、迟到创建/UI。该模式不调用 uiWorkspace.openSession；没有公开 native Web Client/HTTP/WS mount 就明确不宣称真实跨 Host 根/传输关闭或存储恢复。两 Host 存储实验和受控根生命周期是不同证据，不能拼成 production 通过。

截图真基准由 `legacy-sidebar-baseline.ts` 对固定 base `d8f6ed3fa01bdd6e5d72e55702eb703e5e670d00` 执行 git show，编译原版真实 ChatSidebar/EmployeeSidebar/SidebarSettings 及其依赖的 AllRice app/UI/contracts 源码；不 alias 到当前 Frame/View。两侧同用 `sidebar-data.mjs`、固定时间 `2026-11-21T12:00:00Z`、DPR1、reduced-motion、1440/390×亮暗和测量宽度，包含预览与展开其余。保留 source hashes、可重放 HTML、浏览器版本/平台和逐图 comparison.html；旧读请求只在独立 baseline 夹具合成回答，不进 4.0。共享 Frame 的同 head 对照仅作为容器影响辅助图，不能证明提取无回归。资源许可后主线逐图检查，当前未截图/未视觉通过。

浏览器证据默认放在独立 `os.tmpdir()/allrice-composition-evidence/employee-sidebar-*`，输出绝对位置；可由 ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR 指定父目录。afterAll 仅删除凭证 Host 根，保留首败 JSON/PNG/基准原件；不靠人工设置 env 才避免证据丢失。

CI 浅 checkout 只补取精确 base 对象，并将 evidence 父目录落到现有 integration-collection 上传目录。M5 若用无 Git 历史的源归档，source-preparation 可先调用同一个 `writeLegacySidebarBaseline()` 生成 HTML/source manifest，记录 provenance 后带入隔离环境，通过测试专用 `ALLRICE_SIDEBAR_BASELINE_ARTIFACT_DIR` 提供；消费时强校验 HTML/data hash 与三份旧入口固定 hash。错件直接失败，不降为当前 Frame、不跳过视觉场景。这是夹具输入，不是生产 route/认证/入口。

**体积收缩与公开证据：** rc.2 `dsh-web-frontend/dist/assets/index-CN7NIWNw.js:190` 的 staticModules 明确含 primitives 与 zod，原生 ui-chat:10 / ui-conversation:29 同样同步 require primitives。build 将这两个公开裸包 external，沿现有 factory(require) 复用；不新增 route/inject/上游补丁/私有深导入。当前 client 约 513 KB（JS 450 KB、CSS 60 KB，未压缩），不再复制原 6.24 MB 候选的 Shiki/KaTeX/60 个字体输入。build 的 metafile guard 禁止这些重复输入。原生 shell 仍正常拥有其 Markdown 资源；加载时间、菜单/主题/聊天是否无回归尚未实测，不能把静态缩包当性能通过。完整链和字节数在任务证据 BUNDLE-ANALYSIS.md/BUNDLE-COMPARISON.json。

MET-225 待主线登记：新增“4.0 左栏复用现有 AllRice 员工/线程呈现，经原生 sidebar 槽与可信 mount 端口；旧外观样式沿既有来源；自动化直原生 schedules，设置仅员工 owner”。正式 transport/存储恢复仍未接通，不标已发布/已回归。该条是接法/入口差异，不另建 Agent 语义。

风险发现途径：新旧 browser/单测与 installed-profile 的旧 M1-13 断言；存储 alias 负向 JSON、截图和 owner mount 失败错误。无新运行时巡检/告警，正式健康项由 MET-222/入口 owner 收口。
