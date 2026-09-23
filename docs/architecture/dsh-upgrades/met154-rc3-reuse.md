# MET-154 PR-3：复用原生图片准入，保留协作治理

本次基于 [PR-2 #93](https://github.com/semiok/allrice/pull/93) 的 `c99e249`，固定上游 `0.1.5-rc.3` / `a4c74a91e06b00fe0b0937bde982170c526cc842`。决策日期 2026-09-23；持续入口是 [DSH 复用与替换清单](../dsh-reuse-and-replacement.md)。

## 实际替换

Allrice 原本先调用上游 `admitEncodedImages`，再用 `admitDshPromptImageBlocks` 自行将返回的有序引用转换成图片内容块。rc.3 新增的 [AttachmentStore.admitPromptContent](https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/attachment/attachment/src/index.ts) 已完整负责这一过程；对比 rc.2 源码，该接口原先不存在。

PR-3 删除这个 helper 及其导入。JSON-RPC `prompt` 把现有 wire images 标记为原生图片片段后交给 `ctx.attachments.admitPromptContent`，由同一个附件 store 校验、持久化并投影引用。随后仍由原生 SDK 生成一次消息身份并排队，没有双写或第二套准入逻辑。

这里有意保留很薄的 wire 桥接：[rc.3 SDK 的 inline-image API](https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/sdk/server/src/server.ts) 只转发 `data` 和 `mimeType`，会丢失 `name`。Allrice 的冻结附件带有文件名，原生引用和模型可见的图片标识也使用该名称。`admitPromptContent` 保留名称及原生路径清洗，因此当前不能直接删掉整个 `prompt` 覆盖方法。

这是 `allrice-jsonrpc-lifecycle-v1` 内的一段实现退役；10 项 ledger 记录及 3 份物理源码补丁仍然保留。收益是减少一处自行维护的引用转换，不宣称 token、延迟或整体代码量下降。依赖锁、候选发行身份、工具组合与权限保持 PR-2 状态。

## 优先协作路径的复核结论

| 路径               | 本轮决定与依据                                                                                                                                                                 | 下次可退役的条件                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| MET-144 消息派发   | 已在 PR-2 复用 `queueHostSubagentPrompt`；继续保留 coordinator 来源、独立排队回合及 PostgreSQL input/message 检查点。rc.3 `sendMessage` 使用 steer，会改变运行中接收者的行为。 | 上游稳定 Host Queue 接口覆盖同样来源、采纳与取消语义，再减少内部接口适配。                         |
| MET-151 完成唤醒   | 保留 `guardSettlement` 与 delivery 去重。原生 settled 通知可能先于平台结果持久化，原生 idle/文本不能证明通过 `assistant.report` 交付。                                         | 可在唤醒前接入平台授权，并保留 parent/child、durable delivery ID、取消截止点、实际报告与用量事实。 |
| MET-153 等待与计时 | `join` 已等待原生 `whenIdle()`；额外等待用于平台写入、报告采纳及可能新建的子助手。单个原生 idle 不能代替这些条件，也不拥有数据库时钟。                                         | 上游组合等待能覆盖完整的原生树与平台交付边界，通过现有并发、取消、恢复验证后再移除包装。           |
| 实验性 Team        | 继续只研究消息 ACK、revision CAS 和事件等待，不挂载其工具。共享目录、单进程任务板不承担多租户权限和跨 Worker 租约。                                                            | 另行明确产品能力与授权范围；不得产生第二个任务权威来源。                                           |

依据固定源码：[消息与 Queue/Steer 差异](https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/subagent/subagent/src/continuation.ts)、[Host Queue](https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/subagent/subagent/src/internal.ts)、[Team 边界](https://github.com/deepseek-ai/deepseek-harness/blob/a4c74a91e06b00fe0b0937bde982170c526cc842/packages/experimental/agent-team/README.md)。alpha.2 的连续唤醒修复没有移植进 rc.3。

## 验证与回退

新增 `apps/worker/test/p25/dsh-images-native.integration.test.ts`，纳入 `pnpm dsh:golden-replay`：

- 使用真实 rc.3 store 验证 base64、无效图片、声明类型、数量、单图/整批字节、像素与边长拒绝；缩小测试配置限额以避免生成大图，拒绝前不发布对象。
- 启动实际受限 DSH stdio 进程。坏批次不产生用户消息或模型请求；有效图片保留名称、顺序、内容哈希及单一 message ID，文件路径经原生清洗。
- 实际落盘后关闭进程，再恢复同一 Session。两张图片仍能进入下一次显式提示的模型请求，原提示不重放。
- 模型只使用本地合成 HTTP 端点；测试临时 profile 显式声明该测试模型支持图片。真实用户数据、模型配额与生产模型配置均不参与。

租户存储授权、不可变 Run 附件快照和摘要核对仍由原有 `getStoredFile` / `loadHarnessImages` 执行，没有转交给 DSH；针对冻结附件的现有测试与 golden replay 一并运行。本地 `dsh:golden-replay` **7 文件 / 76 项通过**（包含新增图片测试 9 项）；另跑冻结附件、兼容助手、P24 原生协作、助手交付/准入/用量与开发桥接回归，**7 文件 / 76 项通过**。合成测试不代表真实 Dev 账号验收。

如需撤销这项局部替换，在同一 rc.3 发行版中恢复旧 helper 即可，附件引用和会话格式没有变化。该操作不允许把已写入 v3 的会话交回 rc.2。部署、真实旧日志副本、在途任务盘点与回退演练仍按 [PR-2 发布边界](met154-rc3-compatibility.md) 留给 PR-4。
