# 平台工作模型

2026-09-30：添加 `gpt-6.1-sol`（GPT-6.1 Sol），设为平台默认工作模型。

后台「平台模型配置 → 对话与理解」提供 GPT-6.1 Sol、GPT-6 Sol、GPT-6 Luna 和 GPT-5.3 Codex Spark。授权沿用现有 Codex 订阅，模型选择同时应用于对话、图片理解与图片生成调用中的工作模型；独立图片模型仍为 Flare / Sunburst。

`0122_gpt61_sol_default.sql` 添加目录条目并更新平台当前默认值，仅变更 `workModel`，保留推理强度、超时、连接和图片设置。每次新 Run 绑定时读取平台配置，所以已有会话的下一轮也使用新模型；进行中的 Run、历史模型快照、员工版本和调用回执不改写。

固定的 pi-ai 目录尚未包含此模型，使用现有 DSH 原生配置声明图片输入及推理支持。AllRice 已接通的推理档位仍为 low / medium / high / xhigh，不扩展 max / ultra。Codex 本机官方目录（2026-09-30，CLI 0.159.2）的默认上下文为 272,000；这里使用该订阅目录值，不把公开 API 的最大上下文作为订阅默认值。

依据：[官方模型标识与能力](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、[Codex 发布记录](https://learn.chatgpt.com/docs/changelog)。官方和本机目录均确认标识为 `gpt-6.1-sol`。通过真实受限 Cordis/DSH 的离线启动检查、图片请求序列化、隔离 PostgreSQL 默认迁移与历史快照保留、后台模型选择及保存检查验证接入。
