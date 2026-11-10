# 普通个人记忆候选 v2

本片提供 pair 候选写入，不单独激活生产新 Run。
生产 admission 仍由现有 freezeEmployeeDocuments 生成 v1；后续 PR2 必须同事务冻结 docs2、全部摘要、pins、既有读取账本与 allowlist，才启用新的 Run。

## 内容与权限

模型输入只接受 summary（1…40 Unicode code points）、可选 details（最多2000）及既有 memoryClass。
非空 details 保留原文，空白或省略归 null；复用存储字符约束。
来源、owner、workspace、instance 和操作身份由 Worker/当前存储真值绑定。
每次模型写入均为 derived candidate，expiry 为 null，不占 active100名额。
本人确认或修改保存沿管理核心的当前权限、pair CAS、幂等和100名额事务生效。
Checkpoint pair 只扩展现有存储适配入口，保留旧 content 合同，不新增后台 producer。

## 版本与幂等

唯一业务版本来自本 Run 冻结的 employeeDocuments.schemaVersion；没有该字段为 v1。
同一版本投影到 initialize、既有 Host fingerprint 与 Worker 参数校验；run/begin 先核对相同版本。
v2 Host 必须明确回执其版本；不能根据 workspace.memory.read 的存在性猜写入版本。
操作键绑定可信 Run/nativeSession/callId；完整 pair 进入请求摘要。
executionId、Worker重领、attempt、generation 或 RPC编号不改变同一操作身份。
同键异 payload 冲突；旧成功回执在目标修改/删除后不能再次作为当前成功。
DSH 冷恢复的 TOOL_OUTCOME_UNKNOWN 语义保留，不新增自动重放或换键重试。

## 删除与恢复

删除只针对原 identity；它自身和旧回执不能复活。
另一次合法提议即使同源同 pair，也只能生成另一条 pending，仍需本人确认。
不按已删摘要、词表或时间 cutoff 硬拒绝，不连带隐藏/修改同源已确认记录。
真正来源撤回和权限变化仍按既有门卫拒绝。
失败事务整体回滚；已有新 pair/revision/回执/Run 后使用前向兼容修复，保留历史，不降级清空 details。
C/#788、B/#777、删除参考模型输入、真实模型验收与部署不在本片；各项状态分别记录。
