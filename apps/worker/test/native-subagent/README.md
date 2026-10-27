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

## 两个宿主的行为基线

```sh
node apps/worker/test/native-subagent/baseline.mjs \
  /path/to/isolated-dsh-0.2.1-rc.2/node_modules/.pnpm/node_modules \
  /tmp/native-subagent-baseline.json
```

参考安装必须包含同代 `dsh-base`、`dsh-web-app` 和它们的依赖。脚本只读参考安装；所有 profile、凭据空文件、工作区和会话写到独立临时目录并清理。两个独立进程运行同一套合成模型脚本，模型内容块沿用 p24 的工具调用/文字形状；这里直接通过公开 `LlmAdapter` 注入，避免实际供应商 HTTP、重试与账户对比混入生命周期基线。

原生侧加载发行包的 base、web 和 standard preset，关闭未使用的浏览器 socket、首轮标题模型请求；实际使用 SDK 作为离线传输。Worker 侧加载生产 restricted profile，加本目录的测试插件。原生的提示词、模型选择设置、其他 standard 工具保留，断言不依赖模型措辞。对比每个子级的 `catalog → agent-message → subagent-settled` 顺序、模型收到的容量/深度错误原文、running/inactive 列表状态和 wait 在所有结算之后返回。并行子级之间不规定全局完成顺序；随机 ID 归一为目录 label。

完整参考安装不进入 Worker 依赖：试装 base/web 即使放 devDependencies，也会经可选依赖改变执行包。这里只留下三个未改变生产闭包的同代 devDependencies。基线需要独立参考安装，因此不伪装成普通 CI 已运行的测试；普通 CI 跑本目录的 Worker 行为测试。

## 共用入口

- `DshProtocolClient.wait(sessionId)`：直接发 `session/wait`，不用短 RPC 超时；进程失败和原生拒绝原样上交。Worker 的 lease/cancel 仍负责生命周期。
- `apps/worker/dsh/allrice-agent-tree.mjs` 的 `noRunningDescendants(root)`：以 `root.ctx.agents.list()` 和公开 `isOwnedBy()` 读当前树，排除根自身和无关根；供问题卡 PR6 使用。
- 同文件 `treeQuiescent(root)`：再要求根 `nextStep`、`nextTurn` 都为空；供交付检查 PR1b 使用。

`root` 是 `server.requireRoot(sessionId).agent`，不是会话字符串。这两个同步谓词不检查根的 idle/提问状态、不覆盖尚在创建的 activation、不锁住后续输入；调用方负责前置条件及 await 后重查。它们不能替代 `session/wait`。PR0 只交付接口，不接入旧助手或线上收尾逻辑。

## 实测索引与边界

| T   | 本 PR 的证据和结论                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | `lifecycle`：父不在线时无通知；在线时 wait 覆盖子级完成与父后续轮次；T6 覆盖中断结算。                                                                                                                                     |
| T2  | `policy`：全局 guard、agent/request、llm/stream 看到子/孙级，guard 的 exec.agent 是实际调用者。订阅预检仍需保留 Worker 的冻结快照接线，不能由 DSH 中间件通过推断新原生路径已接好；旧路径另跑订阅/预检测试。                |
| T3  | `policy`：默认并行 8；容量释放后没有累计上限；volatile 更新不重建 fiber，调低不杀现有子级；冷启动读到环境值。原生模型工具读取 resolveMaxDepth；宿主 startActivation 的 request.maxDepth 需由调用方传入。                   |
| T4  | `policy`：全局收到孙级 start/end；created 早于模型请求。                                                                                                                                                                   |
| T5  | `persistence`：两个进程竞争写锁，第二个被拒；SIGKILL 后 inactive、不重放；sendMessage 冷恢复，日志补 interrupted 后完成，再发结算通知。                                                                                    |
| T6  | `lifecycle`：空 inbox 中断后结算；非空停放、占容量；再次 interrupt 无操作。                                                                                                                                                |
| T7  | `questions`：多个通知按结算次序排在阻塞问题的 inbox；回答后领取。问题卡 PR1 的恢复测试验证 detach 后 answer 的第一步同时收到通知和回答。                                                                                   |
| T8  | `policy`：原生允许 cwd=/，header.cwd 仍是原工作区；测试 profile 没有租户门卫。工作区权限须由后续 PR3a-2 的公开门卫接缝检查，不可声称 workingDirectory 自带该限制。                                                         |
| T9  | 方案已取消模型选择实测。                                                                                                                                                                                                   |
| T10 | `lifecycle`：drain 后原根拒绝 DRAINING，recover 换根后恢复委派。                                                                                                                                                           |
| T11 | `persistence`：原生四桶在各自会话（含冷子级）；根不自动汇总子级。新 PG 账本尚未实现，完整对账归 PR3b。                                                                                                                     |
| T12 | 新原生子级导出到独立交付检查尚未接线；验收归 PR1/PR3a-2。PR0 未改变 Office 调用。                                                                                                                                          |
| T13 | 方案已取消按段开关实测。                                                                                                                                                                                                   |
| T14 | `lifecycle`、`wait-client`：wait 等后续轮次、跳过停放子级；区分根 inbox、孙级、无关根；创建中的 activation 只能由 wait 覆盖。recover 与 wait 并发可能先返回成功，不能仅靠 disposed 错误判定取消来源；Worker 保留原生错误。 |
| T15 | v2.3 未定义此编号。                                                                                                                                                                                                        |
| T16 | `persistence`：fork 继承完成历史、不继承当前轮，结束后可冷续聊。旧日志另外复用 dsh-legacy-replay；新路径完整升级语料归切换 PR。                                                                                            |
| T17 | `policy` 和双宿主基线：容量/深度错误原文进入下个模型 step，深度 0 工具仍可见。                                                                                                                                             |
| T18 | 指定基线 4da2295d 的 schema 仍 strict，但 nativePreferences/subagentMode 已是 optional；contracts 完整快照测试接受有/无字段。部署与旧于该兼容版本的回滚另行核实。                                                          |
| T19 | `lifecycle`：停放跨轮驻留、list 为 running、占容量；sendMessage 续跑并结算。宿主进程消失的清理/冷恢复由 T5 覆盖。                                                                                                          |

测试断言写的是固定版本原生事实，不是让 AllRice 新增生命周期策略。更改这些断言前应先核对 DSH 升级语义。PG、最终交付和 UI 尚不存在的接线不在 PR0 伪造实现。
