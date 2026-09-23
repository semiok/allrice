# MET-154 PR-2：固定 rc.3 候选与兼容适配

关联 [MET-154](https://linear.app/metasnowsky/issue/MET-154)，基于 [PR-1 #92](https://github.com/semiok/allrice/pull/92)。本次实现已选定的 `0.1.5-rc.3`，不跟随 npm 浮动标签。复用决策持续维护在 [DSH 复用与替换清单](../dsh-reuse-and-replacement.md)。

## 安装与发行身份

`upstream.json`、lockfile 和 Worker 握手现在指向 rc.3 / `a4c74a91e06b00fe0b0937bde982170c526cc842`。源码归档 SHA-256 为 `857c87442fd522ccdbd8c1091d8e2a516469a9b53c6b94948b3d174162b3370b`；npm 包完整性仍独立记录在锁文件。

`distribution.json.installedChannel=candidate` 表示此代码构建实际运行候选。`current` 保留原已批准的 rc.2，`rollback=null`；候选通过本 PR 不自动获得现网发布或回退资格。原有 `DSH_DISTRIBUTION_CURRENT_*` 导出名指当前构建所安装的代际，不代表生产晋级。

- Worker、Admin、搜索适配包的 DSH 依赖固定 rc.3；Cordis `4.0.2`、schemastery `3.18.2`、pi-ai `0.85.1`，timer `1.1.4`。
- 对原先自动解析的 16 个 DSH peers 显式 overrides，避免锁文件保留 rc.2 与 rc.3 的混合图。没有引入 alpha 包。
- 删除已停止发布的 spine/jsonrpc demo。受限 profile 显式组合 session、agent、loop、scope/invariants 等服务，`agents: []`；受控助手仅按现有开关加载。
- 助手冷恢复使用官方 session-query-sqlite，配置 `path: ':memory:'` / `openAt: never`。这只提供原生精确历史读取，SQLite 不会打开，模型查询工具未注册。
- `allowBuilds` 仍只有 esbuild/sharp；未放开 shell、PTY、任意目录、Team、Hooks 或动态插件执行面。安装了传递包不等于受限 Worker 挂载了其工具。
- Admin 的 WebUI 与 Worker 同步升级；Allrice Web 中保留的上游 CSS 没有替换，故其独立 provenance 仍为原版本。

## 桥接行为

| 变化                       | 适配及保持的语义                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Session.events` 移除      | 使用 `snapshotEvents()` 读取原生完整日志，不以模型文本猜测消息/工具采纳。                                                                                                   |
| question provider 接口移除 | 接入 `user-questions/request`；静止提问检查点、释放、确切答案采纳和同 Run 续接保持原流程。                                                                                  |
| persistence.load 移除      | 用只读 handle 读取/校验，关闭后再通过原生 resume 获得写租约；失败不能悄悄创建新会话。                                                                                       |
| subagent.followup 移除     | 使用固定版本 internal Host Queue 入口，保留 coordinator 来源及队列语义；不换成会 steer 的模型 `sendMessage`。                                                               |
| 原生 reportFrom/quiet 移除 | P24 实验记录新版相邻 Agent 消息会唤醒父助手；生产仍只采用经 Allrice 授权/结算的结果，没有注册原生消息工具。                                                                 |
| native delivery 内部类拆分 | 更新窄适配测试到 ContinuableActivationRegistry；权限、输出 grant、实际 report、未知用量和结算前拒绝仍由真实 PG 用例验证。                                                   |
| pi-ai 用量事件增加 total   | 原有 input/cache/output 含义保持；缺失用量仍为 unknown，不合成“零消耗”。                                                                                                    |
| 原生 WebUI 新增登录        | 受信任 Host 插件通过父子 IPC 提交原生登录 URL；网关内部换取并定时更新 cookie，不交给浏览器。未登录、错误 Host、伪造会话、跨域请求被拒绝；原生回环端口自身仍拒绝无凭据访问。 |

固定版本私有接口仍纳入 ledger：Host Queue、管理员 CLI 与源码补丁不能视为上游永久兼容承诺。

## 旧日志迁移与拒绝

PR-1 留下的四份不可变 rc.2 JSONL 来自真实旧 DSH、Allrice 适配器与本地合成模型。PR-2 直接读取这些原始字节及校验和，没有用新版重新生成旧记录。

两份最小源码补丁给 v0 格式清单和 JSONL 独立校验 worker 的内嵌清单增加相同四种事件：`allrice/wait/checkpoint`、`allrice/wait/continued`、`allrice/input/request`、`allrice/input/answered`。严格检查字段、UUID、digest、turn 与问题结构；仍拒绝未知必要事件，不设置 ignorable，不修改业务 payload。

打开写入句柄前，Allrice 进一步检查会话身份、turn 顺序、唯一问题/input ID、request→answer→continuation 关联。digest 仅是内容承诺，实际输入提交时仍由原有采纳逻辑比较，不能凭迁移生成采纳证明。含私有事实的 seeded/child 历史暂时拒绝，须走单独审查的路径。

原生 v0→v1→v2→v3 链负责序号及标准事件引用转换、完整日志校验、单写入者与新代际发布。成功迁移保留 `session.jsonl`，写入 `session.v3.jsonl`；拒绝预检的日志不发布 v3。测试比较源字节和私有 payload，验证重复答案、重复续接、进程重启及并发 writer 的拒绝。

rc.3 不再提供旧 `writeBatchMaxDelayMs` 调试配置。P24 的未 checkpoint 杀进程测试以实际落盘字节决定允许恢复的输入，而不是声称 ACK 必然持久或必然丢失；已 checkpoint 输入仍必须恰好采纳一次。

## 在途任务、冻结配置与回退

1. 发布前先停止旧代际的新派发，列出 active/awaiting-input/unknown 的 Run、root/child Session、租约、Clock、冻结 RuntimePackage 和 pending 操作。带助手树、工具未完成或 unknown 派发的 Run 由原 Worker 排空/核对；不能直接让候选接管。
2. 旧冻结配置仍可读。Worker 会在取凭据或启动 DSH 前拒绝与本构建代际不同的 `runtimeManifest.distributionGeneration`，错误为 `DSH_GENERATION_MISMATCH`。此校验不是自动多版本路由；schema 1 没有代际字段的旧配置必须在发布盘点时排空。
3. 在唯一源数据之外复制完整会话目录，保存原字节、哈希、数据库检查点与原部署 SHA；候选只使用副本和隔离 sessionRoot。普通历史及静止根问题通过迁移；seeded 私有历史和未知/损坏事实拒绝。机器拒绝不能代替在途业务盘点。
4. 新任务需在候选上重新构建/发布 RuntimePackage，绑定新的 generation；不得篡改已冻结的旧包来绕过 guard。待恢复的旧 Run 仍使用旧 Worker，除非另有经过验收的显式任务迁移流程。
5. **候选写入前回退**：确认无新模型/工具副作用后，撤销候选路由，恢复原发布与原副本。对新建候选 Run 不能硬改 generation 后回放。
6. **候选写入后禁止仅降级二进制**：旧 DSH 可能继续读取保留的过时 v0 文件，遗漏 v3 的新输入和工具事实。必须停派发、核对数据库/日志/外部操作；优先由候选排空或向前修复。只有验证过的逆向转换或一致备份恢复且核清新增副作用后，才允许该会话回退。不得删除 v3 文件冒充回退成功。

本 PR 的历史材料是固定合成模型日志，未复制真实用户会话内容。Dev 会话清单、真实旧会话脱敏副本、部署产物和写入后回退演练作为 PR-4 发布前门槛记录，不能用本地合成测试宣称已通过。

## 验证记录

验证日期 2026-09-23。原生测试运行安装的 rc.3 子进程；模型端点为合成 loopback，数据库为独立的本机 PostgreSQL 17 临时实例，不使用 Dev/Prod 的数据、授权或模型配额。

- `pnpm dsh:golden-replay`：6 个文件 / **67 项通过**，含单写入者迁移拒绝；覆盖受限握手、消息、搜索 Broker、工具、附件、Skill、取消、压缩、历史等待与进展暂停。
- P24 原生协作/冷恢复/杀进程：**5 项通过**；原生交付及 Codex wire 窄接口：**40 项通过**。
- 真实 PostgreSQL：**47 个文件 / 600 项全部通过，无 skipped**。覆盖 clock/progress/native-wait、P25 Worker 恢复、助手权限/交付/用量、MET-144 开发协作、冻结 Skill 与 MCP/运行策略。
- 管理员：**2 个文件 / 4 项通过**。`server.integration.test.mjs` 实际启动 rc.3，使用独立临时 home 与合成密码，同时验证原生直连仍为 401。
- 冻结锁安装、format、lint、全仓与跨应用 typecheck、build 通过。全量本机首次 2869 passed / 8 failed / 1107 skipped：8 个失败均为本地 Playwright 包内额外生成的 `node_modules/.bin` 被完整性检查拒绝。隔离生成物后 frozen install 通过，该文件 **8/8 通过**；未修改 Bridge 校验。CI 使用干净安装，完整结果以 PR 当前 SHA 为准。

本地无真实模型验收，未部署 Dev/Prod。MET-154 保持进行中，后续上游适配退役与 Dev 验收分别归 PR-3/PR-4。
