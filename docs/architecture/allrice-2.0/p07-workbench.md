# P07：版本化工件工作台与 Cline Diff 适配

MET-118 / B2 / S2 / R2，依赖 P06；批次、顺序和最终交付以唯一执行总表为准。

## 交付边界

`ALLRICE_WORKBENCH_ENABLED=1` 才显示入口，API 继续独立检查此开关与当前租户/成员身份。
左侧仍组织会话，中间保留对话与成果摘要，右侧审查精确版本；1100px 以下为抽屉。
Diff 首选本次 Changeset 的 before/after，不把工作区总变更或提案当作落盘成功。
旧交付物可以查看，历史 Run/执行位置缺失时明确标注未知，不构造虚假关联。

- 工件分页复用 P06 的版本 ID、StoragePort 和 50 条游标；旧页面不会被下一页覆盖。
- 同侧行号选择、手动行范围、整件意见；草稿和提交均绑定精确版本与 checksum。
- 保存回执丢失可幂等重试；旧窗口保留自己的编辑并报冲突，不覆盖较新草稿。
- 新版本不继承旧反馈的批准，旧版本只能查看；反馈关联的回应可以继续打开复核。
- 切换/关闭未保存编辑时提醒，浏览器刷新有 beforeunload；已保存草稿跨刷新读取。
- 抽屉有可访问名称、焦点回归、Tab 循环及 Escape；桌面不把非模态面板伪装成全局弹框。

P07 不派发新的文件动作，不把评论当作工具批准；P10 负责类型化交互和意见续跑，
P08 负责经过批准的精确应用/恢复。浏览器控制、完整 IDE、图片区域标注不在此切片。

## Cline 固定来源与实际复用决策

适配来源为 [Cline ToolFileDiff](https://github.com/cline/cline/blob/dac3b35ba485dbab3b5a73aca239b0d07ce071cf/sdk/packages/ui/components/agent-chat/tool-diff.tsx)，
commit `dac3b35ba485dbab3b5a73aca239b0d07ce071cf`，源码 SHA-256
`4a8d2765f2b0ba1150ca2c04463b0668bbed9d64072789c072941791c42dcc9c`。
已逐项核对其 package、LICENSE 和固定树；适用许可 Apache-2.0，Copyright 2026 Cline Bot Inc.，
该固定树没有需额外附带的 NOTICE/子目录许可。源码头和根 THIRD_PARTY_NOTICES.md 留存出处、修改说明与完整许可链接。

保留 `parseDiffFromFile` → React `FileDiff`、memo/options、主题和有限渲染恢复思路。
不引入 Cline Agent Loop、VS Code 宿主、编辑器或其单用户审批权威。AllRice 的版本、行锚点、
权限、反馈与文件应用仍走自己的服务端；不擅自给原文补 EOF 换行。

Cline 固定 UI 包声明可选 peer `@pierre/diffs ^1.3.0`。候选精确版本 1.3.0 安装失败：
其 theming 1.0.0 对 theme 的 peer 与实际 theme 2.0.0 冲突。采用兼容区间内精确版本 **1.4.1**，
其 theming 1.0.1 已修正声明；没有关闭 strict peer 校验或宽泛覆盖依赖。
包本身 Apache-2.0，Copyright 2025 Pierre Computer Company；锁文件固定完整性为
`sha512-rzvY9FeeYdGtVcErjNsW6tnrjpMb0DvGtgCFNuMoYT8wufE+gO1ZXAzKAc2VPRBS3Rl5HELEQ38WDlis4qZHkQ==`。
依赖包括 diff 9、Shiki 4、Pierre theme/theming；许可证随原包保留。

富 Diff 延迟 import，主题/语法由底层库分块加载，不是把整个编辑器预加载进对话。
本地生产构建中含适配器的 chunk 约 498 KB，gzip 约 140 KB（并非整个页面/所有语法包总量）。
独立浏览器验收入口包含完整可选语法资源的所有输出合计约 11.5 MB，不能把这个合计冒充首屏下载量。
此版本接受有界、按需加载的取舍；后续应持续观测真实设备首次打开的网络与渲染耗时，不能宣称已完成低端机性能验收。

## 资源和静态内容边界

- 服务端读取上限 512000 字节和实际 SHA 校验沿用 P06。
- 富 Diff 总文本 ≤120000 UTF-8 字节、≤2500 行、单行 ≤4000 字符；超限直接显示分页文本/下载。
- 固定 Pierre 1.4.1 会把解析选项传递到 diff 9；传入 500ms/3000 edits 限制，解析中止/异常展示兜底。
  这不是抢占式浏览器沙箱或整页性能保证；输入上限与分页才是额外的确定性边界。
- 完整前后文本每页 100 行，单个 Changeset 一次只渲染一个文件。富 Diff 失败重试最多 3 次；chunk/渲染错误由边界组件兜底。
- HTML/Markdown/SVG 只读文本，无 dangerouslySetInnerHTML/iframe/自动远程图片；非 UTF-8/不支持二进制只下载。
- 固定 PNG/JPEG/WebP MIME 才可用 data URI 静态图片。新增头部检查，限制单边 8192、总像素 1600 万；动画 PNG/WebP、MIME 伪装、截断/不支持头部降级下载。
  头部检查不是图片消毒器；真正解码仍是浏览器的固定栅格 `<img>` 路径，不能将任意活动内容放进此通道。
- API no-store/同源写校验/当前身份核验沿用 P06；读取失败不保留可选择的旧列表，预览失败有显式重试。

## 自审与真实验证（2026-09-08）

- 全仓普通测试 **983 通过、157 个专用环境用例跳过**；跳过不计通过。
- 实际 PostgreSQL 17 `allrice_b2` 随机 schema + 本机真实 Google Chrome：**55 通过、1 个 P05 VM 用例因本次未指定 VM 环境跳过**。
- 浏览器从真实 PG/StoragePort 读取合成工件；真实 Cline Shadow DOM 高亮、点击行号→正确 SHA/侧/行评论；丢失保存回执仍只一份草稿；刷新恢复；提交不创建文件操作；两个窗口旧 revision 写入 409 且新草稿不被覆盖；新版本过时入口失效；HTML/SVG 无脚本/外部请求；20000 行降级和第 101 行定位；390px 窄屏无横向溢出、焦点/Escape 正常。
- 验收入口 `apps/web/test/workbench-page.tsx` 只供测试打包，不是 Next 路由。循环回环服务使用合成登录和真实领域服务；它不冒充 Dev 的完整登录端到端验收。Next HTTP 入口另有身份/CSRF/缓存/恶意文本/撤销单测，批末仍须 Dev 集成验收。
- 本机截图保存在忽略目录 `.local/p07-browser-MWTT0S/`；另一次 `.local/p07-browser-AwKE2J/` 的桌面和手机截图已人工视觉核对。
- `pnpm lint`、`pnpm typecheck`、`pnpm build` 通过。没有迁移/启用 Dev 或 Prod，也未改变真实租户工件和 Bridge 配对。

回退关闭 Flag 即恢复旧 ChatFlow 入口；不删除工件或历史反馈。固定提交和 CI 以 PR 为准。
