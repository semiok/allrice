# 后台等待与本线唤醒

仓库 Skill 在 [`.agents/skills/wait-and-wake/SKILL.md`](../../.agents/skills/wait-and-wake/SKILL.md)，在任务 worktree 中可用 `$wait-and-wake`。从仓库外启动的旧会话需显式读取这份文件；不安装到 `~/.codex/skills`，不修改 Codex 配置。

在 M1 运行，等待过程中不占 Codex 回合，也不依赖 M5。命令结束后，工具通过 `~/.local/bin/codex queue` 给指定本线发一次回执，包含成功／失败／超时、退出码、日志路径；失败附最后 30 行诊断日志（长行截断）。回执不是新增业务、合并或部署授权。

```bash
~/allrice-dev/bin/wake-when \
  --thread <本线会话UUID> --label '#884 CI' --timeout 3h -- \
  /opt/homebrew/bin/gh run watch <run-id> --repo semiok/allrice --exit-status
```

启动成功后立刻结束本回合；收到回执再继续，不让模型轮询、sleep 或发等待进度。默认最多等待 3 小时，`--timeout` 可写秒数或 `30m`、`3h`。也可包住已有的 M5／部署阻塞等待命令；工具自身全部在 M1 运行，执行权限仍取决于原任务授权。需要 shell 组合语法时显式传 `bash -lc '...'`；工具直接传递 argv，不自行解释 shell。

命令必须在前台阻塞直到工作完成，不要在命令里自行 `nohup`、`setsid` 或启动常驻服务。超时退出码为 124；结束时会清理该命令进程组，包括仍运行的子进程。TERM 后留 10 秒清理宽限，覆盖现有 `m5-test relay()` 对其独立子进程组的 5 秒清理流程，再对残留进程组发 KILL；因此回执可比命令时限稍晚。不要传入读取凭据、打印敏感内容的命令：命令输出会进入本机日志，失败尾部会发到本线。

## 白名单与升级

工具只读 `~/allrice-dev/wake-when.threads`，每行 `线名 UUID`，恰好 7 条且 UUID 不重复。首次安装从仓库模板初始化，以后安装保留现有文件。哪条线更换会话，只改这一个文件中对应的 UUID；不需要改工具、重建或重启。名单是通知接收方限制，不是凭据。

同一 label 在 7 条线之间全局去重：等待尚未结束时再次启动会报错，不启动第二个命令。不同任务请使用不同 label；旧等待结束并通知后可复用原 label。

## 日志、失败与资源

启动回执给出后台 PID、日志与结果路径。文件均在 `~/allrice-dev/qa/wake-when/<时间-随机ID>/`，目录 700、文件 600。`command.log` 是命令原始输出，`notification.log` 是 queue 回执，`result.json` 区分命令结果与通知结果。只记录命令工作目录，不另存 argv 或读取凭据。

`notification=sent` 只说明 queue 已接收，不等于本线已执行后续。通知发送失败或 30 秒超时会记 `notification=failed`，不重跑原命令；按结果文件手动补发回执。正常结束／超时／TERM 会退出后台进程并删除任务锁。M1 重启或 supervisor 被 SIGKILL 时不自动恢复、不补发通知；下一次启动清理已失效的锁，调用方根据原日志决定是否重新等待。日志作为证据保留，不占实例名额。

安装只使用已提交版本的 `scripts/m1/install`，切换版本化共享 bin，不直接修改已安装工具；本工具不安装 launchd、不改 macOS 或网络设置。测试使用临时 HOME 和假 queue，不给真实会话发消息。
