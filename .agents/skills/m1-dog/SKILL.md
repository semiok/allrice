---
name: m1-dog
description: 检查和维护 AllRice M1 的后台等待看门狗，处理等待中断、queue 失败、失效线程、空等或平安报告缺失；日常维护归打野线。
---

# M1 等待看门狗

日常维护归**打野线**。这是纯脚本通知看护，不调用模型，不重跑 CI/M5/部署，也不授予任何新权限。收到告警只恢复原先已授权的工作。

先运行 `~/allrice-dev/bin/m1-dog status`，并读取 `~/allrice-dev/qa/wake-when/dog/heartbeat.json`、`dog.log`、`state.json`。用 `launchctl print gui/$(id -u)/ai.bplabs.allrice-m1-dog` 核对进程；每轮 10 分钟，心跳应有近期 completedAt。当天 UTC 01:00 后应有 `dog/daily/YYYY-MM-DD/telegram.json` 的 sentAt，代表 TG 接收，不代表用户已读。心跳超过两轮、TG backlog 或平安报告缺失要报打野线；检查失败不能写“正常”。

按告警处理：

- **等待中断**：读对应任务 result/heartbeat/command.log，检查原 CI run 或 M5/部署终态。不要因 supervisor 死亡便重跑任务；不要杀别人的遗留进程。确定仍运行时，只重新挂接已有任务的只读等待。
- **queue 耗尽/TG 告警**：先查 delivery.json/notification.log 和实际线程，防止队列已接收却因超时重发。确定未接收后补发原回执；不复制日志中的命令执行。网络配置和凭据问题报用户，不自行修改。
- **线程不存在/归档/名单错误**：确认用户给的新 UUID，再只改 `~/allrice-dev/wake-when.threads` 中该线那一行，保留其他六条；不改 Codex 配置或借用其他线。名单热读取。旧等待不会自动转交新线程，要人工核对旧任务，再通知新线程。
- **空等**：只检查最后回执明确正在等结果的具体 CI run、M5 批次或部署任务。只接受完整的肯定状态句，引用、问句、等待用户决定或不明确尾句不推断。纯规则确认、无待挂任务和已交付方案不算空等；同一线同一空等原因24小时最多提醒一次，换回合/重启不重置。检测是保守诊断，模糊时宁可漏报，不是新的任务授权。已有活动等待或已送达终态时，不再启动重复等待。
- 核查完成后，按 `m1-dog status` 的 `pendingAlerts` 运行 `m1-dog ack <相对路径>`（普通任务告警也包含在内；`dog/alerts/<ID>` 可简写为 ID） 标记已处理；ack 只改提醒记录，不改原任务结果。

重启、升级和回滚的具体步骤见 [运维说明](../../../docs/runbooks/wake-when.md#m1-dog-看门狗)。使用已合并的版本化工具；有维护授权才运行 `m1-dog launchd install/remove`，先备份并核验结果。安装/重启只操作本看门狗的 launchd label，不停其他任务。无权限时把现状与待办交打野线或用户，不擅自安装。

以下必须报用户：TG 最终不可达、白名单无法确认、原任务状态无法查明、需要改凭据/网络、部署可能未完成或需要停别人任务。不要读 auth、订阅、`.env` 或 Telegram 凭据内容；TG 发送由既有 monitor transport 自行处理。
