# M1 处置手册 1：Codex 订阅额度耗尽或授权失效

对应告警：`subscription`（模型订阅不可用/异常）。总览见 [m1-monitor.md](m1-monitor.md)。

## 影响

所有 AI 员工的回复都走 Codex 订阅（M1 Dev 只启用一个槽位）。授权失效或额度用完时，新的对话和定时任务都会失败；告警会同时出现失败 run 比例突增（`business.failed_runs`）。

## 第一步：看是哪种

```bash
/opt/homebrew/bin/psql -h 127.0.0.1 -At allrice_dev -c "
  select s.slot, s.label, s.enabled, p.status, p.detail_code, p.checked_at, p.subscription_quota
  from allrice_codex_subscriptions s
  left join allrice_provider_status p on p.provider = 'codex' and p.subscription_slot = s.slot
  order by s.slot"
```

| 现象                                                               | 判断                                      |
| ------------------------------------------------------------------ | ----------------------------------------- |
| 没有 `enabled = t` 的行                                            | 订阅被全部停用                            |
| 启用槽位 `status` 不是 `connected`                                 | 授权失效（令牌过期、被撤销或账号登出）    |
| `subscription_quota` 里 `limitReached: true` 或 `usedPercent` 很高 | 额度用完或快用完                          |
| `checked_at` 很久没变                                              | Worker 没在刷新状态，先按 Worker 告警处理 |

## 处理

- **授权失效**：在后台「模型与订阅」对该槽位重新做设备码授权（需要用户本人在浏览器完成）。M1 和 huihuimac 共用一个 Max 订阅账号，各自持有独立令牌，不复制凭证文件。细节见 [codex-subscription-accounts.md](../operations/codex-subscription-accounts.md)。
- **额度用完**：先问用户是等重置（`subscription_quota` 的 `resetsAt` 是 Unix 秒）还是换槽位。换槽位前先确认另一个槽位的授权和额度；表上的约束只允许同时启用一个，要先全部停用再启用目标槽位。**不为测试擅自切换订阅**（用户 10-25）。
- **快用完（≥80%）**：只是预警，告诉用户剩余额度和重置时间，不需要操作。

## 确认恢复

启用槽位显示 `connected`、额度正常后，下一轮告警自动恢复。再用冒烟测试确认真实对话：

```bash
~/allrice-dev/bin/smoke-test --dev --only chat
```

## 谁来做

改订阅槽位、重新授权都要用户确认；改 `allrice_dev` 里的数据只由发布负责人做（AGENTS.md 第 9 节）。
