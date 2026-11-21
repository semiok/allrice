# AllRice 员工四面板：原生右栏薄接线

离当前目标还差什么：MET-277 已实现可独立整合的 UI contribution；正式入口/BFF/MCP owner、4.0 carrier、打包接线和原生安装/视觉验收仍由主线收口。本文件不将合成 controller 单测或原组件 SSR 当作真实业务贯通。

设计使用已确认的 `/Users/snow/allrice-design-previews/allrice40-panels-20261121/rev2`，冻结 BOUNDARY-CONTRACT v1.0 第 8 节。基线 `c1e8ae0e43ed2976129acbdf0971715dc9ec5120` 是已验侧栏头，不是 settings 完整组合；主线后续统一整合，不追 main。

## DSH 对照与文件边界

原生 rc.2 用 `sidebarRightTabs.register` + keyed `sidebar.right.pane.tab` 两阶段注册、`conversation.session.header.actions` 贡献入口；`useTabInfo()` 提供原生 visible/signal/actions，原生仍拥有分屏、关闭、停靠和窄屏。`layout.selectPanel` 只接受实际注册 main key。

本层直接渲染现 `EnterpriseMaterialsPanel`、`WorkbenchFilesPanel`、`EmployeeMemorySidebar`、`EmployeeCapabilitiesPanel` 和 `WorkbenchEntries`，复用其真实 `ComponentProps`、业务 controller、样式、Modal、reader 与操作。没有重画面板、复制 DSH/预览源码、原生 DOM 改装或引入旧 ArtifactWorkbench/Dock 状态。

SaaS 自补只涉及已批准门卫的 UI 接线：显式可信 owner、精确 Session/authority revision 的回调失效和原生引用/main 入口桥。身份、资源当前权限、版本、CAS、幂等、存储与业务回执继续归既有 owner/MET-272；无新表/账本/租约/Agent 状态机。

本层专属 source 为 `packages/dsh-web-composition/src/employee-panels*`。唯一既有文件改动是 `WorkbenchEntries.showToggle?: boolean`：默认旧行为原样保留；native header 显式 false，不用 `open=true` 隐藏旧 Dock。其他 settings/child-pane 与共享 profile/build/client/package/lock/declarations 不在本提交修改。

## 实际 source 导出与 owner 合同

`employee-panels.tsx` 导出 `apply(ctx)`、`bindEmployeePanels(ctx, port)` 及 `EmployeePanelsPort/Snapshot/Reference/Actions/Binding` 类型。测试用 render seam 不应被主线发布为独立业务入口；正式组件必须经 native slot 与 binding 渲染。共享 client facade/manifest 尚未接此 source，不能声称当前安装包已有这些新导出。

`bindEmployeePanels` 在调用者 Cordis lifetime 内建立一个子 fork；返回的 fork 可 await、dispose。它提供 `allriceEmployeePanels` 与 root AbortSignal。没有默认 port、fake endpoint、localStorage 身份或成功回退。owner 缺失时 contribution 不注册四页/header；owner unload 撤销注册、abort 已捕获 intent，并清理订阅，旧 intent 不能作用到替代 owner。

`EmployeePanelsPort`：

- `getSnapshot(nativeSessionId)` 返回稳定 `EmployeePanelsSnapshot` 或 null；`subscribe(nativeSessionId, listener)` 返回 disposer。null 是不可用，不是空成功。
- snapshot 的 `scopeKey` 是认证目标/authority revision 的 UI 生命周期 key，改变时旧回调拒绝；它不是授权凭证。private data/当前会员、模块资格和资源现权由可信 owner 在服务端校验。
- `materials/files/experience` 直接以对应真实 `ComponentProps` 提供；本层只注入 native active 和受控引用 callback。业务 fetch/provider 必须在真实 AllRice origin/context 内工作，不覆盖全局 fetch。
- `workflow(actions)` 是纯 props 组合函数，返回真实 `EmployeeCapabilitiesPanel` props/原 section children；controller/provider 在 owner 原入口拥有，不在该函数里创建 Hook/第二目录。其他业务动作依然由原 controller 处理。
- `filesUnread` 保持既有成果未读语义；null 表示未知，顶部不渲染“成功 0”。其余三项按本轮明确决定保留现有 0，不使用预览合成计数或页长创建新需求。成果 `onRead`/真实已读更新由 owner 原回调提供。

四 kind/id 为 `allrice-employee-panels.files/materials/experience/workflow`；header id 为 `allrice-employee-panels.header`。不覆盖原生 header/子智能体 lineage、guide 或 rightbar declarer。四顶部按钮是入口，native pane 负责选中态；不另存 native docking/selected 状态。

## 引用与能力入口

企业资料每行“＋”保留。原组件仍先获取 server-captured 精确 selection，检查 viewer/workspace/revision 并拒绝迟到 target。本层 `useReference({sessionId, scopeKey, reference, signal})` 必须由可信 owner 绑定到实际 native Session/reference/span bridge；仅同步返回 native 输入真实接受的 boolean。缺 bridge 时原组件 readOnly，按钮保留；false/throw 沿原错误路径失败，不用 toast 文案伪造成功。

该 bridge 接收现有 `ReferenceDraft/ReferenceRevision`，不是 absolutePath。owner 必须保留 submit-time codec、当前资源资格和精确 revision/digest/checksum，后端/模型 carrier 仍需 MET-272/273 实装。true 仅表示 native input 接受引用，不证明模型读取或全文已消费。跨 Session/换 authority revision/tab 结束/owner unload 的旧意图被拒绝。

能力 owner 在真实原行的回调中使用 `actions.openMain(resolve)`：resolver 取当前允许的实际 `MainPanelId`，本层等待后再次核 Session/scope/lifetime，并检查公开 `slots.entries('main')` 确有该 key，才调用 native `layout.selectPanel`。null、未注册、晚到结果均拒绝。owner 应把 rejection 接回原有错误 controller；本层无静默 catch/自动重试/第二成功提示。

`pluginNavigation.openBundle` 是 native 插件管理详情，不是业务应用导航。settings profile 禁用该管理 UI，本层不重新开启它，不把 URL、显示名、`proof-panel` 或 `'plugins'` 当业务 fallback。实际 catalog/main 目标未接时不能称能力入口已业务交付。

## 生命周期与当前保证

native tab `signal` 只在 tab 删除/unload 时 abort，hide/session switch 不会自动 abort。此注册保持 native `keepMounted` 默认 false；body 以真实 `tab.visible` 渲染，组件自身 cleanup 取消其读，另以 local lifetime + native signal + owner signal 拒绝卸载后的 intent。scope 变化重建 body，旧 callbacks 在下一次 render 前也会以当前 owner key 拒绝。未增加轮询、超时或 retry。

所有原组件顶层 `on*` callbacks 保留参数、receiver、返回值和原错误，只增加当前 target 检查。capability children 仍由可信原 controller 拥有；本层传入受控 main opener，不扫描/重写其 React 子树。权限和真实操作收敛不能由这些 UI guards 替代。

`EmployeeMemoryManager` 的隐藏时停读不能只凭 active prop 推定。本层直接渲染 owner 提供的 `EmployeeMemorySidebar` props，controller 仍归 owner，未重新创建一个 Manager。若主线将未来 retained body 改为 keepMounted，须重新审阅其读/Modal 生命周期，不沿用当前卸载保证。

## 整合、验证与待做

固定组合已按 `qa/codex/met277-panels-20261121/implementation/INTEGRATION-HANDOFF.md` 接入 contribution bundle、同一 CSS 生命周期、公开 `bindEmployeePanels` runtime 导出、rc.2 sidebar-right 类型依赖和测试收集。client manifest 明确依赖 native Conversation/right sidebar；没有默认 owner。当前 port 类型直接引用真实 app props，是 monorepo source 边界；包不发布离树不能解析的 `panels-types`，不手抄另一套 DTO。

本轮完整 `employee-panels.test.tsx` 是无 Host/浏览器/DB/模型/VM 的单文件单测：真实 published SlotRegistry 的离线注册/卸载、synthetic owner/navigation faces、真实组件 identity/SSR、旧 toggle 默认字节相同、scope/Session/lifetime/unknown/refusal 与 late main guards。synthetic callback 调用不等于后台写入，SSR 不执行组件 effects，不证明真实请求取消、native Frame/docking、视觉或 SSO。

独立 `employee-panels.browser.test.ts` 经真实 tarball/公开 binder，使用显式 synthetic owner 和 Playwright route 的合成业务响应；未复制 ChatflowClient 或改产品 fetch。它覆盖四入口/切换/关闭、未知计数、Session/scope、卸载重绑、保留“＋”及 native 输入实际接受/旧 span 拒绝、可信 resolver 的实际 registered main/未知 key/晚到拒绝。合成引用 source 未连接真实 submit-time codec，测试不发送消息或模型请求。

该文件以固定 `4c2e1069e087e645365100850756afe742c35e3d` 的真实四组件及其传递 app/UI/contracts/global styles 回放 rev2；同数据/主题/内容预算，在 1440/390 亮暗各检查常规/空/加载/拒绝/长名，截图、细项 geometry 先保存再执行 ±0.5 和精确 RGBA 断言，软断言继续收完整组。native chrome 不重画，420px 是设计比较宽度而非产品固定宽度。此轮只写夹具并做静态/Node 检查，尚未启动 Host/browser，未声称已实际看图或 native docking/视觉通过。

主线须按最终组合 SHA 跑此完整浏览器文件及既有受影响侧栏/入口文件，另接真实授权“＋”与 submit-time codec、同 owner BFF 最小读写、交付真实 bytes/hash/授权复制和真实能力 main。settings teardown 的 native slot 生命周期门禁仍阻塞；本组合未绕过或修复它。MET-276 的附件 runtime owner 缺口不因本提交消失。

MET-225 待主线登记：AllRice rev2 四业务面板经公开 native 右栏/header 装入，真实 owner 显式绑定；原生分屏/关闭/窄屏不改，无私有复制；升级核 registry、槽名、标准 props/useTabInfo、native main/引用公开合同。MET-222：正式装配后按 owner/BFF 实际失败做健康收件，本票不新增虚假运行巡检。
