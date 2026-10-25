# M1 处置手册 7：Worker 反复崩溃（及 Web 不可用）

对应告警：`worker`、`web`（不可用）、`restarts:<label>`（反复重启）、`versions`（版本不一致）。总览见 [m1-monitor.md](m1-monitor.md)。

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
4. **原因不明**：保留日志，派 Codex Sol 只读诊断（命令见 [m1-monitor.md](m1-monitor.md#诊断交给-codex)）。不要反复手动重启掩盖问题。

## 定时控制器卡住

告警“Worker 定时控制器卡住，要重启 Worker”：就绪接口 503，`detail` 是 `native_once_blocked`、`native_recurring_blocked` 或 `…_restart_required`。常见原因是数据库短暂断开（重启、维护）时控制器报了 `shutdown_failed`，之后一直停在 `blocked`，不会自己恢复（让它自动恢复记在 MET-210 #3）。这时定时任务都不会执行。

由发布负责人重启 Worker：

```bash
~/allrice-dev/bin/deploy-lock run worker-restart -- /bin/launchctl kickstart -k gui/$(id -u)/ai.bplabs.allrice-dev-worker
curl -s -m 5 http://127.0.0.1:3012/health/ready | /usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["status"], d.get("detail"), (d.get("nativeOnceControl") or {}).get("state"))'
```

`ready` 且控制器不再是 `blocked` 就好了；重启后仍然 blocked，看 `lastFault`，派 Codex Sol 只读诊断。

## 确认恢复

```bash
~/allrice-dev/bin/deploy-dev --status
~/allrice-dev/bin/smoke-test --dev
```

## 谁来做

重启、回滚、恢复共享 Dev 只由发布负责人做（AGENTS.md 第 9 节）；其他会话收到告警时把现象和日志写到 MET 卡上，紧急时直接告诉用户。
