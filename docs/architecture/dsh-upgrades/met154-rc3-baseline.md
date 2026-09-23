# MET-154 PR-1：DSH 升级基线与兼容门槛

复核日期：2026-09-23。关联 [MET-154](https://linear.app/metasnowsky/issue/MET-154)；持续决策入口是 [DSH 复用与替换清单](../dsh-reuse-and-replacement.md)。本 PR 交付差异审查和回放基线，不升级运行时。

> 本文记录 PR-1 时点。PR-2 的已实现差异、候选发行语义和验收结果见 [兼容验收](met154-rc3-compatibility.md)；下文探针拒绝记录作为历史证据保留。

## 选版与出处

| 项目         | 固定值 / 本轮结论                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| Allrice main | `a77c6403775b82b8bb40c39a4059c79bd8e186a5`，#89/#90/#91 已合并，主干 CI 通过                                |
| Dev 验收代码 | `add83cbbbf5df2c78578596ed0070af5e3d30e76`，与上述 main 文件树一致；本 PR 不重新部署                        |
| 当前 DSH     | `0.1.1-rc.2` / `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`，机器事实见 `apps/worker/dsh/upstream.json`       |
| 评估候选     | `0.1.5-rc.3` / `a4c74a91e06b00fe0b0937bde982170c526cc842`，[固定发布标签][release]；候选仍为 RC             |
| 候选源码归档 | [按 commit 下载][archive]；SHA-256 `857c87442fd522ccdbd8c1091d8e2a516469a9b53c6b94948b3d174162b3370b`；MIT  |
| 前瞻研究     | `0.1.7-alpha.2` / `00102833dfaee1da9f48a3a8eae9d34005a75218`；[发布说明][alpha]；不加入候选依赖组合         |
| 前瞻源码归档 | [按 commit 下载][alpha-archive]；SHA-256 `a431a026511e66f75842153e44f1b2adaed439ad6486111ba4f3f10002514b15` |
| npm 核查     | [官方注册表][registry]在本轮核查时 latest/next 为 rc.3、alpha 为 alpha.2；运行版本不能跟随浮动标签          |

所有上游判断来自官方固定源码或本轮隔离探针。没有复制第三方实现进产品；新增 JSONL 来自当前 Allrice 适配器调用真实 DSH 和本地合成模型，仅归一化临时 cwd。源码档案哈希与 npm tarball integrity 是不同证据，不能互代。

## 依赖组合差异

不能把所有包机械替换成同一版本号。现有 Worker 的 33 个 `dsh-*` 直接依赖中，31 个有 rc.3 发布，2 个已缺失：

| 依赖                                | PR-2 的处理要求                                                                                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@deepseek-ai/dsh-agent-spine-demo` | rc.3 注册表无该版本，源码组合已移除。用显式插件组合重建当前受限服务，不导入默认 coding 工具集合。                                                                                                     |
| `@deepseek-ai/dsh-sdk-jsonrpc-demo` | rc.3 注册表无该版本；现有依赖用途需清理。新的 `sdk-app` / `sdk-minimal` 是可参考的组合，**不是可直接替换的受限 profile**。                                                                            |
| `@deepseek-ai/cordis`               | 当前直接固定 `4.0.1`；rc.3 SDK/app-boot 等 peer 指定 `4.0.2`。                                                                                                                                        |
| Cordis 支撑包                       | rc.3 app-boot 要求 group `1.0.2`、loader `1.0.3`、include `1.0.7`、hmr `1.0.17`；schemastery 为 `3.18.2`。这些不是 DSH 版本号。                                                                       |
| `@earendil-works/pi-ai`             | 当前 Worker 直接固定 `0.82.1`，rc.3 `dsh-llm-pi-ai` 声明 `^0.85.1`。当前直接 provider import 与适配器必须解析到经过验证的一致组合。                                                                   |
| `@deepseek-ai/dsh`（Admin）         | rc.3 存在；必须同时核对 CLI 入口、UI 连接、认证网关和 pnpm 补丁，不只升级 Worker。                                                                                                                    |
| 格式相关新依赖                      | `session-format`、`session-format-catalog` 及 v0→v1→v2→v3 迁移包；子助手的新 peer 还包括 scope、sandbox-policy、agent-presets、session-query 等。检查它们是否只是服务依赖，不能因安装而开启执行工具。 |

31 个同名可用 Worker 包均为 `@deepseek-ai/dsh-` 前缀，rc.3 npm 元数据逐个核对通过：

```text
app-boot, attachment, attachment-local, authorization,
compaction-basic, compaction-tool-result-pruner, credentials, credentials-local,
invariants, llm, llm-deepseek, llm-pi-ai, llm-retry, repeat-tool-reminder,
sdk-jsonrpc-server, sdk-protocol, session, session-checkpoint-policy,
session-persistence-jsonl, session-projection, skill, subagent,
subagent-spawn-in-process, user-approval, token-meter, tool-ask-user,
tool-call-timeout-policy, tool-skill, tool-todo, tools, user-questions
```

依据：[app-boot manifest][boot-package]、[provider manifest][provider-package]、[SDK manifest][sdk-package]、[subagent manifest][subagent-package]、[sdk-minimal profile][minimal]。后者显式提供 persistent Bash/PowerShell，因此禁止用它“补齐”旧 spine。

这里是可安装性及接口差异审查，**不是已解析通过的完整生产 lockfile**。PR-2 必须在独立工作树生成完整锁，核查直接/传递/peer 版本、npm integrity、平台原生依赖和包源码补丁，再验证 Worker/Admin 的受限组合；这些是候选准入条件。

## 协议与语义差异矩阵

| 范围                | 当前依赖的语义 → rc.3 差异                                                                                                                                               | 必须保留的行为 / 验证入口                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 初始化与 stdio      | [SDK wire][wire]保留 JSON-RPC 和 message receipt；新增 reasoningEffort、inline image；[server][sdk]在 initialize 校验模型路由并拒绝过早 prompt，握手自身版本仍是 `0.0.1` | Allrice 发行身份和初始化能力检查继续存在；ACK 不是 turn 完成；stderr 不进入用户错误。`dsh-protocol-runtime.test.ts`、`dsh-adapter.test.ts`。         |
| Session / 日志      | 物理格式 v0 → v3，包含中间迁移；[Session][session]完整 events 属性改为 `snapshotEvents()`，content block/event envelope 与 system prompt 表达变化                        | Allrice 的事件映射、工具事实、typed input proof、用量和恢复不能按旧字段读取；固定旧字节回放，而非重新生成“旧”记录。                                  |
| 持久化接口          | [JSONL backend][persistence]改为 handle 读写及历史代际文件；保留源版本，写入可发布 `session.v3.jsonl`                                                                    | 不能用旧类导出或底层读写 API 假定兼容；需要测试文件发现、未知格式拒绝、源字节不变及单写入者。当前 profile 使用未压缩 JSONL，候选先保持该编码。       |
| Inbox / 消息        | [subagent][subagent]旧 `followup` 移除；`sendMessage` 要求真实 live sender、直接父子关系，Host Queue/Steer 有单独入口                                                    | 不能丢失真实发送者、采纳证明、平台 delivery ID；派发确认不等于执行/交付。复用 `assistant-native-delivery.test.mjs` 和真实 PG authority/output 测试。 |
| 工具回调            | SDK 仍提供事件流；内容格式和调用宿主 API 变化不意味着授予工具                                                                                                            | 实际调用必须经过 Broker/助手授权回调；缺权拒绝、精确审批、超时/取消和未知副作用不重放。现有 adapter tool replay + `apps/worker/test/p25`。           |
| 模型事件与用量      | [LLM TokenUsage][usage]仍区分非缓存输入、缓存读/写，可选 total；assistant 流的 journal 表达变化                                                                          | 缺失用量保持 unknown，不把缺省零当真实用量，不重复计费，不恢复固定调用次数熔断。provider/usage/assistant quota 显式回归。                            |
| 图片 / Skill        | 候选 SDK 原生图片准入是可替代点；技能注册、依赖及原生提示仍需显式组合                                                                                                    | 图片顺序、大小/类型、模型支持和冻结 SkillBundle 不变；现有附件、Skill 权限与发布测试。                                                               |
| 压缩                | Allrice 已复用原生 compact；[候选 compaction][compact]的策略、投影和事件需逐项对照                                                                                       | 未找到安全区间应明确 no-op，不重建会话；压缩不能抹掉权限/交付/等待事实。golden replay + 候选真实压缩样例。                                           |
| 取消 / 子助手       | 候选 interrupt 要求显式 authority，保留未认领 Inbox；新消息可冷恢复直接子助手                                                                                            | 取消仅作用于授权树、不会自动重放认领任务；关停须结算/排空。原生助手、持久 Worker 杀进程用例。                                                        |
| MET-153 等待 / 时钟 | Allrice 私有 wait/input 事件不属于上游历史格式词表，迁移实测失败                                                                                                         | 原 Run、原问题、typed answer、物理时钟、暂停/活跃和派发未知状态全部保留；禁止通过跳过事件恢复。                                                      |
| 私有 Admin 入口     | CLI 仍有 `lib/bin.js`，但 [connection][connection]内部变化显著                                                                                                           | 用 Admin compatibility seam 验证启动，另跑网关未授权拒绝与真实 UI；重审源码 pnpm patch，不让 HTML marker 代替服务器认证。                            |

## 旧会话夹具与候选迁移实测

固定夹具：[dsh-legacy-v0](../../../apps/worker/src/harness/fixtures/dsh-legacy-v0/README.md)，包含普通工具完成、问题挂起、答案已采纳、续接已完成四个时点；SHA-256 记录在 manifest。原始生成器只接受新的输出目录，测试永远复制这些固定字节。

当前原生运行时回放的 6 个用例覆盖：历史工具不重复回调；挂起/已回答两种旧日志都采纳精确答案且只续接一次；已派发续接不重放；未知必需事件与未来版本拒绝且文件不变。模型是本机合成 HTTP，不代表真实 Codex 模型验收。

候选探针使用隔离安装的 `@deepseek-ai/dsh-session-format-catalog@0.1.5-rc.3`，其 Session、format、v0/v1/v2 迁移包均解析到 rc.3，Cordis 为 `4.0.2`、schemastery 为 `3.18.2`。探针仅调用 format catalog 读取/转换内存值，不启动候选 Agent、工具、模型或写回会话。结果：

| 固定历史文件               | 原生 rc.3 格式迁移结果                                                           |
| -------------------------- | -------------------------------------------------------------------------------- |
| `ordinary-tool.jsonl`      | 通过，v0 → v3，26 个原始逻辑事件收敛为 18 个新事件；序号不能原样沿用             |
| `parked-question.jsonl`    | 拒绝：v0 的 seq 15 是未知历史事件 `allrice/wait/checkpoint`                      |
| `answered-question.jsonl`  | 同上；还包含 `allrice/input/request`、`allrice/input/answered`，不能在迁移时丢弃 |
| `continued-question.jsonl` | 同上；还包含 `allrice/wait/continued`，丢失它会破坏防重复派发                    |

原始结构化结果见 [rc.3 探针记录](met154-rc3-probe.json)，包括读取器包版本、入口哈希和每份旧夹具哈希。拒绝来自 [冻结的历史事件校验][historical-validation]，即使标记 ignorable 也不放行。**全部 header 都显示 migration-required，并不代表 body 可迁移。** 普通记录成功也只证明这个样例能被格式库接受，不证明工具执行、模型历史语义或生产升级已通过。

复现（候选安装到临时目录，避免修改仓库依赖或读取真实会话）：

```bash
DSH_PROBE_DIR=$(mktemp -d)
printf '%s\n' '{"private":true,"type":"module"}' > "$DSH_PROBE_DIR/package.json"
npm install --prefix "$DSH_PROBE_DIR" --ignore-scripts --no-audit --no-fund --save-exact \
  @deepseek-ai/dsh-session-format-catalog@0.1.5-rc.3 \
  @deepseek-ai/dsh-session@0.1.5-rc.3
node scripts/acceptance/runtime/probe-dsh-legacy-migration.mjs "$DSH_PROBE_DIR"
```

本轮探针预期退出码 **1**，表示候选迁移受阻，不能把它包装成兼容通过。复核时保存解析出的 lock/版本和探针结果；重新解析出不同依赖组合需要重审。

## 迁移与回退方案

1. **先分流与排空**：已有运行保持冻结的 DSH generation。活跃任务、助手树、有审批/未知操作的任务由旧兼容 Worker 完成或按既有机制明确终止；不能仅因根 Agent idle 就迁移。没有旧 generation 并行路由的部署必须先完成排空，不假定平台已有自动双版本调度。
2. **复制与绑定**：保留原始会话目录、generation、Allrice Run/session 对应关系、wait checkpoint/input proof、配置与操作账本快照；校验副本哈希。只在独立候选目录进行迁移，数据库无需新增结构不等于无需保存恢复绑定。
3. **私有事件适配先行**：选择显式兼容迁移器或保持旧 generation 路由。迁移必须校验 private payload/digest，重映射变化的 seq 和跨事件引用，保留 answered/continued 的幂等语义；不能靠删除事件或改名字骗过上游校验。优先向上游提出扩展点，暂无法安全迁移的会话继续留在旧版。
4. **迁移后只校验再开放**：核对消息顺序、工具完成/未知、typed answer、Skill/模型配置及同 Run 时钟；在副本上先做只读恢复和带合成模型的显式续接。真实旧日志的脱敏副本验收属于 PR-2；本 PR 的合成夹具不代替它。
5. **写入前回退**：候选尚无新派发/持久业务操作时，撤销候选路由可回到原始 generation 和原始日志；先确认无新副作用，再恢复服务。
6. **写入后回退**：即使上游保留旧 `session.jsonl`，旧二进制也可能忽略新 `session.v3.jsonl` 并继续过时历史。禁止只切回旧二进制或删新文件。停派发、核对新增操作与数据库状态；优先向前修复/由候选排空。只有经过验证的逆向转换或一致备份恢复并消除新副作用风险后，才可回退该会话。
7. **兼容回退版**：必须理解 `allrice/input/*` 与 `allrice/wait/*`，保留 MET-153 的 0103–0105 迁移及未知派发拒绝行为。不可使用较早且不识别这些日志的旧候选作回退。

## PR-2 的合入门槛

- [ ] 删除包的显式受限组合替代、SDK/Session/Subagent/用量接口完成适配；Worker、Admin 和传递依赖锁经过统一核对。
- [ ] 私有事件迁移有实际实现/路由边界及拒绝测试；旧记录回放、已采纳答案和续接不重放通过，原始副本不变。
- [ ] `pnpm dsh:golden-replay` 在候选组合上通过，包含当前真实原生等待/进展回归；不能以 mock/fake 或 skipped 替代。
- [ ] 显式运行真实 PostgreSQL 的 clock/progress/native-wait、Worker 杀进程、助手授权/开发协作/交付/用量、冻结 Skill 和 Broker 边界回归。
- [ ] Admin 私有入口及源码补丁通过启动与未授权拒绝检查；图片、工具、Skill、取消、压缩和模型使用范围没有扩大。
- [ ] 准备旧会话/在途任务清单、代际路由或排空方案、候选写入后的回退演练；实际发布仍走后续 Dev 验收阶段。

PR-1 的基础检查：`pnpm dsh:golden-replay`；新增测试同样由常规 `pnpm test` 执行。数据库及 Worker 进程恢复继续使用现有 CI `developer-bootstrap` 的显式环境开关；真实 Dev 模型验收保留在后续固定候选发布阶段。

[release]: https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.3
[archive]: https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/a4c74a91e06b00fe0b0937bde982170c526cc842
[alpha]: https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.2
[alpha-archive]: https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/00102833dfaee1da9f48a3a8eae9d34005a75218
[registry]: https://registry.npmjs.org/@deepseek-ai%2Fdsh
[boot-package]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/boot/app-boot/package.json
[provider-package]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/llm/llm-pi-ai/package.json
[sdk-package]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/sdk/server/package.json
[subagent-package]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/subagent/subagent/package.json
[minimal]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/bundle/sdk-minimal/cordis.patch.yml
[wire]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/sdk/protocol/src/types.ts
[sdk]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/sdk/server/src/server.ts
[session]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/core/session/src/index.ts
[persistence]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/session/session-persistence-jsonl/README.md
[subagent]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/subagent/subagent/src/index.ts
[usage]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/llm/llm/src/types.ts
[compact]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/compaction/compaction-basic/README.md
[connection]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/client/connection/src/client/index.ts
[historical-validation]: https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/session/session-format-v0-to-v1/src/validation.ts
