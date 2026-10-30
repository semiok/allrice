# MET-210 #7 PR0：原生子智能体实测

固定 DSH `0.2.1-rc.2`。测试使用真实 Worker JSON-RPC 宿主、DSH loop、工具、公开服务和临时 JSONL；模型为合成流，不读订阅凭证，不调用外部模型，不连接共享 Dev。

```sh
export PATH="$HOME/.local/opt/node-22.23.2/bin:$PATH"
pnpm --filter @allrice/contracts build
pnpm exec vitest run --maxWorkers=1 apps/worker/test/native-subagent \
  apps/worker/dsh/allrice-question-detach-native.test.mjs \
  packages/contracts/src/employees.test.ts
```

这些测试由普通 `pnpm test` 自动收集。T7 的 detach/恢复/answer 链直接复用问题卡 PR1 的 `allrice-question-detach-native.test.mjs` 中 `keeps a real child settlement...`，不复制另一份。T18 复用 contracts 的完整执行快照解析测试。

MET-230 C2 的 `controls.test.mjs` 从生产 Host 的内部子控入口走真实公开 `prompt` / `interruptByParent`：一个子级停止不清父问题/不动兄弟；完成/idle 子级及授权等待中自然完成仍 accepted no-op；真人子消息不答父题；冷 child 同 ID 的 queue/steer；输入关闭、Run end、Host epoch 和租约期限取消在途恢复；原生 abort 期间新输入会在收敛后唤醒，已有 inbox 保留。父注册表缺席一例只在公开 `agents.get` 注入读故障，不夺取原生所有权句柄，也不冒称真实父 dispose 实景。`control-authority.test.mjs` 通过真实 SDK JSON-RPC 两端、Host/native child 与连续两次 adapter.execute，验证 single Stop 取消 Host 等待后旧 Worker tool/model authority/modelPreflight 成功或拒绝均不停止后继 B，当前 B 真撤权仍停止。仅进程放置在测试内注入；没有可执行 wrapper 的 close receipt 保持 unconfirmed，不伪造关闭证明。`wait-client` 区分接收 ACK、超时 unknown 与实际取消，不自动重发；`dsh/run-scope` 核当前 Run/Job/epoch/source。上述合成模型验证不替代 C3 网页入口、持久命令票或 Dev 实景验收。

## 两个宿主的行为基线

```sh
node apps/worker/test/native-subagent/baseline.mjs \
  /path/to/isolated-dsh-0.2.1-rc.2/node_modules/.pnpm/node_modules \
  /tmp/native-subagent-baseline.json
```

参考安装必须包含同代 `dsh-base`、`dsh-web-app` 和它们的依赖。脚本只读参考安装；所有 profile、凭据空文件、工作区和会话写到独立临时目录并清理。两个独立进程运行同一套合成模型脚本，模型内容块沿用 p24 的工具调用/文字形状；这里直接通过公开 `LlmAdapter` 注入，避免实际供应商 HTTP、重试与账户对比混入生命周期基线。

原生侧加载发行包的 base、web 和 standard preset，关闭未使用的浏览器 socket、首轮标题模型请求；实际使用 SDK 作为离线传输。Worker 侧加载生产 restricted profile，加本目录的测试插件。原生的提示词、模型选择设置、其他 standard 工具保留，断言不依赖模型措辞。对比每个子级的 `catalog → agent-message → subagent-settled` 顺序、模型收到的容量/深度错误原文、按工具调用 ID 提取的 `list_agents` 真正结果（逐个子级核对 ID、running/inactive 和 label）和 wait 在所有结算之后返回。并行子级之间不规定全局完成顺序；随机 ID 归一为目录 label。

完整参考安装不进入 Worker 依赖：试装 base/web 即使放 devDependencies，也会经可选依赖改变执行包。这里只留下三个未改变生产闭包的同代 devDependencies。基线需要独立参考安装，因此不伪装成普通 CI 已运行的测试；普通 CI 跑本目录的 Worker 行为测试。

## 共用入口

- `DshProtocolClient.wait(sessionId)`：直接发 `session/wait`，不用短 RPC 超时；PR3a 把未确认的完成映射为不可自动重放的 `DSH_WAIT_FAILED`，原始拒绝保留在 cause。Worker 的本地 lease/cancel 来源仍决定取消，不能把并发 recover 的 wait 返回当完成。
- `apps/worker/dsh/allrice-agent-tree.mjs` 的 `noRunningDescendants(root)`：以 `root.ctx.agents.list()` 和公开 `isOwnedBy()` 读当前树，排除根自身和无关根；供问题卡 PR6 快速拒绝。
- 同文件 `treeQuiescent(root)`：再要求根 `nextStep`、`nextTurn` 都为空；供交付检查 PR1b 快速拒绝。

`root` 是 `server.requireRoot(sessionId).agent`，必须是当前存活对象。三个入口的完成契约**只对原生投递路径成立**，不覆盖旧助手异步 bridge；用户 2026-10-27 决定 v3 先删旧助手层和测试数据，不做新旧并存。

两个谓词只能**快速拒绝，不能单独放行**：不检查根的 idle/提问状态、不覆盖在途创建、不锁住后续输入。子级已 idle、仍在 flush/dispose、结算尚未进入根 inbox 时，二者也都为 true；DSH maintenance 的状态同样是 idle。T14 用公开 `session/flush` 闸门固定该窗口，证明此时 `session/wait` 仍未返回。

PR1b 的最终修正先完成 `session/wait`，再检查根状态、输入边界和谓词；问题卡 PR6 的 detach 先用谓词快速拒绝，再等 `ctx.subagents.waitForChildren(root)`，之后才 flush 和重查（根阻塞在提问时不能用等待根空闲的 `session/wait`）。停放子级不阻塞原生等待。两个同步谓词语义不变，不引入结算状态。PR0 不接入线上收尾。

recover 已经通过 `closeRoot → sdk.shutdown → drainDescendants` 收子树。当前固定版本的并发测试观察到 wait 在根 dispose 前返回成功；这是一个允许的时序，不是保证。Worker 不能只靠 disposed 异常认定取消。`waitRoot` 也可能拒绝 `QUESTION_DETACHING` / `INPUT_SESSION_NOT_LIVE`。停止通知先 inject 到旧根，随后 DSH 根 handle.dispose 以 `cancel({kind:'disposed'})` 清 inbox：恢复日志有插入和 canceled 两段，恢复后的 inbox 为空。取消顺序及错误映射留给 PR3a-1。

## 实测索引与边界

| T   | 本 PR 的证据和结论                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | `lifecycle`：父不在线时无通知；在线时 wait 覆盖子级完成与父后续轮次；T6 覆盖中断结算。                                                                                                                                                   |
| T2  | `policy`：全局 guard、agent/request、llm/stream 看到子/孙级，guard 的 exec.agent 是实际调用者。订阅预检仍需保留 Worker 的冻结快照接线，不能由 DSH 中间件通过推断新原生路径已接好；旧路径另跑订阅/预检测试。                              |
| T3  | `policy`：默认并行 8；容量释放后没有累计上限；volatile 更新不重建 fiber，调低不杀现有子级；冷启动读到环境值。原生模型工具读取 resolveMaxDepth；宿主 startActivation 的 request.maxDepth 需由调用方传入。                                 |
| T4  | `policy`：全局收到孙级 start/end；created 早于模型请求。                                                                                                                                                                                 |
| T5  | `persistence`：两个进程竞争写锁，第二个被拒；SIGKILL 后 inactive、不重放；sendMessage 冷恢复，日志补 interrupted 后完成，再发结算通知。                                                                                                  |
| T6  | `lifecycle`：空 inbox 中断后结算；非空停放、占容量；再次 interrupt 无操作。                                                                                                                                                              |
| T7  | `questions`：多个通知按结算次序排在阻塞问题的 inbox；回答后领取。问题卡 PR1 的恢复测试验证 detach 后 answer 的第一步同时收到通知和回答。                                                                                                 |
| T8  | `policy`：原生允许 cwd=/，header.cwd 仍是原工作区；测试 profile 没有租户门卫。工作区权限须由后续 PR3a-2 的公开门卫接缝检查，不可声称 workingDirectory 自带该限制。                                                                       |
| T9  | 方案已取消模型选择实测。                                                                                                                                                                                                                 |
| T10 | `lifecycle`：运行中和停放子级被 drain 后离开注册表，原根拒绝 DRAINING；recover 不自发请求模型，新根能正常委派。                                                                                                                          |
| T11 | `persistence`：原生四桶在各自会话（含冷子级）；根不自动汇总子级。新 PG 账本尚未实现，完整对账归 PR3b。                                                                                                                                   |
| T12 | 新原生子级导出到独立交付检查尚未接线；验收归 PR1/PR3a-2。PR0 未改变 Office 调用。                                                                                                                                                        |
| T13 | 方案已取消按段开关实测。                                                                                                                                                                                                                 |
| T14 | `lifecycle`、`wait-client`：wait 覆盖在途创建、idle 后的在途结算与父续轮，跳过停放子级；创建闸门关闭跨一次事件循环仍未返回，移除 waitForChildren 的变异失败。recover 并发可能先成功返回；插入/取消停止通知均留有日志。                   |
| T15 | v2.3 未定义此编号。                                                                                                                                                                                                                      |
| T16 | `golden/` 固定原生 JSONL：冷宿主恢复历史、catalog 和待领取结算通知；根和冷子级续聊均保留历史，旧工具不重放。fork 继承另按场景 19 命名。用户 10-27 决定旧助手数据删除，不补旧助手黄金语料。                                               |
| T17 | `policy` 和双宿主基线：容量/深度错误原文进入下个模型 step，深度 0 工具仍可见。                                                                                                                                                           |
| T18 | 指定基线 4da2295d 的 schema 仍 strict，但 nativePreferences/subagentMode 已是 optional；contracts 完整快照测试接受有/无字段。部署与旧于该兼容版本的回滚另行核实。                                                                        |
| T19 | `lifecycle`：停放子级跨根轮次驻留、占容量；服务层 activity 为 running，但模型的 list_agents 按调用 ID 取结果，逐个验证为 inactive，含 ID 和标签；sendMessage 续跑后结算。停放后进程重启的消息顺序留后续，T5 只覆盖运行中子级的崩溃恢复。 |

测试断言写的是固定版本原生事实，不是让 AllRice 新增生命周期策略。更改这些断言前应先核对 DSH 升级语义。PG、最终交付和 UI 尚不存在的接线不在 PR0 伪造实现。

## 原生黄金语料

`golden/manifest.json` 记录固定版本和 SHA-256；`root.jsonl` / `child.jsonl` 来自真实 Worker 宿主、原生 subagent / list_agents 工具和合成模型。根派生子级，子级完成后通知进入仍在运行的根 inbox；捕获前根以 keepInbox 停止并 flush，捕获点在宿主 dispose 之前。工作区路径与子级 ID 做了归一，其余日志保留。测试先将固定语料装进全新的临时会话目录，再启动宿主；不是当场生成一份历史来证明自己。断言历史事件前缀、历史工具结果、通知 ID 保留，根领取旧通知后冷续聊子级产生一条新通知，历史工具调用数不增长。

## MET-228 / PR3a：公开宿主和真实 Worker 链

`run-admission.test.mjs` 在同一生产宿主上验证父子孙真实身份、绝对/符号链接 cwd 越界、无活跃 Run 的迟到模型唤醒拒绝、跨原生 turn 的 Run steer、wait 后拒绝输入、先收后代再清根 inbox，以及 recover 后再次委派。`run-scope.test.ts` 只测试 Worker 对有序身份观察的拒绝边界。

`test/p25/run-delivery-worker.integration.test.ts` 通过真实聊天入队、Worker、公开 JSON-RPC、原生工具及隔离 PostgreSQL 验证子级身份/进度（无绕过桩）、根与子级逐次通用订阅预检、工具执行前撤权阻断、后代结算唤醒根并提交。`run-delivery.integration.test.ts` 验证只读无锁 Run 权限及租户/代次/租约/撤权拒绝；数据库 `runtime-governed-bridge.integration.test.ts` 覆盖旧 turn 输入和跨 turn 的 Run 采纳、错 Run 拒绝及历史投影。全部由现有 Vitest/CI 收集。

原生依据均为 `0.2.1-rc.2`：`dsh-subagent` README 的父子消息/驻留语义及 `lib/index.js` 的公开 `subagent/start`、`drainDescendants`；`dsh-agent` 的 `agent/created`、`isOwnedBy`；`dsh-tools` README 的异步 pre-execute 与单调 guard；`dsh-working-directory` README 的有效 cwd 与 `ensure`；`dsh-sdk-jsonrpc-server` 的 `wait`。不调用 internal。委派只在测试 profile 安装，生产委派、子级用量归根、网页卡片/控制仍待后续 PR，不能以这些测试宣称已恢复。
