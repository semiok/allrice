# MET-163 图片执行与交付

继承 PR1 的平台模型配置，每个 Run 冻结图片开关和图片模型。当前仅开放实际验证过的 `gpt-image-2.5-flare`，通过平台 DSH 管理的 Codex OAuth 使用 Responses `image_generation`；不使用个人认证或 API key fallback。

员工已有 `workspace.export.create`、`model:invoke`、`storage:write` 权限时自动获得图片工具，无须再选择图片模型。编辑额外校验 `storage:read`、原图 objectId、SHA、租户/工作区/用户访问权。原图作为真实图片输入，不是仅描述文件名。交付沿用现有不可变文件版本和鉴权下载。

`0118_image_operations.sql` 增加独立图片调用记录和 PNG 交付格式。调用前在有效任务租约下登记，同 Run 的相同内容即使换 call ID 或文件名也不会重发。完成回执记录 Responses token；缺失用量为待核对，不宣称免费或推算官方余额。图片明细独立于对话调用用量，不冒充图片单价。失败、取消、断流或超时不会自动重试；发布时重新校验原任务及精确租约。Worker 崩溃遗留 running 记录同样不能重放，需核对后开启新的用户任务。

## 验证

- 隔离 PostgreSQL + 真实本地成果存储：生成、v2 编辑、原图保留、checksum 文件发现、跨租户拒绝、过期租约拒绝、重复内容去重、未知结果拒绝重放、用量持久化。
- 传输测试：分块 SSE、完整回执、HTTP 401/403/429/400/500、断流、失败回执、多图异常、未验证模型拒绝。
- 原生 DSH 启动与工具注册、工具清单一致性、Gemini 启动拒绝。
- 2026-09-27：真实 Dev 平台 Codex 订阅，经 Worker Tool Broker → 原生 DSH → 成果保存完整执行两次。蓝色圆形 PNG v1（1254×1254，789593 字节），编辑为橙色 v2（1254×1254，1072927 字节）。人工检查两图符合要求，原图未覆盖。两次 Responses input/output 分别 2438/50、4259/65；request ID 未返回，按 null 保存。
- 此实测直接调用生产 Tool Broker 入口，外层对话模型的自主工具选择、浏览器 UI 另由 PR3 验证；不等同于 Dev 已部署。

上线顺序：PR1 → 本 PR → PR3，迁移后更新 Web/Worker，再在平台配置中启用图片。关闭图片只影响新 Run；历史图和版本继续可查看。没有数据库降级脚本，不删除历史回执或图片。
