# MET-160 原生侧边栏与工作台

执行原则：官方插件可用就直接接官方插件；只有确认具体适配缺口后，才取官方组件源码。不能因为发布包没有 React 组件导出，就跳过插件评估。Allrice 继续负责员工、会话、文件与审查数据，DSH 负责已有展示和交互能力。

## PR1：员工会话树

基线包含 PR #101–#106 的既有修复。使用 DSH `0.1.7-rc.1` / `46a7f68b0922371ce7144b668b90e377d8e799f4` 的 `ui-workspace` 原生 Rows、tree、locales 和 collapsedSessionRows，直接使用已发布 `ui-primitives` 包。

### 先检查官方插件的结果

检查官方 `ui-sidebar` / `ui-workspace` 的 manifest、README、公开导出和插件装配。ui-workspace 的 `client` 发布文件通过 `window.__ModuleLoader__` 注册插件，仅导出 apply / inject；发布包未包含其声明的 src 通配路径对应源码。插件安装需要既定 Loader / Slot 和 Session / Workspace 服务，缺少直接面向员工分组的配置。

随后在独立 Chromium 页面中运行官方**原样 WorkspaceBrowser** 及原生 store，投影一个“财务员工”分组与“财务核对”会话（不是生产员工）。浏览器无 JS 错误，会话正常显示；分组菜单实际出现“重命名 / 删除工作区”，轨态没有员工头像。源码确认 WorkspaceBrowser 对所有非空工作区固定提供这两种管理动作，没有隐藏 / 替换员工头部或定制轨态的公开配置。这次验证是原生视图的适配对照，不声称已将完整 DSH Loader 后端部署进 Allrice。

因此员工树复用官方源码组件；不把员工撤回假扮为删除工作区，不仅取样式后另写全部组件。插件已有的目录新建、fork、pin / archive 等后端动作不以空处理函数开放给用户。必要补充是员工头像和详情、显式员工新建、键盘可达性、作用域隔离的显示偏好，以及不展示尚无接线的菜单。原始来源校验和适配补丁记在 `apps/web/app/dsh-upstream/upstream.json`、`scripts/dsh-ui-patches/`。

### 业务行为

会话始终留在真实 employeeAssignmentId 下；撤回员工的可见历史使用冻结名称展示独立分组。单员工直接新建，多员工选择器由现有 DshDialog 承载；显式选择优先于 URL / 默认员工，失效目标不换人。草稿与附件切换沿用会话请求世代处理，未发送内容有明确提示。偏好按组织、工作区及当前用户隔离。

已授权的侧栏会话页一次批量读取真实运行、本人待审批 / 待回答事实，不逐会话轮询；当前打开会话沿用实时交互数据。历史分页及后续派驻机制沿用现有服务，MET-159 的业务职责保持独立。

## 后续 PR

PR2 接官方 Dock 包及已有成果内容；PR3 接官方文件树 / 预览与现有文件服务；PR4 完善可重复升级验证、复用清单及实际能力记录，退役重复代码。每个 PR 都应提供真实界面验证，不能仅凭编译通过标记已完成。

### 已验证的包接入补充

官方 ui-primitives 发布文件使用外部 React，却未声明 React peer；在 pnpm 严格依赖图中会落到现有 DSH 运行图的 React 18，而 Allrice Web 使用 React 19，Chromium 实测拒绝渲染旧版 Element。通过 packageExtensions 补上宿主 React / ReactDOM peer，未修改原生组件逻辑。使用 Zustand 4.4.7 公开兼容范围内的 use-sync-external-store 1.6.0 接 React 19。官方 UI 依赖 Cordis 4.0.4，按 Web 单独固定；Worker / DSH Admin 的已有工具包显式固定 rc.3，防止新增 Web 依赖提升原本隐式解析的运行图。`pnpm dsh:verify` 确认引擎仍为 rc.3。

### PR1 验证

15 个员工归属 / 新建请求单元用例、14 个 PostgreSQL 冻结发布集成用例通过。Chromium 合成 HTTP 环境中的原有 30 个工作台回归、2 个员工层级 / 选择器用例及 17 个消息与附件异步归属用例通过；原有断言保留，仅将会话选择定位改为真实原生 treeitem，主动离开草稿的竞态用例显式接受确认。没有调用模型、创建真实租户员工或更改授权。已检查展开树、选择器与头像轨截图。全仓格式、lint、类型检查及 Web 构建用于提交验证；GitHub CI 另行记录。

## PR2：官方 Dock 工作台

直接使用 `@deepseek-ai/dsh-client-ui-dockkit@0.1.7-rc.1` 的 DockLayout、原生标签键盘/拖拽、分栏、浮动及稳定标签容器，不复制布局引擎。DockController 的公开 API 未提供已保存布局的恢复入口，因此同时复用 ui-sidebar-right 的完整 stores / persistence，保留原生 JSON 验证、分栏规则和操作序列；只替换类型导入，并补上浏览器禁止读取 localStorage 属性时的内存回退。

作用域为组织 / 工作区 / 用户 / 会话；已有单列宽度偏好继续生效。宽度范围为 340px 至 80vw，同时预留实际侧栏和至少 340px 聊天宽度。全屏仍使用原生 layout.mode，标签不会因此重新挂载。官方 Dock strip 接现有 56px 标题基准，没有额外叠一层标题。

每份成果在独立标签中使用原有 ArtifactReview，版本、下载、Diff 和反馈继续走原接口。原生 keepMounted 保留切标签/分栏时的未保存意见；关闭对应标签或离开会话才确认。新增标签打开实际成果目录。所有已挂载标签的 dirty 状态汇总给原有导航保护。

PR2 验证：50 个 Chromium 回归用例逐项通过（全量 49/50 后修复新交付与已保存标签的恢复优先级，该用例与分栏用例再次通过）；新增用例验证两份成果并排、独立未保存意见、分隔线拖拽、全屏往返、拒绝关闭及刷新恢复。3 个偏好用例、Web 类型检查、定向 lint 与 Web 构建通过。并排截图已检查；此验证使用合成 HTTP 已有内容，没有重新调用模型。
