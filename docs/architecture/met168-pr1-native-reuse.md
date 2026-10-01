# MET168 PR1 推荐任务：实施前原生复用核对

核对日期：2026-10-01。实现基线：`1b22ec155f8fa569be3533d236ca5c1599cb43a3`。

Web 使用锁文件中的正式发布包 `0.1.7-rc.1`，来源为
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/46a7f68b0922371ce7144b668b90e377d8e799f4)
（MIT，源码 SHA `46a7f68b0922371ce7144b668b90e377d8e799f4`）。
`pnpm install --frozen-lockfile` 后核对了实际发布包的类型入口和实现；
来源、既有组件哈希继续由 `apps/web/app/dsh-upstream/upstream.json` 与
`scripts/dsh-ui.mjs` 校验。npm 官方 registry 的 dist-tags 另有 `next`
候选版本；本次不变更现有经过审核的 DSH 版本。

| 原生入口与当前接入                                                                                                                                                  | 复用结论                                                                                                                        | 必要的 AllRice 接线                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh-client-ui-primitives/lib/types/index.d.ts` 的 `Menu`、`MenuItemButton`；实际 `Menu.d.ts` 支持 `portal`、`side=top`、`autoFocus`、`items`、`children`、`footer` | 直接使用正式包的锚定菜单、菜单项与键盘处理。Esc/Shift+Tab、方向键、选择后的焦点返回由原生组件处理                               | 将已生效员工版本中的最多 5 条展示模板映射为菜单项；不另建菜单或轮询                                                                       |
| 同一公开入口的 `Modal`、`Input`、`Button`；`Modal.d.ts` 支持 body portal、Esc、遮罩关闭和内容/底部槽                                                                | 参数及小屏列表直接使用原生 Modal，参数文字使用原生 Input，有限选项使用原生 HTML select                                          | 原生 Modal 无输入参数表单的焦点圈与恢复；在该表单容器内补齐焦点约束，阻止参数 Enter 冒泡到聊天发送；不复制 Modal 源码                     |
| `dsh-client-ui-conversation` 正常插件 `apply(ctx)` 和 `client/skeleton/InputBar`；输入条有 `accessory` 槽但需要原生 Session/input/attachments/projection Host       | 不以“未独立导出”为由重写。已有 AllRice `ChatComposer` 正是当前 SaaS Host 适配：复用记录的 `InputBar.module.css` 与受控 textarea | 在既有输入条工具区域放入口；新工作常用任务占固定布局，不改变 Rice 标题或工具/消息顺序。不改编辑器、队列、Agent 或输入法实现               |
| `CapabilityContent` → `ChatFlowClient` 已有准备任务到草稿的动作                                                                                                     | 抽出共同的纯草稿追加和选择位置计算，推荐与已有能力入口共用                                                                      | 保留附件/引用数组与发送路径；只更新普通草稿文字、尺寸和焦点，不创建消息、Run、工具调用或授权                                              |
| 定义 → immutable revision → normal publication → tenant manifest → EmployeeHub/workspace                                                                            | 在原链路传递可选展示元数据                                                                                                      | 缺省字段不补写历史定义；默认任务在安全读取投影中按当前版本的实际工具/Skill/拒绝策略匹配。展示元数据不写入 runtime package 或 systemPrompt |

PR1 仅固定任务、基础参数与现有准备入口。财务、运营（含公文/行政）、
程序员和科研人员使用同一协议；没有新增员工、Skill、动态建议、公司范本或模型调用。

## 已实现的接入与版本依据

`taskSuggestions` 是可选展示元数据，最多 8 条。显式配置沿现有的保存、
预览、发布与更新已配发租户链路传播；普通成员直接获得安全投影。
投影只包含模板、参数和自然语言准备入口，不返回模板内部工具/Skill 引用。
字段缺省时按实际冻结能力读取内置模板，字段为 `[]` 时尊重管理员的移除。
旧定义、revision、runtime package 和 checksum 不因读取默认模板而改写。

已有 Session 的推荐使用配发记录的 `currentVersion`。依据是现有
`packages/database/src/workspace/service.ts` 的 `sendChatMessage`：真正发送时
读取当前 assignment 的 `employee_version_id`，下一轮采用该版本，已经入队的
Run 继续使用自己的冻结快照。仅展示或填草稿不刷新 Session 版本。
发布集成测试覆盖旧 Session 仍固定旧版本的情形，断言安全投影与下一次真实
发送一致、读取没有重绑 Session、历史 Run/员工版本不变，以及另一公司不可见。

## 本地验证与交互实测

2026-10-01 的定向验证结果：

| 检查                                                        | 结果与覆盖                                                                                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 7 个契约、能力投影、冻结包、草稿与既有输入保护测试文件      | 38 项通过；包含四类职能、Office 实际 Skill/工具校验、旧字段缺省、显式空配置及安全投影                                                     |
| `tenant-employees.integration.test.ts`                      | 7 项通过；使用专用测试数据库 `allrice_b2` 中的随机隔离 schema，保留现有禁止业务数据库的 guard                                             |
| Chrome `composer-isolation.browser.test.ts` 定向运行        | 9 项通过（8 项推荐交互与 1 项既有附件菜单回归）；1440/390 宽度、参数、IME、追加、附件/引用、跟进发送、切换会话、准备入口与标题/滚动稳定性 |
| `pnpm dsh-ui:verify`                                        | 75 个来源文件校验通过；DSH 版本、组件源码与样式保持一致                                                                                   |
| 涉及包的类型检查、改动文件的格式/lint 与 `git diff --check` | 通过                                                                                                                                      |

点击计时使用真实 Chrome 154.0.8037.59（headless，darwin/x64），
在已有 UI 数据加载后，从任务项的 click 事件到下一动画帧草稿文字就绪。
2026-10-01 15:53:34（Asia/Shanghai）的本地测试记录如下：

| viewport 宽度 | 点击到草稿就绪 | 样本 |
| ------------- | -------------- | ---- |
| 1440 px       | 102.0 ms       | 1    |
| 390 px        | 18.6 ms        | 1    |

原始记录由测试写入本地忽略目录
`.local/met168-recommendation-evidence/click-to-draft.json`。
本次运行同时有其他检查负载；该记录是两个单次交互样本，不代表延迟分位数或
Dev 设备性能。点击路径无需推荐请求或模型调用，浏览器测试也断言没有新增
消息/Run 请求；真正发送仍经过原来的 Enter/发送与队列路径。

本记录只说明本地实现与检查。生产构建、合并后的完整检查以及 Dev 上普通成员
的真实页面、Run 和成果验证由主任务串行执行，尚不据此宣称已经上线。
