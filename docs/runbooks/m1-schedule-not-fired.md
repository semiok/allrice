# M1 处置手册 8：定时任务到点没触发

对应告警：`scheduler`（定时任务控制器异常）、业务巡检 `business.overdue_schedules`（到点未触发）。总览见 [m1-monitor.md](m1-monitor.md)。

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
| `cold`                               | 空闲：眼下没有需要它的定时任务，正常；初始化失败时才是故障 |
| `starting` / `stopping`              | 过渡状态，几秒到几十秒；超过 10 分钟才算卡住               |
| `disabled`                           | 环境变量没开这一类原生定时，不是故障                       |
| `blocked` / `closed` / `quarantined` | 故障：控制器停了或被隔离                                   |

## 处理

1. **`blocked`/`closed`/`quarantined`、`cold` 且 `lastFault.phase` 是 `initialization`，或 `tickCount` 不涨**：整个 Worker 的定时部分停了。由发布负责人**重启 Worker**，命令见 [m1-worker-crash.md](m1-worker-crash.md#定时控制器卡住)（数据库断开过之后常见：`native_once_blocked`，不会自己恢复）。重启后仍不对，回滚到上一个版本，并派 Codex Sol 只读诊断。`cold`、`disabled`、短暂的 `starting` 不需要处理。
2. **`faultCount` 在涨**：控制器在跑但处理任务出错，看 Worker 日志里对应的错误码，按出错的任务处理。
3. **控制器正常，个别任务没触发**：业务巡检告警里给了任务 ID。查任务状态和最近一次运行：

   ```bash
   /opt/homebrew/bin/psql -h 127.0.0.1 -At allrice_dev -c "
     select id, status, clock_owner, schedule, next_run_at, last_run_at, deleted_at
     from allrice_automations where id = '<任务 ID>'"
   ```

   常见原因：任务绑定的员工被停用、会话被删除、订阅不可用导致运行失败（看 `business.failed_runs` 和 `subscription`）。用户可见的修复（重新创建提醒）告诉用户；需要改数据只由发布负责人做。

## 确认恢复

`scheduler` 告警自动恢复后，用冒烟测试的提醒项确认：

```bash
~/allrice-dev/bin/smoke-test --dev --only reminder
```
