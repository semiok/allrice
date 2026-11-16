# 后台等待与本线唤醒

仓库 Skill 在 [`.agents/skills/wait-and-wake/SKILL.md`](../../.agents/skills/wait-and-wake/SKILL.md)，在任务 worktree 中可用 `$wait-and-wake`。从仓库外启动的旧会话需显式读取这份文件；不安装到 `~/.codex/skills`，不修改 Codex 配置。

在 M1 运行，等待过程中不占 Codex 回合，也不依赖 M5。工具通过 `~/.local/bin/codex queue` 给指定本线发一次回执，区分任务真实结论与等待命令退出码；等待失败／任务失败附最后 30 行诊断日志（长行截断）。回执不是新增业务、合并或部署授权。

```bash
~/allrice-dev/bin/wake-when \
  --thread <本线会话UUID> --label '#884 CI' --timeout 3h -- \
  /opt/homebrew/bin/gh run watch <run-id> --repo semiok/allrice --exit-status
```

启动成功后立刻结束本回合；收到回执再继续，不让模型轮询、sleep 或发等待进度。默认最多等待 3 小时，`--timeout` 可写秒数或 `30m`、`3h`。工具自身全部在 M1 运行，执行权限仍取决于原任务授权。

## 终态核验和重连

CI 使用上面直接传入的 `gh run watch RUN --repo OWNER/REPO --exit-status`，固定 run ID 和仓库；可加 `--interval`／`--compact`。不要包在 shell 中，也不要省略 run ID 或仓库。每次 watch 退出（包括退出码 0），都用同一个 `gh` 的 `run view --json databaseId,status,conclusion` 核对原 run。只有 `completed` 才报告 GitHub 的真实 conclusion；即使 watch 报 EOF，查询到 success 仍报告成功。取消、测试失败等终态不重连。

EOF、5xx、超时等导致 watch／查询不能确认终态时，按 5、15、30、60 秒退避，最多重新挂接原 run 4 次；绝不执行 `gh run rerun`。重连和查询共用最初的总时限，不重新计时。重试耗尽或总时限到达，只发“等待失败，CI 状态未知”，不能据此认定 CI 红灯。原始 watch 输出和每次 `ci-state-N.json` 都保留。

M5／部署命令可能会启动实际工作，所以只执行一次，**不自动重跑**。已有阻塞命令正常退出 0 可以报告命令成功；异常退出不能证明远端任务结束。需要确认远端结论时，用 `--terminal-file /绝对路径/本次任务.json --terminal-id 本次任务ID`，由已有任务的负责人在确认任务结束后原子写入：

```json
{ "id": "本次任务ID", "status": "completed", "exitCode": 0 }
```

这是可选接入合同，现有 `m5-test`／`deploy-dev` **尚不生成这种 JSON**，不能假装已有；也不能把 SSH／等待命令的退出码直接包装成终态文件。文件必须是启动等待时尚不存在的本次专用路径，ID、终态、整数退出码都要匹配；命令退出后按上述退避读取，仍无终态就报“等待失败，任务状态未知”。未提供终态文件的普通命令异常退出时，直接报告等待失败和原退出码，任务结论保持未知。需要 shell 组合语法时显式传 `bash -lc '...'`，工具不解释 shell；CI 仍必须用直接 watch 形式。

命令必须在前台阻塞直到工作完成，不要在命令里自行 `nohup`、`setsid` 或启动常驻服务。超时退出码为 124；结束时会清理该命令进程组，包括仍运行的子进程。TERM 后留 10 秒清理宽限，覆盖现有 `m5-test relay()` 对其独立子进程组的 5 秒清理流程，再对残留进程组发 KILL；因此回执可比命令时限稍晚。不要传入读取凭据、打印敏感内容的命令：命令输出会进入本机日志，失败尾部会发到本线。

## 白名单与升级

工具只读 `~/allrice-dev/wake-when.threads`，每行 `线名 UUID`，恰好 7 条且 UUID 不重复。首次安装从仓库模板初始化，以后安装保留现有文件。哪条线更换会话，只改这一个文件中对应的 UUID；不需要改工具、重建或重启。名单是通知接收方限制，不是凭据。

同一 label 在 7 条线之间全局去重：等待尚未结束时再次启动会报错，不启动第二个命令。不同任务请使用不同 label；旧等待结束并通知后可复用原 label。

## 日志、失败与资源

启动回执给出后台 PID、日志与结果路径。文件均在 `~/allrice-dev/qa/wake-when/<时间-随机ID>/`，目录 700、文件 600。`command.log` 是命令原始输出，`notification.log` 是 queue 回执，`result.json` 中 `task` 是已核实结论或 `unknown`，`commandExitCode` 是等待命令退出码；还记录核验次数、超时与通知结果。记录工作目录、固定 CI 仓库/run 或终态文件路径，不另存完整 argv 或读取凭据。

`notification=sent` 只说明 queue 已接收，不等于本线已执行后续。通知发送失败或 30 秒超时会记 `notification=failed`，不重跑原命令；按结果文件手动补发回执。正常结束／超时／TERM 会退出后台进程并删除任务锁。M1 重启或 supervisor 被 SIGKILL 时不自动恢复、不补发通知；下一次启动清理已失效的锁，调用方根据原日志决定是否重新等待。日志作为证据保留，不占实例名额。

安装只使用已提交版本的 `scripts/m1/install`，切换版本化共享 bin，不直接修改已安装工具；本工具不安装 launchd、不改 macOS 或网络设置。测试使用临时 HOME 和假 queue，不给真实会话发消息。
