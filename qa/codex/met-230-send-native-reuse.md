# MET-230：原生子任务图文 Send 的薄接线

用户批准按 DSH 原生图文行为复用；基线 `1f0331259201ec30b334042d6895ebc0a7f012d9`（依赖 U1 / #688）。这次继续工作经过整项四类核对和用户批准。历史产品 gross 2152（保守 2156）、原估算 600–780、两倍 1560 停手线已触发的事实保持不变。本片 650–900 是剩余实施估算，搬移 add/delete 两边计入，不能清零历史。

## DSH 对照与复用边界

- 固定依赖 `@deepseek-ai/* 0.2.1-rc.2`；输入行为对照官方源 `687f282e8625c6b8d11ff58211a90524be2e4317` 的 `dsh-client-ui-conversation` InputBar / continuable child composer。公开 UI 包不单独导出 InputBar；本片不搬 SessionController、Lexical、inputHub 或私有生命周期。
- 直接共用 `chat-composer.tsx` 的 `ChatComposerInput`（根会话也使用）、`use-attachments.ts` 的同一草稿/上传/URL 清理状态、`PendingAttachmentRail` / `AttachmentPreviewDialog`；回执复用 `MessageImageGallery`、`createMessageImageCache` 和现有授权文件读取。没有第二附件后端或另一套 Send 草稿 Hook。
- 本批图片逐张 await 同一 `persistPendingAttachment`，首个失败不 prompt；已上传 ID 与其余草稿由同一 Hook 保留，下次显式 Send 复用已有 ID。没有新增上传队列或自动重传。HTTP/1 长观察连接另由独立只读 WS 传输片处理；本片单独仍有真实浏览器红项，须在组合后完整复验。
- 子输入对照 DSH：PNG/JPEG/WebP/GIF；整批粘贴/拖放，混合不支持的文件整批拒绝；图片加 text/plain 同时粘贴时保留选区文字插入；纯图片可发；IME、重复 Enter、Shift 换行不发送；running 时按钮固定 Queue（含修饰键点击），Ctrl 或 ⌘ + Enter 才为 Steer，idle 时 Queue。没有新增选图按钮。rc.2 `dsh-client-ui-conversation/lib/client.js:18951–18961` 的 onPrimary 取普通 Enter 模式、不读取点击修饰键；本片该模式为 Queue。`:18248–18268` 的图片 intake 后仍执行 pasteText，是混合粘贴的对照依据。
- Host 始终调用公开 `subagents.prompt`，图片由原生 attachment admission 验证及持久化。没有复制 DSH 源码段，只有公开行为在既有输入表面的窄适配；维护责任在 AllRice，升级上述 pin 必须重跑图片、Queue/Steer 和输入测试。没有调整 maxDepth；它仍只管原生新建。
- `parentAvailable` 来自当前正确 Host 中真实 direct-parent Session / Agent 的一致性观察，idle 也可用；prepared / 缺观察 / 替换期间为 unknown。public `agent/created`、`agent/disposed`、`session/disposed` 只让现有 follow 重新读取，事件本身不赋予可用性，也不写 PG。

## 四类依据

| 类别     | 本片最小接线                                                                                                                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 门卫     | 原控制 owner / membership / 活动 Root / generation / Job / pin 校验不变；图片必须当前 Session 关联、同租户、ready 且经 `getStoredFile` 当前 ACL；Worker 字节读取前后重验原命令与图片快照，Host 继续以现有租约校验和原生直属父授权收口。                                                                 |
| 单向账本 | C1 原命令只扩 text/image objectId intent 与服务端冻结快照；原请求 CAS 保持，Worker 原文记票、单次 claim / dispatch；wire bytes 单独类型，不能覆盖原请求。recorded、accepted、unknown、rejected 仍是真实回执，无自动重投。                                                                               |
| 存储     | 复用 `/sessions/:id/attachments`、配额扣算、Session 关联、`PromptImageAttachment`、`loadHarnessImages` 的字节数/摘要验证；浏览器不能提交 key/checksum/grant/base64 到控制入口。回执读取暴露文字和图片元数据，像素走现有文件签名/读取授权。sessionStorage 只记查询定位，正文、图片、URL、busy 不持久化。 |
| 租约     | 沿现有运行输入窗口、grant 期限和公开 AbortSignal；不加父 wake、运行锁、持久 busy、轮询器、子执行 PG 状态或新增子 Job。上传后的 UI 再核当时 Root / child / owner / parent observation；Send 与 Stop 请求锁分离，HTTP/1 连接占满时的控制传输仍待闭合。                                                    |

## 显示与验收边界

原请求回执显示“本次发送内容”和真实接收状态；这不是已处理证明。读取旧票可恢复该请求的文字和图片引用，图片撤权后读取失败。现有 child 详情仍是既有只读原生投影，没有补全部 human/image 历史或 QueueDock，不宣称完整原生聊天 UI。

Dev 验收由发布负责人进行：

1. 同一活动根建两个 continuable child；运行时文字 Queue、纯图 Steer、图文 Queue 各一次，原生回执、目标 child 原生日志、兄弟不受影响相互核对。
2. 图片预览/移除/非法整批/IME/Shift；上传慢时仍能 Stop；父观察失效或根切换后，旧上传完成不能触发发送。
3. idle 直属父可用，prepared 或无观察禁用；冷 child 在同一地址续跑。不要用根在线/running 代替父观察。
4. 请求已记录、原生 accepted、丢 ACK unknown、明确拒绝分别展示；详情关闭/刷新仅查原票，无重发；回执可见原文字及授权图片。
5. 不同 Session/租户 objectId、撤销 Session 关联/文件 ACL、字节摘要改变均在原生 dispatch 前拒绝；浏览器存储无正文/base64，查票不创建 Run/Job。

## MET-225 拟改行

`MET-230 Send | 复用既有输入/附件/授权图片读取；public subagents.prompt 原生 Queue/Steer；图片来源冻结与原请求 CAS 属门卫/账本/存储；Agent 生命周期仅触发现有观察；无第二执行/附件/队列状态；保留整项 2152/2156 历史，追加本 PR 实际 gross；未迁移完整子聊天历史/QueueDock。`

测试原始结果及最终统计另记 `~/allrice-dev/qa/codex/met-230-send-native-reuse-*`；失败保留，独立 Astra 复核由 root 发起。此文不作为部署或验收通过证明。
