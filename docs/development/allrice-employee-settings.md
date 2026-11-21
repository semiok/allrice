# 员工设置公开接入（MET-279）

离当前目标还差什么：独立插件与端口已提供，组合线仍须接真实员工入口、原生shell渲染位、鉴权业务owner和安装门禁。模块源码存在不等于已进入profile、已安装或3.x功能已联合验收。

## 采用范围

规划线2026-11-21最新确认：设置主体使用DSH原生页+AllRice主题，3.x员工在用设置原样迁移；M1只新增“AllRice账号→打开账号设置”。通知两控件保留代码，以默认false功能开关隐藏，通道完成后另启。产品不出现设计预览/夹具/API未接文案。两图设计依据在QA `met279-employee-settings-20261121/preview/runs/r7`，最新“默认隐藏”修订覆盖图中可见通知。

本模块不改后台、3.x共享组件、数据库、wire schema或通知通道。DSH单代固定0.2.1-rc.2。

## 模块出口与宿主口

源码入口 `packages/dsh-web-composition/src/employee-settings.tsx`：

```ts
apply(ctx: Context, options?: EmployeeSettingsOptions): void;
bindEmployeeSettings(ctx: Context, port: EmployeeSettingsPort): void;
```

这些是本模块源导出；包级`./client`转发和build模块表尚由组合owner接入，不能把源码路径当已发布SDK。类型完整定义在同前缀 `employee-settings-port.ts`。

- `apply`只要求原生`slots`；经`ctx.inject(['allriceEmployeeSettings'])`等真实owner就绪后注册业务设置。没有默认业务port。native General等原生功能不在这里重新实现。
- `bindEmployeeSettings`由已鉴权owner在自己的Cordis lifetime中调用。port提供稳定不可变`getSnapshot`、`subscribe`、现有业务内容和动作；不接受浏览器/guest自报身份。
- `scopeKey`取可信owner的本人/员工/受管binding remount key；不是显示名或登录cookie。snapshot为null表示失权/无当前binding，不能用旧快照撑起可写页面。
- 模块向动作和内容传`{key, signal}`。scope改变、撤权、根销毁立即abort；旧按钮、旧launcher不再调用owner。owner仍必须把signal传到实际I/O，并按实时服务端权限授权，不能把这层UI检查当后端门卫。
- preference snapshot包含`values | null`、`pending`、`error`。null是未读到，UI不伪造默认；error必须是owner已有的安全用户文案。模块不乐观写偏好、不建第二份持久化、不启动轮询或自动重试。
- `reloadPreferences`和`setStreamingOutput`沿现有本人偏好reader/writer；异步pending、失败、权威值由owner发布。`openAccountSettings`打开原有账号完整界面；导航失败由owner既有错误呈现处理，不能返回假成功。同步切人时模块不会再close旧native面板。

### 原生入口转交

原生`settings.launcher` owner传入`openSettings`与`settingsOpen`。本模块的无DOM桥接组件通过`bindNativeLauncher`把这两项交回owner，形式为：

```ts
bindNativeLauncher({ scopeKey, settingsOpen, openSettings }): () => void;
```

owner将其绑定到既有`EmployeeSidebarPort.openEmployeeSettings` / snapshot `settingsOpen`；disposer只清掉自己的绑定，避免旧effect释放新binding。组件、scope和Cordis卸载均释放绑定；过期open函数即使被外部保留也不再打开设置。没有`ctx.settings.open()`，不模拟DOM点击，不接管原生开关状态机。

**共享渲染位仍需组合owner解决：** 当前employee-sidebar的shadow注册没有children，rc.2 renderer不会给它`renderSlot`，且会校验child所有权；直接补`renderSlot('sidebar.settings')`无效，重复声明又与原生ui-sidebar冲突。原生settings-general还依赖ui-sidebar模块。因此不能通过私有SettingsRoot、手工拼renderer props或CSS/DOM绕过；需要公开的合成/所有权接法，未绑定前不得报设置入口已迁入。

## 槽与DSH十项去向

业务注册只用公开槽，所有注册归注入scope生命周期：

| 槽 / id                                                          | 内容                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| settings.launcher / single priority -100                         | 原生open/state转交，无第二个设置按钮                                |
| settings.section / allrice-account                               | 已确认账号入口，公开Button调用真实owner                             |
| settings.section / allrice-computer、allrice-work、allrice-apps  | owner提供的原样现有业务内容；不拷贝组件或在DSH origin发3.x相对fetch |
| settings.general.item / allrice-streaming-output                 | 保留现有流式偏好，公开Switch与既有文案                              |
| settings.general.item / allrice-notifications                    | **仅显式notifications=true且具名port存在时注册；M1不注册**          |
| general.item / permission、developer-tools、session-log-deepseek | priority -100空贡献，仅员工呈现隐藏                                 |
| settings.action / open-document                                  | priority -100隐藏，仅员工呈现                                       |

| DSH项      | 员工处理                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| 通用       | 保留原生General/语言/外观/字号/步骤等；已有AllRice主题与本人偏好存储映射由owner接                         |
| 模型       | 组合profile不加载ui-settings-models；底层模型服务保留                                                     |
| Agent Loop | 不加载ui-settings-agent-loop员工UI；引擎/配置管理保留                                                     |
| 插件       | 不加载ui-settings-plugins员工管理UI；允许的业务能力入口另由能力模块提供                                   |
| 插件清单   | 不加载ui-settings-plugin-inventory；诊断/管理能力保留                                                     |
| Shell      | 不加载ui-settings-shell员工UI；原生运行服务保留                                                           |
| 子智能体   | 不加载ui-settings-subagent员工策略UI；深度/并发数据不删、不改数值，迁后台由owner负责                      |
| 联网搜索   | 不加载ui-settings-web-search员工UI；搜索能力保留                                                          |
| 会话日志   | 员工上传行隐藏；不启用DeepSeek日志上传，不与AllRice审计混用                                               |
| 账号       | 不加载ui-settings-account供应商账号UI及其launcher/onboarding；替换为AllRice账号入口，Host所需账号服务保留 |

profile确切插件ID/依赖由组合owner据当前manifest落地。本模块不注册空section来“删除导航”：原生shell导航读取raw entries，同id priority shadow只能替换内容，不能移除管理nav。插件main管理/market入口也须owner按员工能力边界检查，不因本模块隐藏几个row就算已隔离。

## 3.x功能保留映射与owner责任

| 功能                                     | 现有来源与接入要求                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 流式输出                                 | UserPreferences.streamingOutput；owner GET/PATCH me/preferences；本模块薄行只消费快照与动作                                                                               |
| 浅/深/系统、字号10–22、步骤四档/收起时机 | 直接原生组件/Host configForms；旧账号级值和全员工作用域必须由存储owner明确映射，不能悄悄变每员工独立或双向双写                                                            |
| 子智能体深度/并发、questionWait          | 员工控件迁出不删数据/schema/执行读取；后台不在此卡                                                                                                                        |
| 我的电脑                                 | renderSection(computer)：ComputerSettings、BridgeSettings、useBridge/useBridgeReleases等原样内容；设备/目录/安装/版本/能力状态及三个本地开关全部保留                      |
| 本机浏览器登录                           | BrowserLoginSettings的本人grant/清除登录确认/物理cleanup语义保留；`/api/v1/admin/local-browser`路径不等于员工无权，现有服务核member和本人grant                            |
| 工作方式                                 | renderSection(work)：WorkAutomationSettings与能力状态、云端项目开发开关；云端/电脑两自动开关、CAS、只读/失败/新会话生效语义保留，不改Full access                          |
| 已链接应用                               | renderSection(apps)：ConnectedApps原样，个人/共享范围、OAuth/令牌、登录/重连/断开/删卡保留；公司级配置不开放                                                              |
| 账号                                     | openAccountSettings：旧账号身份、退出、AccountPasswordSettings、MonthlyQuota、StorageUsage全部；密码网络结果未知/重登语义、observe/enforce/unknownUsage和存储null上限不改 |

`renderSection`必须返回真实原样业务组件，不能null占位或假卡片。老组件依赖app hooks、router和相对fetch时，由可信owner在其原有AllRice上下文中接入并处理跨origin；本模块没有复制它们、改它们的fetch或新造HTTP路由。当前源码只建立接缝，**这些原样组件在真实D组合中的功能仍须联合验收**。

## 通知开关

`EmployeeSettingsOptions.notifications`缺省false，apply时捕获该值，后续修改旧options对象不会把隐藏行暴露。M1不注册通知row，也不读取/写入通知port。

以后显式true必须提供具名`EmployeeNotificationPreferencesPort.reload/set`，且owner snapshot发布`taskCompleted`、`needsConfirmation`两bool值/状态；缺port直接拒绝接入，不显示可点击但无效果的stub。它是本模块**拟议的宿主UI端口**，不是声称当前有通知DB/wire schema/API。没有通知发送方法、通道、额外默认、数据库或持久化扩展。

## 五面、四类与验收

后端：只消费原有各模块公开服务，私有数据仍归各owner；MCP：none，模型不管理设置；员工UI：present；后台：none，用户明确员工端；权限：可信当前本人/员工/企业策略由M1-12和业务服务负责。门卫仅消费已有服务并取消旧UI请求；存储仍由原有服务/DSH Host settings负责；账本/租约无新增。没有Agent状态机/执行默认改写。

Node单测使用真实Cordis与发布的SlotRegistry、公开Button/Switch，覆盖默认隐藏、具名port、业务入口、scope取消/过期回调、原生launcher释放和槽重声明。原生renderer是client-only，不以SSR冒充整页；组件SSR只核真实获胜贡献。

`tests/employee-settings.browser-cases.ts`交组合安装suite调用`employeeSettingsBrowserCases(harness)`；owner必须每用例重置受控鉴权夹具，统一创建/关闭单Chromium+真实安装Host，不在case文件另开资源。harness签名在文件中，需真实业务组件/BFF夹具与native launcher绑定。它不是已存在的安装helper导出；本轮未执行浏览器。

窗口命令由owner在实际安装suite接入case后执行：

```sh
ALLRICE_RUN_BROWSER_INTEGRATION=1 ALLRICE_BROWSER_EXECUTABLE=/absolute/existing/chrome ALLRICE_COMPOSITION_TEST_ARTIFACT_DIR=/absolute/fresh/qa pnpm exec vitest run packages/dsh-web-composition/tests/installed-profile.browser.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile=/absolute/fresh/qa/installed-profile.json
```

命令指向owner已有文件，当前尚未调用这些case，不得现在运行并把空覆盖写成通过。需owner同步测试脚本/CI收集及资源声明：新unit无PG/浏览器/模型；浏览器case挂实际安装文件，browser=true、PG/model/VM=false，串行窗口。真正的旧组件行为仍跑受影响既有完整文件，详见QA inventory；Node端口测试不抵扣旧密码/Bridge/OAuth等用例。

风险与未做：原生shell渲染位、账号全员工偏好→Host单权威映射、真实业务port、M1-12 HTTP/WS/remote.settings敏感namespace权限均待组合owner；无browser/build/profile安装/真实model/Dev/独审结论。节点4按固定组合树门禁和本人工作日认可收口，不以源码/单测完成宣布整卡ready。

MET-225待主线登记：员工管理UI隐藏、AllRice账号替代供应商账号、保留既有流式行；通知默认隐藏依据本次裁定，不启通道。原生语言/主题/字号/步骤组件保留，既有默认/持久化差异沿各owner账目核对。
