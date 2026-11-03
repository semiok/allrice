# M1 监控与告警（MET-222）

目标：M1 上的 AllRice 出了问题，10 分钟内在 Telegram 知道哪里坏了、影响多大、第一步做什么；监控自己挂了也有人知道。

## 组成

| 部分            | 位置                                                                                                            | 频率      |
| --------------- | --------------------------------------------------------------------------------------------------------------- | --------- |
| 组件健康        | M1 `~/allrice-dev/bin/monitor run`，launchd `ai.bplabs.allrice-dev-monitor`                                     | 每 4 分钟 |
| 业务巡检（SQL） | 同上，只读查询 `allrice_dev`                                                                                    | 每 4 分钟 |
| 入口拨测        | 同上（从 M1 经 Cloudflare 访问）+ huihuimac 的 `monitor peer`（从 M1 之外访问）                                 | 每 4 分钟 |
| 互相看门        | huihuimac `monitor peer`，launchd `ai.bplabs.allrice-monitor-peer`；M1 也检查它的心跳                           | 每 1 分钟 |
| 日报            | M1 每天 09:00 之后的第一轮发出                                                                                  | 每天      |
| 告警出口        | Telegram（凭证只在两台机器的本地文件里）+ 表 `allrice_operational_incidents`（huihuimac 的经 SSH 写进 M1 的表） | 有变化时  |

源码只有一个文件 `scripts/m1/monitor`（Python 3.9 标准库，`/usr/bin/python3`），M1 和 huihuimac 用同一份：M1 跑 `run`，huihuimac 跑 `peer`。

## 告警规则

- 每项检查有固定的键（如 `worker`、`disk:~`、`sandbox_vm:allrice-cloud-arm`）。一个键变坏时开一条告警；一直坏着不重复发，只在升级（警告→严重）或提醒（严重每 60 分钟、警告每 6 小时）时再发；变好时发“已恢复”和持续时长。
- 同一轮里所有变化合成**一条**消息；太长时按告警拆成几条（标 1/2、2/2），不会截掉后面的告警。组件类检查失败后隔 20 秒重查一次，仍失败才告警，避免一次抖动就报警；按项判断，同一检查里首查正常、只在重查时失败的项（如另一个域名、另一个 VM）本轮记为未知，下一轮再看两次。
- 1 小时内同一个键反复出现 3 次，发一条“反复”通知后静默 1 小时（仍写事件表）。静默期间坏了且下一轮仍然坏（真故障而不是抖动），立即打破静默照常告警；静默中升级也结束静默；静默期间恢复的，静默结束时补发“已恢复”。
- 一条告警升级到严重后，在警告和严重之间来回不再重复通知（只在第一次升到严重时发“升级”）。
- `model_authorization` 是同一个授权事件的阶段通知：当前到期版本进入 72 小时内报一次警告，进入 24 小时内报一次严重；首次接入已经不足 24 小时只报 24 阶段，已经到期也沿用该阶段。首次新增确证过期错误再通知一次（即使此前已报 24 小时严重），之后只累计数量，不按通用提醒周期重发。此项及其读取异常 `model_authorization_data` 不使用反复静默；其他检查保留原规则。重新授权后的恢复条件见下文。
- 日志无法判断时，仍按可读的到期字段发出可靠的 72/24 小时预警，同时保留读取异常；未知只阻止证明恢复。时间阶段按当前到期版本去重：即使 E1 的旧故障因未知尚未恢复，E2 进入 72/24 小时仍分别提醒，保留旧事件和较高严重级别，不假恢复。前一轮读到 E1、下一轮同时读到 E2 前移和首次过期错误时，保留 E1→E2 的重新授权依据，错误仍会重置安静窗口，不要求用户为同一故障额外授权一次。
- 依赖没过的检查本轮不判断，保持原状：例如数据库不可用时，业务巡检和订阅检查不报，也不会被当成“已恢复”。
- 部署锁被持有时（`deploy-dev`、`scripts/m1/install`、`deploy-lock run`，用 `lsof` 看锁文件是否被打开，不去碰锁本身；每项检查和重查都重新看一次），Web、Worker、Postgres、公网入口和卡住/积压类业务巡检不判断，huihuimac 的公网拨测也暂停；最长 45 分钟，超过照常判断。
- 检查给不出结论时（如持锁期间的共享 VM、确认期内的授权错误、触发告警的额度窗口暂时读不到）记为“未知”：已有告警保持原状，也不新开。
- 单轮超过时限（M1 240 秒），只有卡住的那项按未知处理，已跑完的检查结果照常报告，另报 `monitor_round`。公网入口按域名算：几个域名同时拨测，每个最多等 17 秒，卡住的判不可达；超时那一轮已拨完的域名中，正常的照常计入，只看到一次失败的记为未知；重查时超时的，已重查完的域名按两次结果判断。状态文件读不出来时另存为 `state.json.corrupt-<时间>` 并报 `monitor_state`。
- 每条告警、升级、提醒和恢复都写进 `allrice_operational_incidents`（`kind` 为 `monitor_alert` / `monitor_recovered`，`detail_code` 为 `monitor.<键>`，`metadata.event` 是 opened/escalated/reminder/flapping/recovered，`metadata.alertId` 把它们连到同一条告警）。写不进去（如数据库正好挂了）先存在本地，下一轮再写；积压超过 30 分钟会报 `monitor` 告警。huihuimac 的告警在 M1 连得上时经 SSH 交给 M1 上的 `monitor ingest-incidents` 写入，连不上时存在 huihuimac 本地等下次。后台接口 `/api/v1/admin/model-governance` 的 `incidents` 能看到最近 25 条。
- Telegram 先按系统代理设置发，失败再直连重试一次（本地代理挂了不至于发不出告警）；公网拨测直连。发不出去时消息留在本地队列（最多 20 条），下一轮补发，每发出一条就落盘（只有发出到落盘之间的瞬间崩溃才可能重发一条）；心跳里记着从什么时候开始发不出去，对面那台看到连续失败超过 7 分钟（M1，两轮）/ 3 分钟（huihuimac，三轮）会替它报警。M1 每 4 分钟一轮，是为了让需要看两次才能下结论的告警（反复的键、对面的看门）也能在 10 分钟内发出。
- 每轮先在临时副本将告警事实与合并后的消息一起准备进现有 outbox，完整后一次替换并保存，再写 incident 和发送。若 90 秒交付时限在准备完成前触发，本轮超时收尾用已经完成的同一批 findings 做纯内存准备和本地保存后退出，不重新采样、不写数据库、不发送或重开外部交付时限。这样短暂读取异常或已确认恢复不会被下轮变化覆盖，incident 写出被打断时也保留已入队通知；后续仍通过原 outbox 按顺序交付。

## 检查项与阈值

阈值都在 `scripts/m1/monitor` 顶部的默认配置里，可以在 `~/allrice-dev/monitor/config.json` 里覆盖（只写要改的键）。

| 键                                            | 查什么                                                                                          | 告警条件（初始值）                                                                                                                                                                                                                       | 手册                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `postgres`                                    | `select 1`                                                                                      | 连不上或 5 秒无响应：严重                                                                                                                                                                                                                | [数据库](m1-database.md)                                    |
| `web` / `worker`                              | launchd 状态 + `/api/health/ready`、`/health/ready`（不 ready 时带上 `detail`）                 | 不是 `ready`：严重；`native_once_blocked` 等定时控制器卡住另开一条 `worker_stuck`（带重启 Worker 的命令；Worker 已经报着不可用时也会单独通知）                                                                                           | [Worker 崩溃](m1-worker-crash.md)                           |
| `versions`                                    | 两个服务上报的 `sourceSha`                                                                      | 不一致：警告                                                                                                                                                                                                                             | [Worker 崩溃](m1-worker-crash.md)                           |
| `restarts:<label>`                            | launchd 的 `runs` 计数（Web、Worker、隧道）                                                     | 60 分钟内重启 2 次：警告；3 次：严重（1 次是 launchd 拉起来了或手工 kickstart，停机由就绪检查管）                                                                                                                                        | [Worker 崩溃](m1-worker-crash.md)                           |
| `scheduler`                                   | Worker 就绪接口里的原生一次性/周期控制器                                                        | `blocked`/`closed`/`quarantined`、初始化失败或 3 分钟 `tickCount` 不涨：严重；`starting`/`stopping` 超 10 分钟、`faultCount` 增加：警告。`cold`（短暂）、`disabled` 不报                                                                 | [定时任务没触发](m1-schedule-not-fired.md)                  |
| `scheduler_takeover`                          | 一直 `cold` 的控制器，只读查它的分区                                                            | 连续两轮（3 分钟以上）`cold`：分区仍被已停的 owner 持有（租约过期、没有关闭证明）、证明和审计表对不上，或有命令等着交给原生时钟：严重；其余情况：警告                                                                                    | [手册 8](m1-schedule-not-fired.md#接管被拒)                 |
| `sandbox_vm:<profile>`                        | `colima status`、VM 内 docker、`allrice-cloud-watchdog` 服务、`watchdog.py --attest` 证明       | 任一不正常（证明不是 `ready: true` 也算）：严重。只有守护停时镜像和 Office 照常检查                                                                                                                                                      | [沙箱 VM](m1-sandbox-vm.md)                                 |
| `images`                                      | 运行中版本钉死的镜像（从发布目录的 `cloud-platform.js` 读，部署后自动跟上）是否都在 VM 里       | 缺任何一个：严重                                                                                                                                                                                                                         | [镜像丢失](m1-missing-image.md)                             |
| `office`                                      | 容器 `allrice-office-renderer` 在运行且健康，`/health` 返回 `ready: true`                       | 任一不正常：严重                                                                                                                                                                                                                         | [沙箱 VM](m1-sandbox-vm.md#office-渲染容器)                 |
| `subscription`                                | 启用的 Codex 订阅槽位：授权状态、状态更新时间                                                   | 无启用槽位/`disconnected`：严重；其他授权错误连续两轮（3 分钟以上）：严重；30 分钟没更新：警告。确认期间不判断                                                                                                                           | [模型订阅](m1-model-subscription.md)                        |
| `model_authorization`                         | DSH 既有 Codex 授权的 `payload.expires`（Unix 毫秒）和新增完整 Worker `Handler failed` 系统记录 | 72 小时内警告、24 小时内严重；明确 `DSH_PI_AI_ERROR` 且 message 为 `Your authentication token has expired` 的新增记录报严重。每阶段一次，message/cause 不双计；恢复须到期版本前移且在未来，并有至少 240 秒完整可读、无新增错误的扫描窗口 | [模型授权](m1-model-subscription.md#授权到期与确证过期错误) |
| `model_authorization_data`                    | 上述到期字段、日志可读性及游标连续性                                                            | 读取失败、格式不支持、记录未完、扫描积压或不可补读缺口：警告“无法判断”；不能恢复原授权故障。不可补缺口保留未知证据，直到新有效到期版本及完整安静窗口                                                                                     | [模型授权](m1-model-subscription.md#授权到期与确证过期错误) |
| `quota`                                       | 启用槽位的额度（只算供应商标为已测量的窗口）                                                    | 用完/≥95%：严重；≥80%、连续 30 分钟读不到：警告。读不到时不判断，已有的额度告警保持原状                                                                                                                                                  | [模型订阅](m1-model-subscription.md)                        |
| `tunnel`                                      | launchd 隧道进程 + cloudflared 指标端口 `/ready` 的就绪连接数                                   | 进程不在或就绪连接为 0：严重                                                                                                                                                                                                             | [隧道断开](m1-tunnel.md)                                    |
| `public_entry` / `public_entry:<域名>`        | `ALLRICE_PUBLIC_URL` 和 `extraPublicUrls`（员工入口、管理后台、Bridge），跟随跳转应得 200       | 15 秒内拿不到 200：严重                                                                                                                                                                                                                  | [隧道断开](m1-tunnel.md)                                    |
| `disk:<路径>`                                 | 可用空间                                                                                        | 低于 100 GiB：警告；低于 30 GiB：严重                                                                                                                                                                                                    | [磁盘快满](m1-disk-space.md)                                |
| `backup`                                      | 每日备份日志里最后一次 `ok` + launchd `ai.bplabs.allrice-dev-backup` 上次的退出码               | 上次运行失败或超过 50 小时/没有记录：严重；超过 26 小时、定时任务没加载：警告                                                                                                                                                            | [数据库](m1-database.md#每日备份)                           |
| `peer` / `peer_telegram`                      | huihuimac 看门的心跳（与 huihuimac 看 M1 的判断相同）                                           | 4 分钟没更新、4 分钟没有一轮跑完、连不上：警告；连续 3 分钟发不出 Telegram：警告                                                                                                                                                         | 本页“看门”                                                  |
| `monitor` / `monitor_round` / `monitor_state` | 事件表写入积压、单轮超过 240 秒、状态文件损坏                                                   | 积压 30 分钟：警告；超时：严重；损坏：警告                                                                                                                                                                                               | 本页                                                        |
| `business.*`                                  | 业务巡检                                                                                        | 见“业务巡检”                                                                                                                                                                                                                             | 见“业务巡检”                                                |

授权检查复用本脚本的文件锁、状态、告警合并、Telegram 和 incident 待发队列，不另起定时器或发送器。到期文件路径默认从 Worker launchd 环境或共享 Dev `.env` 的 `ALLRICE_DSH_PLATFORM_HOME` 派生为 `.credentials.yaml`；日志路径默认取 Worker plist 的 `StandardErrorPath`。可用既有 `config.json` 的 `modelAuthCredentials`、`modelAuthLog` 显式覆盖这两个路径。只投影 `records['llm-pi-ai/openai-codex'].payload.expires`，不刷新、写入或复制授权，也不发真实模型请求。状态只保留到期时间、安全游标、游标前最多 256 字节的局部摘要、布尔解析标记、数量及观察时间，不保留凭据其他字段或原始日志残行。

日志首次接入从 EOF 建基线，不补报历史。之后普通重启沿持久游标续读，rename 轮转从游标对应的旧段开始，按可验证的 `.N` → … → `.1` → 当前文件顺序补完所有中间段；预算未用完才继续下一段，耗尽时保留当前段游标。段缺失、非数字名称或无法确定顺序时明确未知，不能直接跳到当前文件证明完整。每轮增量正文最多读 8 MiB，另读局部前沿用于校验。积压、未完结记录和过长残行明确未知，不能跳过后当作零错误。旧段丢失、截断、编码或记录损坏会保留未知证据；完整记录中已确定的新增错误仍可告警。Worker stderr 没有发生时间戳，通知里的“最早观察时间 UTC”是最早读到该记录的采样时间，不是实际发生时间。

打开的 current 在列目录前被改名、又被归档链消费时，保留该 inode 的已读 offset，不能回到零重读；归档链若已推进更后段，也不回退到旧 FD。目录列出后才改名时，各段 open 后仍核对 device/inode，身份不符就保持未知，下一轮沿未提交的旧游标重新补读。

局部摘要可发现游标前沿变化，包括同 inode 截断后重新长过旧 offset 的情况；它不能证明两轮之间所有日志都保留下来了。已丢失的历史内容无法还原，同一前沿字节被原样重建、短暂缺失后恢复原状等没有可观察差异的情况也无法仅靠文件轮询识别。

新增授权错误正常在下一次 4 分钟采样被读取，之后仍有本轮其他检查、必要的 20 秒复查和发送耗时。240 秒采样轮次超时、90 秒交付保护、慢轮次导致 launchd 跳过触发、日志积压或 Telegram 待发都会拉长延迟，**4 分 20 秒不是硬上限**。恢复至少要求 `max(240, intervalSeconds)` 秒的完整安静窗口，有新增错误或读取不完整就重新计时。跨进程和普通重启靠同一个锁、state 和 outbox 去重；Telegram 成功后落盘前崩溃，或网络回执不明，仍可能重发，不能保证严格一次投递。

huihuimac 一侧（`monitor peer`）：

| 键             | 告警条件                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------- |
| `m1_reachable` | SSH 连不上 M1（整机宕机、断网、Tailscale 断开）：严重                                       |
| `m1_heartbeat` | M1 监控心跳超过 6 分钟没更新、6 分钟没有一轮跑完（每轮开始了又出错）或读不到：严重          |
| `m1_telegram`  | M1 监控没配置 Telegram，或从第一次发送失败起已超过 8 分钟（两轮）：警告                     |
| `public_entry` | 从 huihuimac 访问 M1 心跳里报告的公网地址，15 秒内拿不到 200：严重；M1 的部署锁被持有时暂停 |

## 业务巡检

每轮对 `allrice_dev` 跑业务只读 SQL，另读一次 Postgres 日志（`default_transaction_read_only`、单条 15 秒超时）。SQL 原文在 `scripts/m1/monitor` 的 `SQL_*` 常量里，阈值是 `config.json` 的 `business` 键。Dev 处于维护窗口（`allrice_dev_maintenance.state` 不是 `open`）时，Worker 故意不领任务，带 `admission` 的几项本轮不判断。

| 键                                                     | 判断依据（代码）                                                                                                                                                          | 初始阈值                                                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `business.failed_runs`                                 | 只算有 job 的根 run（子助手 run 不写 `completed_at`）；排除平台组织 `allrice-platform`、冒烟账号 `smoke`、员工预览/方法测试/经验验证；取消和 `APPROVAL_REJECTED` 不算失败 | 60 分钟里结束 ≥5 个时：失败 ≥3、≥20% 且（≥ 此前 24 小时基线的 2 倍或 ≥30%）为警告；失败 ≥5 且 ≥50% 为严重。不到 5 个时：失败 ≥3 且 ≥50% 为警告                                                      |
| `business.stuck_runs`                                  | 心跳和租约在 job 上（租约默认 30 秒，心跳 10 秒），`maintainQueue` 每秒收回过期租约；过期好几分钟还在 = 没有活着的 Worker 在维护；或 run 是 running 而 job 已不在执行     | 超过 5 分钟 ≥1 个：严重                                                                                                                                                                             |
| `business.silent_runs`                                 | 心跳定时器和业务处理分开，处理卡死时心跳照跳：看最后一条 run 事件，排除任务时钟暂停和有云端/本机操作在执行的                                                              | 30 分钟没有新事件：警告                                                                                                                                                                             |
| `business.online_waits` / `business.online_waits_data` | 当前完整前台快照 + 当前 Job/attempt/运行归属及物理证据；容量来自90秒内 Worker `capacity.concurrency`                                                                      | 占总执行位 ≥80% 警告、≥95% 严重；缺失/冲突为局部未知，不能恢复旧告警；可信下界达到阈值仍报警；失败复查一次                                                                                          |
| `business.dead_letters`                                | 死信只有三条路：可重试错误用完次数、最后一次租约过期（`LEASE_EXHAUSTED`）、开始时策略拒绝（`POLICY_DENIED`）；按 `completed_at` 统计                                      | 60 分钟内 ≥1：警告；≥3 或出现 `POLICY_DENIED`：严重                                                                                                                                                 |
| `business.queue`                                       | 到点（`available_at`）的 queued/retry_wait 没人领；排除平台 Dev 作业、经验整理（只在空闲时领）、待放行的追加消息。正常领取延迟 p95 约 2 秒                                | 等待 >5 分钟：警告；>15 分钟或此时没有任何作业在执行：严重                                                                                                                                          |
| `business.overdue_schedules`                           | 一次性任务以当前 revision 的 occurrence 行证明已触发；周期任务的 `next_run_at` 与 occurrence 同事务推进；两者都经 outbox 交给队列；旧版定时（legacy）已下线，永远不会触发 | 晚 4 分钟：警告；晚 30 分钟或定时分区（一次性/周期，只看上面有启用任务的）关闭或租约过期：严重；旧版残留、创建时已过时间而没执行的一次性提醒（`target_not_future`，直到有人改期、暂停或删除）：警告 |
| `business.waits`                                       | 只有原生提问和 workflow 审批会让 run 进入 `waiting_approval`，都没有超时；两者都没有的等待永远不会恢复                                                                    | 孤儿等待 >5 分钟：严重。等用户再久也是正常的，只在日报里列出超过 24 小时的个数                                                                                                                      |
| `business.unknown_ops`                                 | `snapshot.status = 'unknown'` 经 `operation.uncertain` 事件进入，只能靠迟到回执或人工核对离开，不能换一端重跑                                                             | 还有未解决的（运行操作或 Bridge 文件命令）或进行中但租约过期的：警告（取消只是意图，根任务结束也不算解决）；60 分钟新增 ≥3：严重                                                                    |
| `business.bridge`                                      | 产品里的“在线”= `last_seen_at` 在 90 秒内；长连接租约每 5 秒续期。只看最近 24 小时在线过、未撤销、账号有效的设备；合盖的单台不报                                          | 下班合盖人人离线，离线台数只进日报。心跳在但长连接断（服务端问题）、掉线且有仍在执行的任务的操作等了 30 分钟：警告；心跳在但长连接断 ≥2 台：严重                                                    |
| `business.deadlocks`                                   | `pg_stat_database.deadlocks` 按库累计（遇到重置重新计）；另数 `JOB_START_DEADLOCK`（死锁重试后仍失败的作业）                                                              | 1 小时内 ≥1：警告；≥5 或有作业因死锁启动失败：严重                                                                                                                                                  |
| `business.pg_resources`                                | Postgres 日志里新增的 `out of shared memory`（锁表满，整个实例共用）、连接数用满；日志每行带库名（`log_line_prefix` 含 `%d`）                                             | 1 小时内 ≥1：警告；≥20：严重                                                                                                                                                                        |

日报里有一行“失败分组”：24 小时的失败按错误码分组，分出新出现（此前 7 天没有）和变多（≥3 且 ≥ 此前日均 2 倍）；`monitor failures --json` 导出同样的数据（每组带样本 run 和错误信息前 200 字），供之后的每日问题报告直接读。

在线等答按“有当前真实前台待答问题的在线 Run 及有效 Job 占位”统计，依赖快照片先部署：既有 WorkerOperations 的 `onlineQuestions` v1 读取 Host 实际前台 map，不含题答。逐有效 Job 匹配当前 Worker/boot/runtime、Run/Job/attempt、root 与 chat thread/generation；完整新鲜的空题表才确定0，有题才确定1。clock active、child或其他工作不排除真实前台题；Run 与 Job 分别去重，多题/Host/child不叠加占位；终态、parked 已释放和过期 lease 排除。

物理证据复用 exact runtimeId 的 owned（Worker/租户/成员/上下文）和同 boot/owner_digest 的 process_closed；只有当前身份完整匹配的真实关闭才排除。须有同runtime/Worker/session/thread的inventory，未关闭时还须live且15秒内；close_started/request不是物理关闭。foreground有自己的 `sampledAt`，须90秒内且不晚于采集时点；Worker心跳或metadata更新不延长题的时间。deadline、旧pending及opened/ended均不用于猜前台；慢input delivery未结束时仍可计1，程序题实际清理后下次完整空采样计0。

当前可确定范围仅 `default_harness_router` 已取得Host且绑定完整的chat执行；独立platform-technical/experience-consolidation adapters及采样空窗内的有效Job逐Run未知。旧Host、字段/条目缺失、null、complete=false、重复候选、归属矛盾、题时间过期均未知，不能把未列出当0；每题冻结run/root/native身份须匹配当前root。精确总数/比例在未知时为null，JSON给confirmed/possible上下界及最多3个未知Run样本。未知不恢复旧高比例告警，只有完整精确健康才恢复；可信容量下，确定下界已高时仍报警。观测写失败只会使旧题采样过期，后续成功完整替换可自愈，不改变用户Run执行。

总执行位只加总 `allrice_runtime_metadata` 的 `worker-operations:<workerId>`：key 与合法 UUID 身份相符，`capacity.mode` 为 auto/configured、concurrency 为1–32整数、报告在90秒内（沿 `operations-resources.ts`）。这是 Worker 实际采用的配置，不重算 CPU/环境中的 auto，不累加每个 Worker 所带的全局 `pressure.jobs`。旧无有效租约的报告排除；新鲜非法报告、有效租约的 Worker 缺可信容量、完全无在线容量时，总位/占比保留未知，不能报0%健康。缺表/采集失败也保持未知；数据恢复不会提前消除仍高的占比告警。

`business.online_wait_warn_pct` / `online_wait_critical_pct` 可在现有配置调整，须 `0 < warning <= critical <= 100`。80/95 是本次用户批准比例告警后，参考现有 monitor 配额告警分级的运维初值，不是 DSH 默认，也不参与拒绝任务或强制结束。每轮采样和20秒复查存在投影传播窗口，不是进程级实时计数。

只读取同一 SQL 快照的 `monitor online-waits --json` / `monitor online-waits` 输出采集时间、Run 数、占位/总位、占比、最多3个已确认及3个未知 Run ID，以及 Worker 容量和报告时间（JSON）；日报含同一口径。命令不发送告警、不写 incident/alert，也不读取题目/答案正文。真实验收创建在线等答题后取该输出截图（child活跃仍应计1），回答后再取下降快照；高比例和未知分支在隔离 schema 验证，不为演练改执行容量或批量造真实任务。

收到业务告警的第一步：按告警里给的样本 ID（完整 UUID，可直接放进 SQL）在后台“租户运行检查”或用 SQL 查对应 run/job；多数业务告警是组件告警的后果（订阅不可用 → 失败突增，Worker 挂了 → 队列积压），先处理同时出现的组件告警。

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
~/allrice-dev/bin/monitor daily           # 立刻发日报
~/allrice-dev/bin/monitor failures --json # 24 小时失败按错误码分组（新出现/变多/其余），给每日问题报告读
~/allrice-dev/bin/monitor online-waits --json # 当前前台待答Run、实际占位/容量及来源；只读，可截图
tail -50 ~/allrice-dev/monitor/monitor.log
```

调阈值、关某项检查：在 `~/allrice-dev/monitor/config.json` 写覆盖值，例如 `{"skipChecks": ["peer"], "disks": [{"path": "~", "warnFreeGiB": 80, "criticalFreeGiB": 20}]}`。下一轮生效。

## 看门（监控自己挂了）

- M1 每轮开始和结束都写 `~/allrice-dev/monitor/heartbeat.json`；huihuimac 每 1 分钟用 SSH 读它。M1 整机宕机约 1–2 分钟报 `m1_reachable`；监控停了最迟约 7.5 分钟（6 分钟阈值 + 1 分钟间隔 + 重查）报 `m1_heartbeat`；每轮开始又出错（心跳在刷新但没有一轮跑完）约 7.5 分钟报 `m1_heartbeat`。
- huihuimac 每轮写 `~/.local/state/allrice-monitor-peer/heartbeat.json`，M1 每轮读它（`peer`、`peer_telegram`，判断和上面相同）。huihuimac 停了或发不出 Telegram，M1 报警告：此时 M1 整机故障将没人报警，尽快恢复。
- 收到 `m1_heartbeat`：`ssh m1 '~/allrice-dev/bin/monitor status; launchctl print gui/$(id -u)/ai.bplabs.allrice-dev-monitor | head -20; tail -50 ~/allrice-dev/monitor/monitor.log'`。
- 收到 `m1_reachable`：先确认 huihuimac 自己的网络和 Tailscale（`tailscale status`）；M1 在线但 SSH 不通，让用户到机器旁查看。M1 开着 FileVault，**无人值守重启后要有人到机器前登录**，服务才会起来。

## 诊断交给 Codex

需要定位根因时，派 Codex Astra 做只读诊断（AGENTS.md 第 9 节“线上问题诊断”），结论回报用户：

```bash
~/.local/bin/codex exec -C ~/allrice-repo -m gpt-6-astra -c model_reasoning_effort=max -s read-only \
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
