# M1 处置手册 4：磁盘快满

对应告警：`disk:<路径>`（磁盘余量不足）。总览见 [m1-monitor.md](m1-monitor.md)。

## 影响

M1 只有一个数据卷，Postgres、发布目录、备份、colima 的 VM 磁盘都在上面。写满后数据库写入失败、构建失败、备份失败，服务可能起不来。初始阈值：剩余低于 100 GiB 警告（AGENTS.md 第 7 节的清理线），低于 30 GiB 严重。

## 第一步：看是谁占的

```bash
df -h ~
du -sh ~/allrice-dev-releases ~/allrice-worktrees ~/allrice-qa ~/allrice-backups ~/.colima ~/Library/Caches ~/Library/Logs 2>/dev/null | sort -h
du -sh ~/allrice-worktrees/* ~/allrice-dev-releases/* 2>/dev/null | sort -h | tail -15
```

## 处理（按安全程度从高到低）

1. **自己任务的临时验收实例**：`~/allrice-dev/bin/qa-instance down <任务>`。**不要停别人的实例**。
2. **已合并任务的 worktree**：确认没有 `.KEEP`、没有未提交改动、没有进程在用（`lsof +D <目录> | head`）后 `git -C ~/allrice-repo worktree remove <目录>`。只处理自己任务的；别人的写到 MET 卡上让对方处理。
3. **日志**：`~/Library/Logs/allrice-dev-*.log` 过大时截断（`: > 文件`），不要删除正在写的文件。
4. **旧发布目录**：只由 `deploy-dev` 清理（保留当前、上一个和最近 3 个），不要手删。
5. **colima VM 磁盘**：VM 内 `docker system df` 看占用，可以删已停止的临时容器；**不要 prune 镜像**（见 [m1-missing-image.md](m1-missing-image.md)）。

不要批量 `rm -rf ~/allrice-*`；删除任何目录前先看内容，并对照 plist 和 `.env` 里引用的路径（2026-10-25 曾误挪 `.local/bridge` 导致 Bridge 下载失效）。

## 确认恢复

```bash
df -h ~
~/allrice-dev/bin/monitor run --dry-run | grep disk
```

## 谁来做

清自己任务的东西：各任务会话自己做。共享 Dev 的发布目录、库和数据目录：发布负责人。真正不够用时告诉用户，由用户决定删什么。
