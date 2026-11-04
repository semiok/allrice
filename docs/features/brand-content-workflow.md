# 品牌内容与 Workflow

旧 Workflow DAG 执行、审批、包注册和绑定入口已退场。品牌资料、选题决定、稿件审核、排期和发布回执的现有业务页面仍可读取和使用。

新 Workflow 使用 DSH 原生 skill。用户本人可按[原生 skill 开发说明](../development/workflow-skills.md)编写、打包和发布内容；运行时接线由 C2 交付，本文不提供旧安装器或旧执行 API。

本次不删除旧表或历史数据；品牌一次提醒适配器保留至 A6-2。通用一次和周期定时及 `workflow-automation` 技能继续保留。
