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

## PR3：原生文件树与预览

复用 ui-sidebar-files 的 FilesBody、store、DirectoryNode 和 face 生命周期；原生展开、目录刷新、面包屑及请求取消接现有授权文件 API。官方完整插件的 workspaceFilesRemote 绑定宿主 cwd，Allrice 只有对象 ID / 上传与交付分类，因此只替换传输接口和行显示名称，不另造文件系统。工作区文件入口默认显示，目录是实际对象分类，不是宿主路径。现有接口最多返回 100 项，达到上限明确显示截断提示；没有 watch API 时提供原生手动刷新，不宣称实时监听。Bridge 项目文件没有现成目录列表接口，本次不虚构该来源。

PDF 直接加载官方已发布的 client.pdf.js（包括其 PDF.js Worker），未另写渲染器。Allrice 只提供同源静态分发、限定模块注册和已授权文件字节；加载后恢复原 ModuleLoader。缩放容器及状态来自原生源码，因为它们未独立导出。代码展示直接使用官方 CodeBlock；Markdown 保留现有渲染路径：官方 MarkdownText 无关闭外部图片自动读取的配置，不能将租户文档直接换成未经适配的远程图片请求。

Office 继续调用现有 LibreOffice 页面/公式服务，将其结果接入原生缩放视图，保留分页、重算提示、版本、下载和反馈；本次没有重新实现生成、解析或公式引擎，也没有宣称接入上游交互工作表。文件预览复用现有授权与内容服务，读取完成后再次核对文件可见性；快速切换和卸载取消旧请求。

真实文档复核可将现有 `/render` 响应保存为 `docx.json`、`xlsx.json`、`pptx.json`，通过 `ALLRICE_OFFICE_PREVIEW_DIR=<目录> ALLRICE_RUN_BROWSER_INTEGRATION=1 pnpm exec vitest run apps/web/app/chatflow/workbench-layout.browser.test.ts -t 'MET160 real'` 验证真实图像、原生缩放及翻页；不提交租户文件或重新调用模型。常规 CI 使用合成 HTTP 覆盖真实 PDF 字节/Worker、文件目录刷新、删除失效、会话切换与既有 Office 公式/分页行为。

PR3 验证：52 个常规 Chromium 用例、3 个现有真实 Office 渲染结果用例、18 个内容/文件权限用例通过。Next 生产构建和启动实测 PDF 资源 SHA-256 与官方包一致。后台的 10 个真实 PostgreSQL/浏览器用例同时通过；这轮暴露的 Shiki 4.4.3 扫描器初始化问题通过固定上游锁文件的 4.3.1 解决，未改写高亮库。Worker 分发校验确认引擎仍为 0.1.5-rc.3。
