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
4. 数据库恢复后，Web 和 Worker 通常自己重连；就绪接口仍不 ready 时，由发布负责人重启（`deploy-lock run`）。**数据库断开过之后，单次定时控制器可能停在 `blocked`**（就绪接口 503、`detail: native_once_blocked`），它不会自己恢复，要重启 Worker，见 [m1-worker-crash.md](m1-worker-crash.md#定时控制器卡住)。Worker 运行中数据库被停掉时，它多半来不及写下定时分区的关闭证明：重启后的 Worker 一直 `cold`、照样 ready，监控报 `scheduler_takeover`，按 [手册 8“接管被拒”](m1-schedule-not-fired.md#接管被拒)恢复。重启 Worker 之后一律跑 `~/allrice-dev/bin/smoke-test --dev --only reminder`。
5. 数据坏了需要恢复备份，或者迁移之后要退回迁移前：见下面的[恢复备份或迁移前快照](#恢复备份或迁移前快照)。

## 恢复备份或迁移前快照

只由发布负责人做，先问用户：备份或快照之后写进 Dev 的数据都会丢。两种来源格式相同，恢复步骤只有这一套：

| 来源                                                                                              | 位置                                                                                                                                                      | 说明                                                                                                       |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 每日备份（04:00，保留 7 天）                                                                      | `~/allrice-backups/db/allrice_dev-<日期>.sql.gz`、`~/allrice-backups/files/<日期>/`                                                                       | Dev 运行时做的，数据库和文件不是同一时刻，恢复后以数据库为准                                               |
| 迁移前快照（`deploy-dev` 在候选版本带未执行的迁移、或加了 `--force-snapshot` 时做，保留最近两份） | `~/allrice-dev/qa/pre-migrate/<发布名>/`：`allrice_dev.sql.gz`、状态目录（`storage`、`dsh-runtime-m1` 等）、`env`、迁移前的 `web.plist` 和 `worker.plist` | 两个服务都停着时做的，数据库和文件是同一时刻。数据库和状态目录要一起恢复，否则日志和库里的契约高水位对不上 |

下面 `$S` 是快照目录，`$T` 是当前时间，只用数字和下划线（它会成为库名的一部分），例如 `20261027_0930`。用每日备份时，导出文件换成 `~/allrice-backups/db/allrice_dev-<日期>.sql.gz`，状态目录和 launchd 文件在 `~/allrice-backups/files/<日期>/`。

1. 先恢复到一个新库核对，不动 Dev。0207 的 `allrice_native_calendar_control_valid` 用未限定名字调用其他函数；`pg_dump` / `pg_restore` 默认把会话 `search_path` 清空，COPY 提醒控制行时 CHECK 会报函数不存在。这是已有的恢复问题，函数修复另行处理。B2 第 13 步已验证：先生成 SQL，**只把** `set_config('search_path', '', false)` 的值改成 `public, pg_catalog`，再用 `psql -X -v ON_ERROR_STOP=1 -f` 执行；不禁用触发器、约束或跳过表。

   ```bash
   export S=<快照目录> T=<时间>   # 下面持锁的新 shell 也要用这两个变量，所以要 export
   umask 077
   gunzip -c "$S/allrice_dev.sql.gz" > "$S/restore-original.sql"
   # 若来源是 custom 格式的 dump，用下一行代替 gunzip；恢复到新库，不加 --create / --clean。
   # pg_restore --no-owner --no-privileges --file="$S/restore-original.sql" <迁移前.dump>
   sed "s/set_config('search_path', '', false)/set_config('search_path', 'public, pg_catalog', false)/g" \
     "$S/restore-original.sql" > "$S/restore-public.sql"
   diff -u "$S/restore-original.sql" "$S/restore-public.sql"   # 差异只能是上述 search_path
   createdb -h 127.0.0.1 "allrice_dev_restore_$T"
   psql -h 127.0.0.1 -X -q -v ON_ERROR_STOP=1 -d "allrice_dev_restore_$T" -f "$S/restore-public.sql"
   psql -h 127.0.0.1 -X "allrice_dev_restore_$T" -c 'select count(*), max(name) from allrice_schema_migrations'
   ```

2. 决定切换后，在持部署锁的 shell 里做（在第 1 步那个 shell 里运行 `~/allrice-dev/bin/deploy-lock run restore -- /bin/bash`，`S`、`T` 才会带进去）：
   1. 先确认变量和恢复库都在，没打出 `ok` 就停下，什么都别动（否则下面的改名会把 `allrice_dev` 改走却换不回来）：

      ```bash
      [ -n "${S:-}" ] && [ -n "${T:-}" ] && [ -d "$S" ] \
        && [ "$(psql -h 127.0.0.1 -X -Atc "select count(*) from pg_database where datname = 'allrice_dev_restore_$T'" postgres)" = 1 ] && echo ok
      ```

   2. 停 Web 和 Worker（`launchctl bootout gui/$(id -u)/ai.bplabs.allrice-dev-web`，Worker 同理），Worker 要等进程退完（做法见下面“重启或停库”第 1 步）。
   3. 改名换库，原库保留下来查原因、不删。巡检每 4 分钟连一次库，所以先断开连接再改名；改名报 `is being accessed by other users` 就把这两句重跑一次：

      ```bash
      psql -h 127.0.0.1 -X postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'allrice_dev' and pid <> pg_backend_pid()"
      psql -h 127.0.0.1 -X postgres -c "alter database allrice_dev rename to allrice_dev_failed_$T"
      psql -h 127.0.0.1 -X postgres -c "alter database allrice_dev_restore_$T rename to allrice_dev"
      ```

   4. 状态目录：`~/allrice-dev/.local/` 里和 `$S` 同名的目录先改名保留（`mv storage storage.failed-$T`），再从 `$S` 拷回（快照用 `cp -c -pR`，每日备份用 `rsync -a`）。**`dsh-platform` 默认不拷回**：它是模型订阅凭证，验收实例也在用，Dev 停着时它们可能刷新过 token，拷回旧的会让订阅失效；只有凭证本身坏了才恢复它。`bridge`、`project-preview`、`quality-evidence`、`repository-baselines` 不在快照和备份里，不动（它们会比恢复后的数据库新）。`env` 只在 `.env` 被改过时才拷回。
   5. 起服务：`~/allrice-dev/qa/deploy-inflight/` 还在（部署没走完）时，退出这个 shell，运行 `deploy-dev --release-manager --recover`，它会放回保存的 launchd 文件、起旧版本并核对。否则把 `$S` 里的 `web.plist`、`worker.plist` 拷回 `~/Library/LaunchAgents/`（文件名 `ai.bplabs.allrice-dev-web.plist`、`-worker.plist`），先起 Worker 再起 Web（`launchctl bootstrap gui/$(id -u) <plist>`），等两个就绪接口都报 ready。快照按新版本命名，里面的 plist 却指向部署之前的发布目录：拷回前先确认 plist 里的 `WorkingDirectory` 还在（可能已被清理），不在就用 `deploy-dev` 重新部署那个版本，不要手工拼目录。

3. `deploy-dev --status` 看两个服务的版本，跑 `~/allrice-dev/bin/smoke-test --dev`；在 MET 卡上记下恢复到了哪个时刻、丢了哪段时间的数据。手工恢复后 `~/allrice-dev/qa/.previous-release` 和 `deploys.jsonl` 不会自动更新：下一次回滚要用 `--rollback <发布目录>` 指定目标。

## 重启或停库

只由发布负责人做，持部署锁（`deploy-lock run <任务> -- …`），先在 MET 卡上说一声。

**先停 Worker，再动数据库；先起数据库，再起 Worker**（MET-210 #3：10-25 23:25 数据库在 Worker 运行时停掉，定时分区没有关闭证明，之后 12 小时没有任何定时任务触发）。Worker 正常退出时才会关掉两个定时分区、写下关闭证明。整个过程在一个持部署锁的 shell 里做，中间不会有部署插进来启动 Worker，监控也按维护处理（最长 45 分钟）：

```bash
~/allrice-dev/bin/deploy-lock run pg-maint -- /bin/bash
```

在这个 shell 里依次（这里不能再用 `deploy-lock run` 和 `schedule-recover --execute`：锁已经被自己占着）：

1. 正常停 Worker（Web 不用停）。`bootout` 立刻返回，进程要几秒才退完，等到最后一行没有输出：

   ```bash
   W=ai.bplabs.allrice-dev-worker
   /bin/launchctl bootout gui/$(id -u)/$W
   for i in $(seq 90); do pgrep -qf 'allrice-dev/.env .*apps/worker' || break; sleep 1; done; pgrep -fl 'allrice-dev/.env .*apps/worker'
   ```

2. 确认两个分区都已凭关闭证明关好：只读检查，两行都应是 `closed, ok`（Worker 刚停完时可能显示租约还没到期、退出码 4：等到提示的时间再看）：

   ```bash
   ~/allrice-dev/bin/schedule-recover --dev
   ```

   有 `ORPHAN` 就先别动数据库：`exit` 退出这个 shell，按[手册 8“接管被拒”](m1-schedule-not-fired.md#接管被拒)恢复（Worker 停着时它不会替你启动 Worker），再从第 1 步重来，这时第 2 步会显示 `closed, ok`。

3. 按下面的做法重启或停库，等 `pg_isready -h 127.0.0.1` 返回 accepting connections。
4. 再起 Worker，等两个控制器变成 `active`（旧进程没退完时 `bootstrap` 会报 `5: Input/output error`）：

   ```bash
   /bin/launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/$W.plist && /bin/launchctl kickstart gui/$(id -u)/$W
   curl -s -m 5 http://127.0.0.1:3012/health/ready | /usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["status"], d["nativeOnceControl"]["state"], d["nativeRecurringControl"]["state"])'
   ```

5. `exit` 退出 shell、释放锁，再跑提醒冒烟（**每次重启 Worker 之后都跑**：看到 `cold` 不等于正常，10-25 就是这样拖了 12 小时）：`~/allrice-dev/bin/smoke-test --dev --only reminder`。

- **不要用 `brew services restart` / `brew services stop`**：launchd 发的 SIGTERM 对 Postgres 是 smart shutdown，要等所有客户端断开；共享 Dev 的连接池不会断，launchd 等满 `ExitTimeOut`（120 秒）后强杀，下次启动要做崩溃恢复（10-25 16:28 就是这样）。
- **重启**：`/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /opt/homebrew/var/postgresql@17 stop -m fast -W`。fast shutdown 断开客户端、干净地停；plist 设了 `KeepAlive`，launchd 马上把它拉起来（刚启动过不到 10 秒时会等满 10 秒）。用 `pg_isready -h 127.0.0.1` 等到 accepting connections。一定要带 `-W`（不等待）：不带时 `pg_ctl` 会把 launchd 拉起的新进程当成旧的没停，30 秒后误报 “server does not shut down”。不需要再 `brew services start`。
- **停下不再起**（例如改数据目录）：先在后台卸载，再把它升级成 fast：`launchctl bootout gui/$(id -u)/sh.brew.postgresql@17 & sleep 1; /opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /opt/homebrew/var/postgresql@17 stop -m fast -W; wait`。bootout 先卸载任务，launchd 不会再拉起；它发的 SIGTERM 是 smart shutdown，紧接着的 fast 请求把它升级，1 秒内停完。不靠抢时间。之后 `brew services start postgresql@17` 启动。
- 这两种做法在 M1 上用一个与 brew 的 plist 设置完全相同（`KeepAlive`、`LC_ALL`、`ExitTimeOut 120`）、已运行 20 秒以上的测试实例实测过（10-25）：有客户端连着时，重启 1 秒内新进程就绪；停库 1 秒内完成且任务已卸载；日志都是干净关闭，没有崩溃恢复。直接 bootout（即 `brew services stop/restart`）则是 smart shutdown，15 秒后仍在等客户端。
- 重启后看 Worker 就绪接口；`native_once_blocked` 就重启 Worker（见上面第 4 条），控制器一直 `cold` 见手册 8“接管被拒”。

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
