# M1 处置手册 8：定时任务到点没触发

对应告警：`scheduler`（定时任务控制器异常）、`scheduler_takeover`（定时控制器接管不了分区）、业务巡检 `business.overdue_schedules`（到点未触发）。总览见 [m1-monitor.md](m1-monitor.md)。

## 影响

用户设的提醒、周期任务不执行，用户往往很久以后才发现。定时任务由 Worker 里的原生控制器驱动：一次性任务（`nativeOnceControl`）和周期任务（`nativeRecurringControl`）。控制器停摆时所有定时任务都停；单个任务没触发多半是这个任务自己的问题。

## 第一步

```bash
curl -s -m 5 http://127.0.0.1:3012/health/ready | /usr/bin/python3 -c 'import json,sys
d=json.load(sys.stdin)
for k in ("nativeOnceControl","nativeRecurringControl"):
    c=d.get(k) or {}; print(k, c.get("state"), "ticks", c.get("tickCount"), "faults", c.get("faultCount"), "inFlight", c.get("inFlight"))'
grep -iE "schedule|recurring|once" ~/Library/Logs/allrice-dev-worker.err.log | tail -30
```

隔一分钟再看一次 `tickCount`：在涨说明控制器活着。状态的含义（与监控的判断一致）：

| 状态                                 | 含义                                                       |
| ------------------------------------ | ---------------------------------------------------------- |
| `active`                             | 正常运行                                                   |
| `cold`                               | 一闪而过是正常；持续两轮以上见“接管被拒”；初始化失败是故障 |
| `starting` / `stopping`              | 过渡状态，几秒到几十秒；超过 10 分钟才算卡住               |
| `disabled`                           | 环境变量没开这一类原生定时，不是故障                       |
| `blocked` / `closed` / `quarantined` | 故障：控制器停了或被隔离                                   |

## 处理

1. **`blocked`/`closed`/`quarantined`、`cold` 且 `lastFault.phase` 是 `initialization`，或 `tickCount` 不涨**：整个 Worker 的定时部分停了。由发布负责人**重启 Worker**，命令见 [m1-worker-crash.md](m1-worker-crash.md#定时控制器卡住)（数据库断开过之后常见：`native_once_blocked`，不会自己恢复）。重启后仍不对，回滚到上一个版本，并派 Codex Astra 只读诊断。`disabled`、短暂的 `cold` 和 `starting` 不需要处理；一直 `cold` 见“接管被拒”。
2. **`faultCount` 在涨**：控制器在跑但处理任务出错，看 Worker 日志里对应的错误码，按出错的任务处理。
3. **控制器正常，个别任务没触发**：业务巡检告警里给了任务 ID。查任务状态和最近一次运行：

   ```bash
   /opt/homebrew/bin/psql -h 127.0.0.1 -At allrice_dev -c "
     select id, status, clock_owner, schedule, next_run_at, last_run_at, deleted_at
     from allrice_automations where id = '<任务 ID>'"
   ```

   常见原因：任务绑定的员工被停用、会话被删除、订阅不可用导致运行失败（看 `business.failed_runs` 和 `subscription`）。用户可见的修复（重新创建提醒）告诉用户；需要改数据只由发布负责人做。

## 接管被拒

告警 `scheduler_takeover`：控制器连续两轮 `cold`。严重：分区还被一个已停的 owner 持有（租约过期、没有关闭证明）、证明和审计表对不上，或者有命令等着交给原生时钟。这时 Worker 照样 `ready`、不报错，所有定时任务都不会触发（10-25 23:25 起停了 12 小时，MET-210 #3）。警告：分区被另一个租约有效的 owner 持有（两个 Worker 连着同一个库？），或者分区正常关闭了也没人接手，派 Codex 只读诊断。

原因：Worker 正常退出时会关掉一次性和周期两个分区，写下关闭证明，下一个 Worker 凭证明接手。Worker 没正常退出（运行中数据库被停掉、`kill -9`、断电），证明就没有写；租约过期也不算证明，因为旧 Host 可能还在跑，于是之后所有 Worker 都接不了手，重启 Worker 或整机都没用。

处理（发布负责人）：

1. 只读演示，看哪些分区卡住、会做什么：

   ```bash
   ~/allrice-dev/bin/schedule-recover --dev
   ```

   标着 `ORPHAN` 的就是卡住的分区。退出码 4 表示有租约还没到期、又不是正在运行的 Worker 持有（比如 Worker 刚停）：到提示的时间之后再跑。别的状态（`closed, but its proof is not the audited one`、`open with an audit row`）这个工具不处理，派 Codex 只读诊断。

2. 在 MET 卡上说一声，然后执行（最长约 5 分钟；从 agent 里跑要给足超时）：

   ```bash
   ~/allrice-dev/bin/schedule-recover --dev --release-manager --execute
   ```

   它自己持部署锁（不要再套 `deploy-lock run`，也不能在持锁的 shell 里跑），依次：
   - 整库备份到 `~/allrice-backups/schedule-recover-<时间>/`（不自动清理，确认恢复后移到废纸篓）；
   - 停 Worker，确认没有留下可能持有分区的进程：环境里 `DATABASE_URL` 指向这个库的（Worker、DSH 子进程、用 `with-env` 手工起的）、从发布目录或 `.env` 起的 node 进程，库里也没有 Worker 的连接，也就是旧 owner 确实已经退出。还有这样的进程就列出来、拒绝写入：先查清那是什么（部署的构建和检查也会被列出来，等它结束再跑）；
   - 再读一次分区，在一个事务里给每个卡住的分区登记 `verified_process_exit` 关闭证明。owner、epoch、token、仍未关闭、租约已过期、还没有证明，任何一项和读到的对不上就整笔回滚，不写任何东西；任务账本不动；
   - 开始时 Worker 在跑，就重新启动它，等两个控制器变成 `active`，中途失败或被中断也会把它拉起来（被 `kill -9` 时不会：看 `deploy-dev --status`，手工启动）；开始时 Worker 本来就停着（比如手册 5 的停库流程里），就让它继续停着。

3. 跑下面“确认恢复”的提醒冒烟。已经过了时间、还没交给原生时钟的一次性提醒不会补发（之后会报 `native_once_missed`），请用户在产品里改期或重建；停摆期间到点的其他任务，按 `business.overdue_schedules` 告警里的任务 ID 逐个核对。

## 确认恢复

`scheduler`、`scheduler_takeover` 告警自动恢复后，用冒烟测试的提醒项确认（**每次重启 Worker 之后都跑**）：

```bash
~/allrice-dev/bin/smoke-test --dev --only reminder
```
