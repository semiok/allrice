# M1 处置手册 2：沙箱 VM 停了

对应告警：`sandbox_vm:<profile>`（沙箱 VM 未运行）、`office`（Office 渲染不可用）。总览见 [m1-monitor.md](m1-monitor.md)。

## 影响

云端执行全部依赖 colima VM `allrice-cloud-arm`：Office 导出、数据分析（Python）、云端浏览器、项目预览。VM 停了这些功能都会失败；普通聊天不受影响。VM 停着时监控不判断镜像和 Office 容器（它们保持原状，不会误报恢复）。

## 第一步

```bash
export PATH=/opt/homebrew/bin:$PATH
colima list
colima status -p allrice-cloud-arm
DOCKER_HOST=unix://$HOME/.colima/allrice-cloud-arm/docker.sock docker info --format '{{.ServerVersion}}'
colima ssh -p allrice-cloud-arm -- systemctl is-active allrice-cloud-watchdog docker
colima ssh -p allrice-cloud-arm -- sudo /usr/local/lib/allrice-cloud/watchdog.py --attest </dev/null   # 必须 "ready": true
```

**沙箱能不能用，以看门狗证明为准**：Worker 只认 `watchdog.py --attest` 的 `ready: true`（否则云端执行报 `CLOUD_WATCHDOG_UNAVAILABLE`），服务是 active 也可能证明不了（例如 VM 重启后 runsc 运行时丢了），这时 Worker 的就绪接口仍显示 ready。监控每轮都跑这个证明。#557 合并后也可以用 `~/allrice-dev/bin/cloud-autostart status`（不就绪时非零退出，并显示登录项上次的退出码）。

## 处理

1. **VM 没在运行**：`colima start -p allrice-cloud-arm`（沿用 `~/.colima/allrice-cloud-arm/colima.yaml` 里的 3 CPU / 4 GiB，不要加参数改配置）。启动约 1 分钟。`colima start` 会把 docker 命令行的默认 context 切到这个 VM，起完执行 `docker context use default` 切回（Worker 用显式 socket，不受影响）。内存紧张时（`memory_pressure`）先停自己不用的验收实例，**不要停别人的**。
2. **VM 在运行但 docker 无响应**：`colima ssh -p allrice-cloud-arm -- sudo systemctl restart docker`，再看 `docker info`。
3. **守护 `allrice-cloud-watchdog` 不是 active**：`colima ssh -p allrice-cloud-arm -- sudo systemctl restart allrice-cloud-watchdog`，再看 `journalctl -u allrice-cloud-watchdog -n 50`。守护负责到点停容器，没有它不能放行新的云端执行。
4. **证明不是 ready，但服务和 docker 都在**：多半是 VM 重启后 runsc 没了。#557 起 `daemon.json` 写进了 `~/.colima/allrice-cloud-arm/colima.yaml` 的 `docker:` 节，VM 重启后 runsc 会保留；之前的 VM 要按 #557 的说明补上并重启一次 VM。
5. VM 起不来（磁盘、vz 报错）：保留现场，派 Codex Sol 只读诊断（命令见 [m1-monitor.md](m1-monitor.md#诊断交给-codex)），把结论告诉用户。不要删 profile、不要 `colima delete`：VM 里有钉死的镜像，重建要重新构建镜像（见 [m1-missing-image.md](m1-missing-image.md)）。

## 自动拉起与登录

- #557 起有登录项 `ai.bplabs.allrice-cloud-autostart`：用户登录后拉起 VM，失败每分钟重试一次；看门狗服务也加了 `WantedBy=docker.service`，docker 起来它就起来。
- M1 开着 FileVault：**无人值守重启后，要有人到机器前登录**，登录项和所有 launchd 服务才会起来。这段时间 huihuimac 的看门会报 `m1_reachable` 或 `m1_heartbeat`。
- 在 `deploy-lock run` 里启动 colima 时，`limactl` 会继承部署锁的文件描述符，一直占着锁：要么在锁外启动，要么启动命令带 `9>&-` 关掉它。

## Office 渲染容器

```bash
export DOCKER_HOST=unix://$HOME/.colima/allrice-cloud-arm/docker.sock PATH=/opt/homebrew/bin:$PATH
docker ps -a --filter name=allrice-office-renderer
docker logs --tail 50 allrice-office-renderer
curl -s http://127.0.0.1:3112/health
```

容器的重启策略是 `unless-stopped`，VM 和 docker 恢复后会自己起来。容器被删了或一直不健康：`docker start allrice-office-renderer`；仍不行，记下 `docker inspect` 和日志，交给发布负责人重建（镜像 `allrice-office-renderer:arm64-v1`，`infra/docker/Dockerfile.office-renderer`）。

## 确认恢复

下一轮告警自动恢复后，跑相关冒烟：

```bash
~/allrice-dev/bin/smoke-test --dev --only office,csv,browser
```

## 谁来做

启动 VM、重启 VM 内的服务不改共享 Dev 的配置，值班的人可以做；之后如需重启 Worker，由发布负责人用 `deploy-lock run` 做。
