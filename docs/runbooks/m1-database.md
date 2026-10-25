# M1 处置手册 5：数据库不可用

对应告警：`postgres`（数据库不可用）、`backup`（每日备份异常）。总览见 [m1-monitor.md](m1-monitor.md)。

## 影响

Postgres 17（Homebrew 服务 `postgresql@17`，本机 5432）挂了，Web 和 Worker 全部不可用，告警里通常同时有 `web`、`worker`。数据库不可用时，监控不判断业务巡检和订阅（保持原状），告警写不进事件表的会先存本地，恢复后补写。

## 第一步

```bash
/opt/homebrew/bin/pg_isready -h 127.0.0.1
/opt/homebrew/bin/brew services list | grep postgres
tail -50 /opt/homebrew/var/log/postgresql@17.log
df -h ~                       # 磁盘满是最常见的原因之一
```

## 处理

1. **服务停了**：`/opt/homebrew/bin/brew services start postgresql@17`，等 `pg_isready` 返回 accepting connections。
2. **起不来**：看日志里的 `FATAL`/`PANIC`。磁盘满先按 [m1-disk-space.md](m1-disk-space.md) 腾空间；有 `postmaster.pid` 残留且确认没有 postgres 进程（`pgrep -l postgres`）时才删它。不要删数据目录里的任何别的文件，不要 `pg_resetwal`。
3. **连接数用满**（日志 `too many clients`）：`select application_name, state, count(*) from pg_stat_activity group by 1,2 order by 3 desc` 看是谁，通常是卡住的测试；只停自己的。
4. 数据库恢复后，Web 和 Worker 通常自己重连；就绪接口仍不 ready 时，由发布负责人重启（`deploy-lock run`）。**数据库断开过之后，单次定时控制器可能停在 `blocked`**（就绪接口 503、`detail: native_once_blocked`），它不会自己恢复，要重启 Worker，见 [m1-worker-crash.md](m1-worker-crash.md#定时控制器卡住)。
5. 数据坏了需要恢复备份：只由发布负责人做，先问用户。备份是纯 SQL（`~/allrice-backups/db/allrice_dev-<日期>.sql.gz`），恢复到一个新库：删掉文件里清空 `search_path` 的那一行 `set_config` 再用 `psql` 导入，核对后再决定是否切换。数据库和文件不是同一时刻的快照，恢复后以数据库为准。

## 重启或停库

只由发布负责人做，持部署锁（`deploy-lock run <任务> -- …`），先在 MET 卡上说一声。

- **不要用 `brew services restart` / `brew services stop`**：launchd 发的 SIGTERM 对 Postgres 是 smart shutdown，要等所有客户端断开；共享 Dev 的连接池不会断，launchd 等满 `ExitTimeOut`（120 秒）后强杀，下次启动要做崩溃恢复（10-25 16:28 就是这样）。
- **重启**：`/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /opt/homebrew/var/postgresql@17 stop -m fast -W`。fast shutdown 断开客户端、干净地停；plist 设了 `KeepAlive`，launchd 马上把它拉起来（刚启动过不到 10 秒时会等满 10 秒）。用 `pg_isready -h 127.0.0.1` 等到 accepting connections。一定要带 `-W`（不等待）：不带时 `pg_ctl` 会把 launchd 拉起的新进程当成旧的没停，30 秒后误报 “server does not shut down”。不需要再 `brew services start`。
- **停下不再起**（例如改数据目录）：先在后台卸载，再把它升级成 fast：`launchctl bootout gui/$(id -u)/sh.brew.postgresql@17 & sleep 1; /opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /opt/homebrew/var/postgresql@17 stop -m fast -W; wait`。bootout 先卸载任务，launchd 不会再拉起；它发的 SIGTERM 是 smart shutdown，紧接着的 fast 请求把它升级，1 秒内停完。不靠抢时间。之后 `brew services start postgresql@17` 启动。
- 这两种做法在 M1 上用一个与 brew 的 plist 设置完全相同（`KeepAlive`、`LC_ALL`、`ExitTimeOut 120`）、已运行 20 秒以上的测试实例实测过（10-25）：有客户端连着时，重启 1 秒内新进程就绪；停库 1 秒内完成且任务已卸载；日志都是干净关闭，没有崩溃恢复。直接 bootout（即 `brew services stop/restart`）则是 smart shutdown，15 秒后仍在等客户端。
- 重启后看 Worker 就绪接口；`native_once_blocked` 就重启 Worker（见上面第 4 条）。

## 资源耗尽

告警 `business.pg_resources`：日志里出现 `out of shared memory`（锁表满）或连接数用满。锁表是整个实例共用的，任何一个库把它挤满（例如多个会话同时跑数据库集成测试），共享 Dev 的普通查询也会失败。

```bash
grep -E "out of shared memory|too many clients" /opt/homebrew/var/log/postgresql@17.log | tail -20   # 每行带库名
/opt/homebrew/bin/psql -h 127.0.0.1 -At postgres -c "select datname, count(*) from pg_locks l join pg_database d on d.oid = l.database group by 1 order by 2 desc"
/opt/homebrew/bin/psql -h 127.0.0.1 -At postgres -c "select datname, application_name, state, count(*) from pg_stat_activity group by 1,2,3 order by 4 desc"
```

占用多的通常是测试库（`allrice_b2`、`allrice_qa_*`）里的测试；停自己的测试，别人的告诉对方。`max_locks_per_transaction` 已在 10-25 从 64 调到 1024，再调要重启数据库（按上一节做），先问用户。

## 每日备份

`backup` 告警：launchd `ai.bplabs.allrice-dev-backup` 每天 04:00 跑 `~/allrice-dev/bin/backup-daily`。

```bash
tail -20 ~/allrice-backups/logs/backup.err.log
tail -5 ~/allrice-backups/logs/backup.log
launchctl print gui/$(id -u)/ai.bplabs.allrice-dev-backup | grep -E "state|last exit"
ls -la ~/allrice-backups/db | tail -3
```

常见原因：数据库当时不可用、磁盘满、M1 睡眠错过时间点（launchd 唤醒后会补跑）。修好原因后可以手动补一次：`~/allrice-dev/bin/backup-daily`（会覆盖当天的备份，不影响服务）。

## 确认恢复

```bash
~/allrice-dev/bin/monitor run --dry-run | grep -E "postgres|backup|business"
~/allrice-dev/bin/smoke-test --dev --only chat
```
