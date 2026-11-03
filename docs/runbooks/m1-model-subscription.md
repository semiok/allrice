# M1 处置手册 1：Codex 订阅额度耗尽或授权失效

对应告警：`subscription`（模型订阅不可用/异常）、`quota`（额度）、`model_authorization`（到期预警/确证过期错误）、`model_authorization_data`（授权检查无法判断）。总览见 [m1-monitor.md](m1-monitor.md)。

## 影响

所有 AI 员工的回复都走 Codex 订阅（M1 Dev 只启用一个槽位）。授权失效或额度用完时，新的对话和定时任务都会失败；告警会同时出现失败 run 比例突增（`business.failed_runs`）。

## 授权到期与确证过期错误

`model_authorization` 只读 DSH 现有授权的 `records['llm-pi-ai/openai-codex'].payload.expires`（Unix 毫秒），进入到期前 72 小时、24 小时时各通知一次，并给出到期时间 UTC 和重新授权入口。首次接入已经不足 24 小时只发当前阶段，不补 72 小时；已经到期也沿用 24 阶段，不增加第三个时间阈值。授权与独立 DSH 共用，监控不会刷新、写入或复制凭据。

日志不可读、未完结或存在缺口时，仍按已可靠读出的到期字段触发预警，另报“无法判断”；日志未知不会取消已确定的到期事实，也不能证明恢复。

Worker 新增完整 `[M5] Handler failed` 系统记录，且 `code` 为 `DSH_PI_AI_ERROR`、`message` 明确以 `Your authentication token has expired` 开头时，报“模型授权过期错误”，附本轮新增数、本次故障累计数和最早观察时间 UTC。message 和 cause 中的同一句错误只算一条记录；用户文本、其他错误码均不作为授权证据。stderr 没有发生时间戳，最早观察时间只代表监控首次读到这条记录的采样时间。

这三个阶段属于同一个授权事件。首次确证错误会在已有 24 小时严重告警后再通知一次；之后继续累计，既有每小时/每六小时提醒不用于本项。状态和游标由现有文件锁、state/outbox 持久化，普通重启和并发运行不会重复排队；Telegram 已成功但本地尚未落盘时崩溃或网络回执不明，仍有重发可能。

告警事实和消息入队共同准备并保存，之后才写 incident 和发送；交付保护中断不会把未入队的通知永久标成已经通知，恢复和读取异常也走同一流程。

收到预警或确证错误后，到**运行控制台 → 模型与用量 → Codex 订阅**重新授权（需要用户本人完成）。只有观察到 `expires` 向前变化、仍在未来，并从此至少 `max(240, intervalSeconds)` 秒完整读取日志且没有新增确证错误，才发一次恢复。有新错误或读取不完整，安静窗口重新计时。仅状态为 `connected`、凭据文件 mtime 变化或暂时没有新错误，都不能证明这项已恢复；不要求为监控额外调用一次真实模型。

如果一轮之间先出现错误、再重新授权，下一次同时读到新到期时间与首次错误，前一轮的旧到期时间仍作为前移依据；从之后完整、无新增错误的扫描开始安静窗口。窗口中又读到错误只重置窗口，不会抹去已观察到的前移，避免要求重复授权。

`model_authorization_data` 的“无法判断”表示到期字段/日志读失败、格式不支持、未完记录或游标缺口。用 `monitor status` 看异常详情，核对 Worker plist 的 `ALLRICE_DSH_PLATFORM_HOME`/`StandardErrorPath` 和 `.env` 中的路径及可读性；必要时按已授权的运维流程修复路径或权限，**不要把凭据文件或完整 stderr 贴进报告**。监控只接受 DSH 发出的数字到期字段，缺失、重复、非法值和不支持的 YAML 形式均视为未知。

初次接入仅从 EOF 建基线，避免重报已经恢复的历史；可验证数字序列的轮转会从游标旧段依次补完 `.N` 到 `.1`，再读当前文件，不跳过中间段。每轮 8 MiB 内未读完、残行未结束时继续保留当前段游标并报未知。段缺失、非数字名称或顺序不明也保留未知；不可补读的旧段、截断或损坏会保留缺口证据，不能在下一轮当作零错误；新的有效到期版本加完整安静窗口才重新建立健康依据。读取异常单独恢复不等于授权故障恢复。

游标另存前沿最多 256 字节的局部摘要，检测截断后又长过旧 offset 的改写；不存这些字节原文。文件轮询无法还原已丢失历史，也不能发现前沿被原样重建等没有可观察差异的中间变化，不能把一次完整扫描说成所有历史都完整。

正常发现延迟是下一次 4 分钟采样加本轮检查、复查和发送；慢轮次会跳过 launchd 触发，积压或发送失败也会推迟。4 分 20 秒不是硬上限，详见[监控规则](m1-monitor.md#检查项与阈值)。

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

`subscription` / `quota` 在启用槽位显示 `connected`、额度正常后按其原规则恢复；`model_authorization` 必须满足上面的到期版本前移和完整安静窗口，读取未知时保持原故障。需要验证真实对话时，经发布负责人安排冒烟测试：

```bash
~/allrice-dev/bin/smoke-test --dev --only chat
```

## 谁来做

改订阅槽位、重新授权都要用户确认；改 `allrice_dev` 里的数据只由发布负责人做（AGENTS.md 第 9 节）。
