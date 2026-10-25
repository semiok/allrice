# M1 监控与告警（MET-222）

目标：M1 上的 AllRice 出了问题，10 分钟内在 Telegram 知道哪里坏了、影响多大、第一步做什么；监控自己挂了也有人知道。

## 组成

| 部分     | 位置                                                                                                            | 频率      |
| -------- | --------------------------------------------------------------------------------------------------------------- | --------- |
| 组件健康 | M1 `~/allrice-dev/bin/monitor run`，launchd `ai.bplabs.allrice-dev-monitor`                                     | 每 4 分钟 |
| 入口拨测 | 同上（从 M1 经 Cloudflare 访问）+ huihuimac 的 `monitor peer`（从 M1 之外访问）                                 | 每 4 分钟 |
| 互相看门 | huihuimac `monitor peer`，launchd `ai.bplabs.allrice-monitor-peer`；M1 也检查它的心跳                           | 每 1 分钟 |
| 告警出口 | Telegram（凭证只在两台机器的本地文件里）+ 表 `allrice_operational_incidents`（huihuimac 的经 SSH 写进 M1 的表） | 有变化时  |

源码只有一个文件 `scripts/m1/monitor`（Python 3.9 标准库，`/usr/bin/python3`），M1 和 huihuimac 用同一份：M1 跑 `run`，huihuimac 跑 `peer`。

## 告警规则

- 每项检查有固定的键（如 `worker`、`disk:~`、`sandbox_vm:allrice-cloud-arm`）。一个键变坏时开一条告警；一直坏着不重复发，只在升级（警告→严重）或提醒（严重每 60 分钟、警告每 6 小时）时再发；变好时发“已恢复”和持续时长。
- 同一轮里所有变化合成**一条**消息；太长时按告警拆成几条（标 1/2、2/2），不会截掉后面的告警。组件类检查失败后隔 20 秒重查一次，仍失败才告警，避免一次抖动就报警。
- 1 小时内同一个键反复出现 3 次，发一条“反复”通知后静默 1 小时（仍写事件表）。静默期间坏了且下一轮仍然坏（真故障而不是抖动），立即打破静默照常告警；静默中升级也结束静默；静默期间恢复的，静默结束时补发“已恢复”。
- 一条告警升级到严重后，在警告和严重之间来回不再重复通知（只在第一次升到严重时发“升级”）。
- 依赖没过的检查本轮不判断，保持原状：例如数据库不可用时，订阅检查不报，也不会被当成“已恢复”。
- 部署锁被持有时（`deploy-dev`、`scripts/m1/install`、`deploy-lock run`，用 `lsof` 看锁文件是否被打开，不去碰锁本身；每项检查和重查都重新看一次），Web、Worker、Postgres、公网入口和卡住/积压类业务巡检不判断，huihuimac 的公网拨测也暂停；最长 45 分钟，超过照常判断。
- 检查给不出结论时（如持锁期间的共享 VM、确认期内的授权错误、触发告警的额度窗口暂时读不到）记为“未知”：已有告警保持原状，也不新开。
- 单轮超过时限（M1 240 秒），只有卡住的那项按未知处理，已跑完的检查结果照常报告，另报 `monitor_round`。状态文件读不出来时另存为 `state.json.corrupt-<时间>` 并报 `monitor_state`。
- 每条告警、升级、提醒和恢复都写进 `allrice_operational_incidents`（`kind` 为 `monitor_alert` / `monitor_recovered`，`detail_code` 为 `monitor.<键>`，`metadata.event` 是 opened/escalated/reminder/flapping/recovered，`metadata.alertId` 把它们连到同一条告警）。写不进去（如数据库正好挂了）先存在本地，下一轮再写；积压超过 30 分钟会报 `monitor` 告警。huihuimac 的告警在 M1 连得上时经 SSH 交给 M1 上的 `monitor ingest-incidents` 写入，连不上时存在 huihuimac 本地等下次。后台接口 `/api/v1/admin/model-governance` 的 `incidents` 能看到最近 25 条。
- Telegram 先按系统代理设置发，失败再直连重试一次（本地代理挂了不至于发不出告警）；公网拨测直连。发不出去时消息留在本地队列（最多 20 条），下一轮补发，每发出一条就落盘（只有发出到落盘之间的瞬间崩溃才可能重发一条）；心跳里记着从什么时候开始发不出去，对面那台看到连续失败超过 7 分钟（M1，两轮）/ 3 分钟（huihuimac，三轮）会替它报警。M1 每 4 分钟一轮，是为了让需要看两次才能下结论的告警（反复的键、对面的看门）也能在 10 分钟内发出。

## 检查项与阈值

阈值都在 `scripts/m1/monitor` 顶部的默认配置里，可以在 `~/allrice-dev/monitor/config.json` 里覆盖（只写要改的键）。

| 键                                            | 查什么                                                                                    | 告警条件（初始值）                                                                                                                                                       | 手册                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `postgres`                                    | `select 1`                                                                                | 连不上或 5 秒无响应：严重                                                                                                                                                | [数据库](m1-database.md)                    |
| `web` / `worker`                              | launchd 状态 + `/api/health/ready`、`/health/ready`（不 ready 时带上 `detail`）           | 不是 `ready`：严重；`native_once_blocked` 等定时控制器卡住另开一条 `worker_stuck`（带重启 Worker 的命令；Worker 已经报着不可用时也会单独通知）                           | [Worker 崩溃](m1-worker-crash.md)           |
| `versions`                                    | 两个服务上报的 `sourceSha`                                                                | 不一致：警告                                                                                                                                                             | [Worker 崩溃](m1-worker-crash.md)           |
| `restarts:<label>`                            | launchd 的 `runs` 计数（Web、Worker、隧道）                                               | 60 分钟内重启 2 次：警告；3 次：严重（1 次是 launchd 拉起来了或手工 kickstart，停机由就绪检查管）                                                                        | [Worker 崩溃](m1-worker-crash.md)           |
| `scheduler`                                   | Worker 就绪接口里的原生一次性/周期控制器                                                  | `blocked`/`closed`/`quarantined`、初始化失败或 3 分钟 `tickCount` 不涨：严重；`starting`/`stopping` 超 10 分钟、`faultCount` 增加：警告。`cold`（空闲）、`disabled` 不报 | [定时任务没触发](m1-schedule-not-fired.md)  |
| `sandbox_vm:<profile>`                        | `colima status`、VM 内 docker、`allrice-cloud-watchdog` 服务、`watchdog.py --attest` 证明 | 任一不正常（证明不是 `ready: true` 也算）：严重。只有守护停时镜像和 Office 照常检查                                                                                      | [沙箱 VM](m1-sandbox-vm.md)                 |
| `images`                                      | 运行中版本钉死的镜像（从发布目录的 `cloud-platform.js` 读，部署后自动跟上）是否都在 VM 里 | 缺任何一个：严重                                                                                                                                                         | [镜像丢失](m1-missing-image.md)             |
| `office`                                      | 容器 `allrice-office-renderer` 在运行且健康，`/health` 返回 `ready: true`                 | 任一不正常：严重                                                                                                                                                         | [沙箱 VM](m1-sandbox-vm.md#office-渲染容器) |
| `subscription`                                | 启用的 Codex 订阅槽位：授权状态、状态更新时间                                             | 无启用槽位/`disconnected`：严重；其他授权错误连续两轮（3 分钟以上）：严重；30 分钟没更新：警告。确认期间不判断                                                           | [模型订阅](m1-model-subscription.md)        |
| `quota`                                       | 启用槽位的额度（只算供应商标为已测量的窗口）                                              | 用完/≥95%：严重；≥80%、连续 30 分钟读不到：警告。读不到时不判断，已有的额度告警保持原状                                                                                  | [模型订阅](m1-model-subscription.md)        |
| `tunnel`                                      | launchd 隧道进程 + cloudflared 指标端口 `/ready` 的就绪连接数                             | 进程不在或就绪连接为 0：严重                                                                                                                                             | [隧道断开](m1-tunnel.md)                    |
| `public_entry`                                | 访问 `ALLRICE_PUBLIC_URL`（跟随跳转，应得 200）                                           | 15 秒内拿不到 200：严重                                                                                                                                                  | [隧道断开](m1-tunnel.md)                    |
| `disk:<路径>`                                 | 可用空间                                                                                  | 低于 100 GiB：警告；低于 30 GiB：严重                                                                                                                                    | [磁盘快满](m1-disk-space.md)                |
| `backup`                                      | 每日备份日志里最后一次 `ok` + launchd `ai.bplabs.allrice-dev-backup` 上次的退出码         | 上次运行失败或超过 50 小时/没有记录：严重；超过 26 小时、定时任务没加载：警告                                                                                            | [数据库](m1-database.md#每日备份)           |
| `peer` / `peer_telegram`                      | huihuimac 看门的心跳（与 huihuimac 看 M1 的判断相同）                                     | 4 分钟没更新、4 分钟没有一轮跑完、连不上：警告；连续 3 分钟发不出 Telegram：警告                                                                                         | 本页“看门”                                  |
| `monitor` / `monitor_round` / `monitor_state` | 事件表写入积压、单轮超过 240 秒、状态文件损坏                                             | 积压 30 分钟：警告；超时：严重；损坏：警告                                                                                                                               | 本页                                        |

huihuimac 一侧（`monitor peer`）：

| 键             | 告警条件                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------- |
| `m1_reachable` | SSH 连不上 M1（整机宕机、断网、Tailscale 断开）：严重                                       |
| `m1_heartbeat` | M1 监控心跳超过 6 分钟没更新、6 分钟没有一轮跑完（每轮开始了又出错）或读不到：严重          |
| `m1_telegram`  | M1 监控没配置 Telegram，或从第一次发送失败起已超过 8 分钟（两轮）：警告                     |
| `public_entry` | 从 huihuimac 访问 M1 心跳里报告的公网地址，15 秒内拿不到 200：严重；M1 的部署锁被持有时暂停 |

## 安装（发布负责人）

M1 上，`scripts/m1/install` 会把 `monitor` 装进 `~/allrice-dev/bin`。第一次另需两步：

1. 告警凭证：`~/allrice-dev/monitor/telegram.env`（权限 600，不进仓库、不放 Dev 的 `.env`）：

   ```bash
   TELEGRAM_BOT_TOKEN=<bot token>
   TELEGRAM_CHAT_ID=<接收告警的 chat id>
   ```

   现在用的是 @Claude0311bot、发到用户私聊（用户 10-25 决定）。这个 bot 也是用户和 Opus 对话用的，所以每条消息开头都有固定前缀 `【AllRice 告警】`（配置 `messagePrefix`）。

2. 安装定时任务并发一条测试消息：

   ```bash
   ~/allrice-dev/bin/monitor test-alert
   ~/allrice-dev/bin/monitor launchd install
   ```

   plist 指向 `~/allrice-dev/bin/monitor`，以后 `scripts/m1/install` 换版本时自动用新版，不用重装 launchd。

huihuimac 上（没有 AllRice 仓库副本，直接复制 M1 已安装的版本）：

```bash
mkdir -p ~/.local/share/allrice-monitor ~/.local/state/allrice-monitor-peer
scp m1:allrice-dev/bin/monitor m1:allrice-dev/bin/TOOLS_VERSION ~/.local/share/allrice-monitor/
# 凭证在 ~/.config/allrice-monitor/telegram.env（同上格式，权限 600，目录 700）
/usr/bin/python3 ~/.local/share/allrice-monitor/monitor test-alert --peer
/usr/bin/python3 ~/.local/share/allrice-monitor/monitor launchd install --peer
```

huihuimac 的告警通过 `ssh m1 allrice-dev/bin/monitor ingest-incidents` 写进 M1 的事件表，所以 M1 上要先装好 `monitor`。

事件表要先有迁移 `0220`（随 Dev 部署执行），否则写入会被 `kind` 约束拒绝，30 分钟后报 `monitor`；监控本身照常检查和发 Telegram。`scripts/m1/install` 装之前会用 `/usr/bin/python3`（3.9）跑一遍 `scripts/m1/test_monitor.py`。

## 日常命令

```bash
~/allrice-dev/bin/monitor status          # 未恢复的告警、上一轮、Telegram 和事件表积压
~/allrice-dev/bin/monitor run --dry-run   # 现在跑一遍，只打印，不发不写
tail -50 ~/allrice-dev/monitor/monitor.log
```

调阈值、关某项检查：在 `~/allrice-dev/monitor/config.json` 写覆盖值，例如 `{"skipChecks": ["peer"], "disks": [{"path": "~", "warnFreeGiB": 80, "criticalFreeGiB": 20}]}`。下一轮生效。

## 看门（监控自己挂了）

- M1 每轮开始和结束都写 `~/allrice-dev/monitor/heartbeat.json`；huihuimac 每 1 分钟用 SSH 读它。M1 整机宕机约 1–2 分钟报 `m1_reachable`；监控停了最迟约 7.5 分钟（6 分钟阈值 + 1 分钟间隔 + 重查）报 `m1_heartbeat`；每轮开始又出错（心跳在刷新但没有一轮跑完）约 7.5 分钟报 `m1_heartbeat`。
- huihuimac 每轮写 `~/.local/state/allrice-monitor-peer/heartbeat.json`，M1 每轮读它（`peer`、`peer_telegram`，判断和上面相同）。huihuimac 停了或发不出 Telegram，M1 报警告：此时 M1 整机故障将没人报警，尽快恢复。
- 收到 `m1_heartbeat`：`ssh m1 '~/allrice-dev/bin/monitor status; launchctl print gui/$(id -u)/ai.bplabs.allrice-dev-monitor | head -20; tail -50 ~/allrice-dev/monitor/monitor.log'`。
- 收到 `m1_reachable`：先确认 huihuimac 自己的网络和 Tailscale（`tailscale status`）；M1 在线但 SSH 不通，让用户到机器旁查看。M1 开着 FileVault，**无人值守重启后要有人到机器前登录**，服务才会起来。

## 诊断交给 Codex

需要定位根因时，派 Codex Sol 做只读诊断（AGENTS.md 第 9 节“线上问题诊断”），结论回报用户：

```bash
~/.local/bin/codex exec -C ~/allrice-repo -m gpt-6.1-sol -c model_reasoning_effort=max -s read-only \
  -o ~/allrice-dev/qa/codex/diagnose-$(date +%m%d-%H%M).md \
  "只读诊断 M1 Dev 告警：<粘贴告警原文>。查 deploy-dev --status、相关日志和只读 SQL，给出根因、证据和建议修法，不改代码、数据和配置。" </dev/null
```

## 演练

告警链路至少按下面四种演练过一遍（MET-222 记录）。演练用独立的状态目录、标签“演练”和独立的事件库，不碰共享 Dev 的服务、沙箱 VM 和库：

| 故障         | 做法                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------- |
| 沙箱 VM 停了 | 另建一个最小的 colima 测试实例，加进 `extraColimaProfiles`，`colima stop` 它                   |
| 镜像丢失     | 在 VM 里构建一个测试镜像，把它的 ID 加进 `extraImages`，再 `docker rmi` 删掉                   |
| 磁盘快满     | `hdiutil` 建一个小磁盘映像挂载，加进 `disks`，用 `dd` 填满（`mkfile -n` 是稀疏文件，不占空间） |
| 监控停了     | 停掉演练用的 M1 监控定时任务，等 huihuimac 报 `m1_heartbeat`                                   |
