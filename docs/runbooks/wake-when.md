# 后台等待与本线唤醒

等 CI 请加 `--interval 60`；新版会自动补 60 秒，显式间隔不得小于 30 秒。正在运行的旧等待不会被安装自动改写。

仓库 Skill 在 [`.agents/skills/wait-and-wake/SKILL.md`](../../.agents/skills/wait-and-wake/SKILL.md)，在任务 worktree 中可用 `$wait-and-wake`。从仓库外启动的旧会话需显式读取这份文件；不安装到 `~/.codex/skills`，不修改 Codex 配置。

在 M1 运行，等待过程中不占 Codex 回合，也不依赖 M5。工具通过 `~/.local/bin/codex queue` 给指定本线发一次回执，区分任务真实结论与等待命令退出码；等待失败／任务失败附最后 30 行诊断日志（长行截断）。回执不是新增业务、合并或部署授权。

```bash
~/allrice-dev/bin/wake-when \
  --thread <本线会话UUID> --label '#884 CI' --timeout 3h -- \
  /opt/homebrew/bin/gh run watch <run-id> --repo semiok/allrice --exit-status --interval 60
```

启动成功后立刻结束本回合；收到回执再继续，不让模型轮询、sleep 或发等待进度。默认最多等待 3 小时，`--timeout` 可写秒数或 `30m`、`3h`。工具自身全部在 M1 运行，执行权限仍取决于原任务授权。

## 终态核验和重连

CI 使用上面直接传入的 `gh run watch RUN --repo OWNER/REPO --exit-status`，固定 run ID 和仓库；默认自动加 `--interval 60`；可显式加大间隔，低于 30 秒会在启动前拒绝；保留 `--compact`。不要包在 shell 中，也不要省略 run ID 或仓库。每次 watch 退出（包括退出码 0），都用同一个 `gh` 的 `api --include repos/OWNER/REPO/actions/runs/RUN` 核对原 run。只有 `completed` 才报告 GitHub 的真实 conclusion；即使 watch 报 EOF，查询到 success 仍报告成功。取消、测试失败等终态不重连。

EOF、5xx、超时等导致 watch／查询不能确认终态时，按 5、15、30、60 秒退避，最多重新挂接原 run 4 次；绝不执行 `gh run rerun`。重连和查询共用最初的总时限，不重新计时。重试耗尽或总时限到达，只发“等待失败，CI 状态未知”，不能据此认定 CI 红灯。原始 watch 输出和每次 `ci-state-N.http`（响应头及正文）、`ci-state-N.json` 都保留。

403/429 的限流与 EOF 分开：依据响应的 `Retry-After`，或额度为 0 时的 `x-ratelimit-reset` 等到允许重试；两者都有则取较晚时间。缺少有效响应头的限流至少等 60 秒，重复时指数退避、最多每小时一次。冷却期间不请求 GitHub，继续写心跳，不消耗上述 4 次 EOF 重连；始终受原总等待时限约束，超时只报状态未知。普通 403 权限不足不当作额度限流。只重连同一个 run，不换身份或重跑 CI。规则依据 [GitHub 官方限流说明](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)。

## 启动并等待完整 M5

完整 M5 常用 2–3 小时，建议显式设 **`--timeout 6h`**，给排队、依赖安装、构建和收尾留余量。默认仍为 3 小时；`--timeout` 没有额外的 3 小时上限，6 小时就是 21600 秒。等待从命令启动时开始计算，包含整个 m5-test 流程；实例／名额仍按既有租约要求管理，不因等待参数延长而续租。

```bash
~/allrice-dev/bin/wake-when \
  --thread "$CODEX_THREAD_ID" --label 'MET-xxx 完整 M5 固定SHA' --timeout 6h -- \
  ~/allrice-dev/bin/m5-test <固定SHA> --wait 0 --db --browser \
  --build '<本轮已授权的完整构建与测试命令>' -- --help
```

将示例占位符换成原批次参数；`--build` 内真实的 CI 调用保留对应步骤的 `--maxWorkers=1 --testTimeout=30000` 及开关，不改断言、重试和时限。新批启动前照常检查 M5 负载和名额。直接把 m5-test 作为被等待命令，不再另外启动同一批次，也不包一层 shell。收到 started 就结束回合，m5-test 的启动和完整等待均在后台进行。

工具只执行一次 m5-test。它退出后，wake-when 从输出中的 `finished on M5/M1, exit N; log ...` 找到本次结果日志，再读取该文件核对最终收尾行；文件须绑定本次 m5-test 的 PID、日志目录和启动时间。中途 `done on`、旧任务日志或单独进程退出码都不能替代终态。叫醒消息写真实执行机器、最终 exit code 和结果文件路径，`result.json` 的 `task` 同样留存。M5 中途掉线按原工具规则回到 M1 时，回执明确写 M1；wake-when 自身不另重跑。没有可靠收尾行就报任务状态未知。

## 其他外部等待的终态文件

部署等命令可能会启动实际工作，所以只执行一次，**不自动重跑**。已有阻塞命令正常退出 0 可以报告命令成功；异常退出不能证明远端任务结束。需要确认远端结论时，用 `--terminal-file /绝对路径/本次任务.json --terminal-id 本次任务ID`，由已有任务的负责人在确认任务结束后原子写入：

```json
{ "id": "本次任务ID", "status": "completed", "exitCode": 0 }
```

直接包住 `~/allrice-dev/bin/deploy-dev <原授权参数>` 时，wake-when 自动设置专用文件及 ID。deploy-dev 在实际退出清理之后写 completed，覆盖参数/权限拒绝、构建失败、回滚收尾、冒烟失败和正常完成；清理函数返回非零或收到中断也写终态，`initialExitCode` 保留进入清理前的退出码，`exitCode` 是最终实际退出码；SIGKILL/断电会留下 running，不能误报完成。部署工具单独使用时，也在 `qa/deploy-results/<UUID>.json` 留终态。`--status`/帮助只读，不生成部署终态；不要把它们当成部署调用。此接入不改变发布负责人和部署授权门禁。其他工具仍用上面的可选合同，不能把 SSH／等待命令退出码直接包装成终态文件。文件必须是启动等待时尚不存在的本次专用路径，ID、终态、整数退出码都要匹配；命令退出后按上述退避读取，仍无终态就报“等待失败，任务状态未知”。未提供终态文件的普通命令异常退出时，直接报告等待失败和原退出码，任务结论保持未知。需要 shell 组合语法时显式传 `bash -lc '...'`，工具不解释 shell；CI／M5 仍必须用各自直接命令形式，不能用外部 JSON 覆盖原生核验。

命令必须在前台阻塞直到工作完成，不要在命令里自行 `nohup`、`setsid` 或启动常驻服务。超时退出码为 124；结束时会清理该命令进程组，包括仍运行的子进程。TERM 后留 10 秒清理宽限，覆盖现有 `m5-test relay()` 对其独立子进程组的 5 秒清理流程，再对残留进程组发 KILL；因此回执可比命令时限稍晚。不要传入读取凭据、打印敏感内容的命令：命令输出会进入本机日志，失败尾部会发到本线。

## 白名单与升级

工具只读 `~/allrice-dev/wake-when.threads`，每行 `线名 UUID`，恰好 7 条且 UUID 不重复。首次安装从仓库模板初始化，以后安装保留现有文件。哪条线更换会话，只改这一个文件中对应的 UUID；不需要改工具、重建或重启。名单是通知接收方限制，不是凭据。

同一 label 在 7 条线之间全局去重：等待尚未结束时再次启动会报错，不启动第二个命令。不同任务请使用不同 label；旧等待结束并通知后可复用原 label。

## 日志、失败与资源

启动回执给出后台 PID、日志与结果路径。文件均在 `~/allrice-dev/qa/wake-when/<时间-随机ID>/`，目录 700、文件 600。`command.log` 是命令原始输出，`notification.log` 是 queue 回执，`result.json` 中 `task` 是已核实结论或 `unknown`，`commandExitCode` 是等待命令退出码；还记录核验次数、超时与通知结果。记录工作目录、固定 CI 仓库/run 或终态文件路径，不另存完整 argv 或读取凭据。

`notification=sent` 只说明 queue 已接收，不等于本线已执行后续。queue 每次最多30秒；失败按1/2/4秒退避再试，累计最多4次，不重跑原命令。delivery.json 记录投递过程；线程不存在/归档/不在白名单立即升级TG，其他失败耗尽后升级TG。TG失败有持久化退避，交看门狗续送。正常结束／超时／TERM 会退出后台进程并删除任务锁。M1 重启或 supervisor 被 SIGKILL 时不自动恢复任务；看门狗启动补扫并通知核对，清理内核已解锁的任务锁。日志作为证据保留，不占实例名额。

安装只使用已提交版本的 `scripts/m1/install`，切换版本化共享 bin，不直接修改已安装工具；wake-when 本身不装 launchd；下面的 m1-dog 需已有安装授权，不改网络设置。测试使用临时 HOME 和假 queue，不给真实会话发消息。

## M1-dog 看门狗

维护人：**打野线**。源码 `scripts/m1/m1-dog`、共享 `wake_runtime.py`；仓库 Skill `.agents/skills/m1-dog/SKILL.md`。不涉及 DSH 原生能力，无 SaaS 自补项。纯本机脚本，每 10 分钟一轮，绝不调用模型或自动重跑 CI/M5/部署。

`m1-dog launchd install` 安装用户 LaunchAgent `ai.bplabs.allrice-m1-dog`，RunAtLoad/KeepAlive，崩溃由 launchd 拉起（60秒节流）。开机后用户登录时启动，不安装 root LaunchDaemon。安装先把原 plist/launchctl 状态存到 `qa/wake-when/dog/launchd-backups/<UTC>/`，验证新 plist；停旧 dog 时轮询 launchctl 和旧 PID，最长30秒，再启新版本。安装失败恢复原 plist/加载状态。只操作自己的 label。

```bash
~/allrice-dev/bin/m1-dog status
launchctl print gui/$(id -u)/ai.bplabs.allrice-m1-dog
# 已获维护授权后，升级/重装（不停止任何 CI/M5/部署）：
~/allrice-dev/bin/m1-dog launchd install
```

心跳 `dog/heartbeat.json` 有 startedAt/completedAt；`dog.log` 为每轮日志，`dog/state.json` 为活动等待/叫醒计数/告警数。每个 supervisor 在阻塞命令期间最多30秒更新 heartbeat，记录本次开机身份和进程启动时间，防止 PID 重用。心跳停更超过3分钟或超过任务总时限+5分钟收尾宽限，下一轮发“等待中断，请自行核对”；不据此杀任务。旧#885等待没有心跳，兼容其进程/截止时间直到自然收尾。

通知投递共用 delivery.json 和内核互斥，防 dog 与 supervisor 同时发送。持久化前后发生进程崩溃/queue超时可能无法确认是否已接收，因此只能提供至少一次尝试，不能承诺严格恰好一次。收到重复回执先核对任务，不重复执行。`delivery.lock` 是保留 inode 的公共互斥文件，空闲无持锁进程，不占名额；不要删它。任务 label 锁仍由原工具释放。

TG 复用已安装 monitor 的 send_telegram，不新增机器人或复制凭据；整个调用最多50秒，日志不输出发送异常 URL。失败记录 telegram.json 并在以后巡检退避续送（最长每小时一次）；白名单错误立即TG，不能静默丢弃。若整个M1离线，需现有外部看护兜底，本机工具无法自己告警。

空等检测只读七个白名单线程的 rollout 尾部（最多2MiB），只识别 `event_msg.task_complete.last_agent_message`，新 task_started/turn_aborted/用户消息会取消旧判断。不读取 auth/配置数据库或其他线程正文。已结束回合提到等待CI/M5/部署、超过30分钟且无活动等待/后续已送终态时，每回合提醒一次。自然语言只是保守诊断提示，可能误报/漏报，绝不作为业务授权。Codex事件格式改变时先补夹具和核验，不猜字段。

UTC01:00后的第一轮发送每天一条平安报告（若当时关机，启动后补当天），包含当日成功/失败、当日 GitHub 限流次数、需人工核对和TG待送数。限流次数按 UTC 日汇总任务目录 `github-rate-limit-N.json`：每次进入冷却计一次（同次 watch/query 的错误合计一次），不等于账户全部请求的 403 数量；多任务不共享写计数器，重复巡检不重复计数。`dog/state.json.githubRateLimitCount` 显示当前日统计。路径 `dog/daily/YYYY-MM-DD/telegram.json`，sentAt只代表TG接收。对已核对的 `dog/alerts/<ID>` 用 `m1-dog ack <ID>` 关闭人工待办，原始证据保留。普通等待的 queue 告警也计入待办，`m1-dog status` 的 `pendingAlerts` 给出相对路径（任务目录或 `dog/alerts/<ID>`）；可直接 `m1-dog ack <该相对路径>`。TG 送达不等于人工处理，计数跨日保留；跨日平安报告的传输积压也继续按原退避续送。

回滚：先 `m1-dog launchd remove`，只移除本看门狗并备份；若恢复之前已安装的dog，把对应备份plist贴回原 `~/Library/LaunchAgents/ai.bplabs.allrice-m1-dog.plist`，用 `launchctl bootstrap gui/$(id -u) <该plist>` 重新加载。工具版本回滚由已授权维护者用旧提交的 `scripts/m1/install` 切回已保留的版本，不直接改共享bin。重新检查 launchctl、心跳、当日TG；没有旧dog时保持移除即可，wake-when既有任务不受影响。

MET-245 应登记：上述工具/Skill位置、10分钟心跳与launchctl检查、每日UTC01:00TG、告警按任务原终态核对、维护人打野、规划线看护仍是最后兜底。破坏测试使用隔离HOME/假queue/假TG，不杀真实任务；真实安装后用无模型短命令核验本线可收到回执。
