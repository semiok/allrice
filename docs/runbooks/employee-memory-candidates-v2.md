# 普通个人记忆候选 V2

普通真人 root 及其中运行的当前 Workflow/Skill 使用同一份 V2 记忆索引、read/remember 工具和本人确认流程。系统、定时、手动自动化及文件夹事件任务的 MEMORY 恒空，不拥有个人记忆工具或真人写资格。

## 内容与来源

remember 只接受 summary（1–40 Unicode code points）、可选 details（最多 2000）和既有 memoryClass。非空 details 保留原文，空白或省略归 NULL。来源、owner、workspace、instance、Run 和操作身份由 Worker 与存储真值绑定。

候选只来自当前 Run 的真人原消息和已 adopted 的真人 steering；模型创意、推测、复盘、文件或工具输出不成为本人事实或授权。模型每次只产生 derived pending，不占 active100 名额；本人确认或编辑保存才在当前权限、精确 revision/pairDigest、幂等和名额事务内生效。管理员只读，成果或文章确认不能代替记忆确认。

本 Run 回执列表继续按原真人消息和 adopted steering 来源过滤，不展示该员工其他 Run 的全部 pending。工具完成事件只是重新读取提示，不能用工具输出创建卡片或认定确认成功。

## 冻结与幂等

普通新 Run 先持久化真人消息，再用同源记忆读取投影准备完整摘要索引、pins 和初始字节账本。独立 queue 事务在首个 employee_runs INSERT 原子保存 docs、state 和冻结 allowlist；queue 失败不撤销前面的合法消息或输入回执。

唯一文档版本为 schemaVersion=2；initialize、Host fingerprint、版本回执与 run/begin 参数一致。缺版本或不兼容 carrier 拒绝，不从工具存在性猜测版本，不回退旧全文 writer。

候选操作键绑定可信 Run/nativeSession/callId，完整 pair 进入请求摘要。Worker 重领、attempt/generation 或 RPC 编号不改变同一次操作身份；同键异 payload 冲突，目标修改或删除后旧回执不能作为当前成功。DSH 冷恢复的 TOOL_OUTCOME_UNKNOWN 保留，不新增自动重放或换键重试。

## 删除和恢复

删除只针对原 identity，其旧回执不能复活。新的合法提议即使同源同 pair 也只能生成另一条 pending，仍须本人确认；不按已删摘要、词表或时间 cutoff 硬拒绝，不连带隐藏同源其他记录。来源撤回、身份变化和当前权限仍按原门卫拒绝。

失败事务整体回滚。已有当前写入后采用[前向恢复](employee-memory-pairs-recovery.md)，保留修订和预算，不降级、清空说明或改写历史 Run。实际 M5、独审、CI、视觉、部署与验收状态由本次交付证据记录。
