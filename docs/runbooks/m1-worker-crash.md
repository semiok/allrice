# M1 处置手册 7：Worker 反复崩溃（及 Web 不可用）

对应告警：`worker`、`web`（不可用）、`restarts:<label>`（反复重启）、`versions`（版本不一致）、`memory`（内存余量不足）、`dsh_processes`（DSH 进程越积越多）。总览见 [m1-monitor.md](m1-monitor.md)。

## 影响

Worker 挂了：对话、定时任务、云端执行都停，排队的作业不会被领取（常同时出现业务巡检的队列积压）。Web 挂了：页面打不开。launchd 设了 `KeepAlive`，进程退出会被拉起，所以“反复重启”比“一直挂着”更常见：`restarts` 告警看的是 60 分钟内 launchd 的重启次数（部署会重新加载服务，不计入）。

## 第一步

```bash
~/allrice-dev/bin/deploy-dev --status
launchctl print gui/$(id -u)/ai.bplabs.allrice-dev-worker | grep -E "state|pid|runs|last exit|last terminating"
tail -100 ~/Library/Logs/allrice-dev-worker.err.log
tail -50 ~/Library/Logs/allrice-dev-web.err.log
curl -s -m 5 http://127.0.0.1:3012/health/ready | head -c 600; echo
```

## 判断

| 现象                                           | 多半是                                                       |
| ---------------------------------------------- | ------------------------------------------------------------ |
| 刚部署完就开始                                 | 新版本问题（启动自检拒绝、迁移和代码不匹配）                 |
| 日志里 `ECONNREFUSED 127.0.0.1:5432`           | 数据库，转 [m1-database.md](m1-database.md)                  |
| 日志里执行包、`REFERENCES_UNCOVERED`、启动自检 | 执行包或数据不匹配（AGENTS.md 第 5 节“已知限制”）            |
| 内存（`memory_pressure` 低、进程被 kill -9）   | 内存不够：先停自己不用的验收实例                             |
| `versions` 不一致                              | 部署中途失败或只重启了一个服务：`deploy-dev --status` 会显示 |

## 处理

1. **部署后出现**：发布负责人回滚 `deploy-dev --release-manager --rollback`（会先检查迁移和执行包兼容性，不兼容会拒绝），再在 MET 卡上记录。
2. **部署中断留下半成品**（`--status` 提示未完成的部署）：发布负责人 `deploy-dev --release-manager --recover`。
3. **依赖问题**（数据库、磁盘、沙箱）：先按对应手册处理依赖，Worker 一般会自己恢复。
4. **原因不明**：保留日志，派 Codex Astra 只读诊断（命令见 [m1-monitor.md](m1-monitor.md#诊断交给-codex)）。不要反复手动重启掩盖问题。

## 定时控制器卡住

告警“Worker 定时控制器卡住，要重启 Worker”：就绪接口 503，`detail` 是 `native_once_blocked`、`native_recurring_blocked` 或 `…_restart_required`。常见原因是数据库短暂断开（重启、维护）时控制器报了 `shutdown_failed`，之后一直停在 `blocked`，不会自己恢复（让它自动恢复记在 MET-210 #3）。这时定时任务都不会执行。

由发布负责人重启 Worker：

```bash
~/allrice-dev/bin/deploy-lock run worker-restart -- /bin/launchctl kickstart -k gui/$(id -u)/ai.bplabs.allrice-dev-worker
curl -s -m 5 http://127.0.0.1:3012/health/ready | /usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["status"], d.get("detail"), (d.get("nativeOnceControl") or {}).get("state"))'
```

`ready` 且控制器变成 `active` 就好了，再跑 `~/allrice-dev/bin/smoke-test --dev --only reminder`（每次重启 Worker 之后都跑）。重启后仍然 blocked，看 `lastFault`，派 Codex Astra 只读诊断；一直 `cold`（Worker 被 `kill -9`、崩溃或数据库在它运行时停掉后常见），见[手册 8“接管被拒”](m1-schedule-not-fired.md#接管被拒)。

## 内存不足、DSH 进程越积越多

告警“内存余量不足”（`memory_pressure -Q` 的可用比例低于 20% 警告、10% 严重）或“DSH 进程越积越多”（本机常驻的 DSH 进程达到 30 个）。

背景：每个用过的对话，Worker 都会留一个 DSH 进程（约 100–180 MB），对话结束后不退出，要等 Worker 重启才释放（空闲回收还没做，记在 MET-216 的切换后清单）。部署会重启 Worker，所以平时不明显；很多天不部署时，进程会随对话数一直增加。参考值：空闲时可用约 76%，3 个对话加 1 个 Office 导出同时跑时最低 64%（10-25 容量摸底）。

```bash
memory_pressure -Q | tail -1; sysctl -n vm.swapusage
ps -axo rss,etime,command | grep allrice-jsonrpc-runtime | grep -v grep | sort -nr | head
ps -axo rss,command | sort -nr | head -15
```

处理：

1. 先停掉自己不用的验收实例（`qa-instance list` / `qa-instance down <task>`）。
2. DSH 进程多、内存吃紧时，由发布负责人在没人用的时段重启 Worker（命令同上一节）。重启会中断正在进行的对话和任务，先确认没有进行中的 run。
3. 进程不多但内存仍然紧张：看第三条命令里谁占得多，按对应手册处理。

## 确认恢复

```bash
~/allrice-dev/bin/deploy-dev --status
~/allrice-dev/bin/smoke-test --dev
```

## 谁来做

重启、回滚、恢复共享 Dev 只由发布负责人做（AGENTS.md 第 9 节）；其他会话收到告警时把现象和日志写到 MET 卡上，紧急时直接告诉用户。
