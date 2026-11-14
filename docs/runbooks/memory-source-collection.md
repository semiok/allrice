# 记忆素材采集

MET-223 A1 将真人来源采集移到记忆模块。来源是未确认素材，写入
`allrice_memory_sources`；不会创建个人记忆候选、经验审核或生效记忆。
本次不提供整理任务、模型自动采用或新增管理界面。

采集须同时满足两项显式配置：

- `ALLRICE_MEMORY_SOURCE_CAPTURE_ENABLED=1`；缺失或其他值均关闭，包括开发环境。
- 本组织 `allrice_settings` 的 `employee_memory_source_policy` 为严格对象：
  `schemaVersion: 1`、`enabled: true`、正整数 `revision` 和 ISO 时间
  `collectionStartedAt`。只处理水位之后的真人消息；缺失、无效、关闭都不采集。

没有系统范围或旧 `employee_experience_policy` 回退。迁移不写配置、不搬旧
来源、不回放历史 Run。配置的实际启用或更改按部署及数据维护授权执行；本次
迁移不会默认启用采集，更不会默认启用整理。

普通终态 Run 和原生已采用 steering 写入独立 `memory_source_*` 标记。
现有 Worker tick 处理它们，保留真实本人、工作区、实例和来源证明，准确的
Skill/场景版本与当前撤回状态。采集不持身份、附件、Skill 或场景的实时行锁；
提交前乐观复核，冲突则回滚素材和审计。并发去重仅使用采集专用 claim 和唯一键。

定时、手动自动化、文件夹事件的 Run 保留 PERSONA/组织文档，但 MEMORY 为空，
没有记忆读写工具，也不建立 V1/V2 记忆账本。普通真人对话与其 Workflow 的
当前 V2 记忆路径保持原样。

## 迁移与回退

`0240_memory_source_storage.sql` 只增加空素材表、新终态字段及索引；旧表、
旧数据和旧标记不变，后续统一清理另行删除。空库全迁移和含旧数据升级均需验证。

关闭新运行开关只停止新采集，不等于版本回退。保留新增表和字段时，必须使用
认识 `0240_memory_source_storage.sql` 的回退版本；不能直接部署 base，旧二进制
会被未知迁移门禁拒绝。另一条路径是按既有备份恢复流程恢复迁移前的备份。
不执行 DROP，不自动重新启用旧采集配置。A2 删除旧对象后须按 A2 的迁移和
发布方案处理。Prod 不在本次操作范围。
