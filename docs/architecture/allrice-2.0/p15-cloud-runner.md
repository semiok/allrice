# P15：独立 SaaS 云执行后端（独立 PR）

2026-09-08，MET-129 / B4。独立分片基线为 b02d257；本文记录 P15 实现与真实隔离环境，不表示已合并、已部署 Dev/Prod 或已向现有租户授权。P16 MCP/统一云审批工作台、P18 Skill 资源包和 P19 对账均不包含在此 PR。

## 已实现范围与明确限制

P15 让同一个 Session/Run 在**没有 Bridge** 时，使用获准云端文件执行 Node.js 脚本，并交付不可变工件。DSH 仍是唯一 Agent Loop；新适配器在 Tool Broker 后执行一个已审批操作，不另建 Agent Loop。

目前的可用后端**只针对当前 Intel macOS SaaS 开发宿主**：固定 `allrice-cloud-b4` Colima/VZ Linux VM、固定 Unix Docker socket、固定 `/usr/local/bin/colima`、gVisor/runsc 与固定 amd64 Node 镜像。它不是 M5 本地沙箱，也不是宿主临时目录。Linux Prod、其他 Colima 路径、ARM 云宿主、远端 Docker、Kubernetes 尚未适配；不能宣称“任何云服务器开箱即用”。未知后端或版本失败即拒绝，不回落到 runc/宿主进程。

第一版仅 Node 22.23.2 的非交互脚本；无包安装、无任意出站、无 PTY、无个人浏览器 Cookie、无自动上传/搬迁本地文件。单次最多 60 秒；不是无限时后台任务平台。镜像里的程序仍受同一沙箱约束，但对外不提供任意 Shell 命令工具。新的 feature flag、云 grant、冻结工具和存储写权限都必须显式启用；迁移不自动授权现有租户。

## 路径与权威

| 层           | 文件                                                            | 责任                                                                                                      |
| ------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 严格契约     | `packages/contracts/src/runtime-v2/cloud-command.ts`            | 脚本、输入对象及 hash、输出路径/格式、预算；禁止模型选择 image/runtime/network/宿主路径                   |
| 精确授权     | `packages/database/src/cloud-authority.ts`、`runtime-policy.ts` | 当前租户/成员/冻结能力、目标、grant、审批、输入 hash、精确 job lease；Deny/Ask/Allow 中该动作始终需要 Ask |
| 数据         | `migrations/0082_cloud_executions.sql`、`cloud-execution.ts`    | 显式 grant；不可变云输入及输入传输授权；私有 attempt 恢复日志；版本化工件发布                             |
| 共享操作账本 | `runtime-ledger/ledger.ts`、`root-service.ts`                   | Local/Cloud/MCP 共用同一 Root 预算；事务内落下恢复 lease 后才能 dispatch；不重复执行、不以 unknown 当成功 |
| 后端与执行   | `apps/worker/src/cloud-runner/{backend,executor}.ts`            | 一次执行、续租、停止、恢复、输出界限和 Docker 物理停止证据                                                |
| 独立物理上限 | `cloud-runner/watchdog.py`、`allrice-cloud-watchdog.service`    | VM root 进程，沙箱不可见；即使 Worker 崩溃或租户暂停自己的父进程仍能终止超期容器                          |
| 入口         | `tool-broker/handlers/cloud.ts`                                 | 复用真实 Worker/Tool Broker 上下文；不相信浏览器或模型传入的执行身份                                      |

流程：冻结 Run → 明确云文件输入/脚本/输出/预算 → 精确审批 → 共享 ledger 原子 dispatch + 私有 lease journal → 从 StoragePort 复制获准 bytes → runsc → 真实停止/退出码 → 持久结果 journal → 重新核对授权并发布不可变版本 → ledger receipt/已测工具次数结算 → 删除已停止容器。StoragePort 写入后、事务提交前再次按数据库时钟核对有效性，避免写文件期间授权过期仍发布。

输入清单单独落库，不塞进 `bridge_payload`。基线 hash 与传输 scope 精确关联 storage object、目的 `cloud_execution`、当前操作及版本。输入经 stdin 进入沙箱，不写入 Docker env/argv。单文件和总输入最多 2 MB，最多 16 个；工件最多 8 个、总 bytes 最多 4 MB；日志最多 64 KiB。授权复制只是云端副本，不修改来源文件。

`job_id + worker_id + job_lease_token` 写入不可变输入行。即使同一 Worker 对同一 Run 领到新的租约，旧执行也无法 dispatch/heartbeat/publish。维护恢复按照原租约检查；旧操作成为 unknown 时不会取消替换后的新 job，也不会为它再开一个预算。

## 真实隔离配置与版本证据

- 宿主：当前 Intel Mac，x86_64，Darwin 24.6，8 CPU / 16 GiB；创建前约 62 GiB 可用空间。
- VM：`allrice-cloud-b4`，VZ/x86_64，2 CPU / 2 GiB / 10 GiB data disk + 10 GiB root disk；Ubuntu 24.04.4，Linux `6.8.0-117-generic`，cgroup v2，Docker `29.5.2`。
- 无 host mount（`mounts: null`，guest `findmnt -t virtiofs` 无项）、无 SSH agent 转发、无 LAN 地址、无 host address 转发、无 TCP port forwarder。`colima status` 的 `mountType: virtiofs` 是配置能力，不等于存在共享挂载。
- 专用 socket：`/Users/a123/.colima/allrice-cloud-b4/docker.sock`。未改默认 context（仍为 `colima`），未改已有 `allrice-b2`、M5、现有 Dev/Prod 服务。
- `runsc version release-20260831.0`，OCI spec `1.2.1`；完整官方 tarball 包含 sidecar，不只安装单个二进制。[官方安装说明](https://gvisor.dev/docs/user_guide/install/)
- Node：`22.23.2-bookworm-slim`；固定镜像 ID/index digest：`sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`。预检必须确认实际 image ID/OS/amd64，不接受浮动 tag 代替。

实际 SHA-256：

| 文件（`/usr/local/bin/`）            | SHA-256                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| `runsc`                              | `1a4995a70b3c8b7d36f55d7d2dc6d15185ebe420de653b1a330b42d36c0e6b4a` |
| `gvisor-bin/checkpointgofer`         | `205cc047fcbbec7de29fb41f2ef403a22aa0063332e3f4f13a566f4d56a95d84` |
| `gvisor-bin/gvisor-sentry-prewarmer` | `3315d7ad7c2d3751d349e4976fa02da1da6fd7e41746c35622304e5fabe4fce0` |
| `gvisor-bin/gvisor_sentry`           | `66f1e15d15424a87fc883df4597c5d0cfcd442ce3f82e208a69110f0949613c1` |
| `gvisor-bin/runsc-metric-server`     | `7e01c8637f2412aefe4a26eefc8e40f4e8184dc95be44b2b646f38ab3d260033` |

预检读取当前 VM root-owned watchdog attestation，核对上述所有文件、Docker runtime flags、服务 active 及小于 4 秒的新鲜 heartbeat。已实测返回 `ready: true`。任一缺失、变化或超时拒绝新执行。

容器为 UID/GID 65532，read-only root、`cap-drop ALL`、`no-new-privileges`、`network=none`，没有 bind mount/socket/凭证。默认 256 MiB，范围 128–512 MiB 且 swap 不额外扩容；0.1–1 CPU；PIDs=64（含 runtime threads）；32 MiB noexec/nosuid/nodev `/tmp`，8 MiB shm，nofile 128、禁 core、无 restart。数据库并发最多 2、grant 最多 1–2；独立 watchdog 同时限制存活数量和可信 deadline，异常标签也终止。

**seccomp 的准确含义**：此 Node/gVisor 组合启用 guest OCI seccomp 时遇到线程兼容失败，最终配置 `--directfs=false --oci-seccomp=false`。这关闭的是沙箱内 OCI guest filter，不是 `seccomp=unconfined`，不是关闭 Sentry 对宿主的系统调用过滤，更不是回落 runc。真实测试在 VM `/proc/<gvisor_sentry>/status` 读取 `Seccomp: 2`。后续换版本必须重复验证，不把当前兼容性豁免概括成“关闭所有 seccomp”。[gVisor seccomp 机制](https://gvisor.dev/blog/2024/02/01/seccomp/)

## 新宿主重建步骤（运维执行，不自动运行）

以下仅适用于**新建、专属、未承载任务**的同架构 VM。已有 VM 不应直接覆盖配置；先停止新 admission、排空/确认任务，并按单独变更处理。运行代码不会自行安装软件、启动 VM 或拉镜像。

1. 先确认 CPU/内存/磁盘空闲，明确当前 Dev Worker 用户与可执行路径；创建不激活默认 context 的专属 VM：

```sh
colima start allrice-cloud-b4 --activate=false --template=false --cpu 2 --memory 2 --disk 10 --root-disk 10 --arch x86_64 --vm-type vz --mount none --ssh-agent=false --network-address=false --network-host-addresses=false --port-forwarder none --binfmt=false --ssh-config=false
```

2. 进入 `colima ssh --profile allrice-cloud-b4`，在新 VM 安装下载/解压依赖，然后在 `mktemp -d` 创建的目录下载固定版本，核对官网随包 SHA-512 后解包；不要使用 latest、不要借用户数据目录：

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl bzip2
cloud_install_dir=$(mktemp -d)
cd "$cloud_install_dir"
curl --fail --location --remote-name https://storage.googleapis.com/gvisor/releases/release/20260831.0/x86_64/gvisor.tar.bz2
curl --fail --location --remote-name https://storage.googleapis.com/gvisor/releases/release/20260831.0/x86_64/gvisor.tar.bz2.sha512
sha512sum --check gvisor.tar.bz2.sha512
sudo tar -xjf gvisor.tar.bz2 -C /usr/local/bin
/usr/local/bin/runsc --version
```

本次归档 SHA-512 是 `c7b4f22c60be3ea5a0ace478ed390403255d818729aaccff82d5b60026f3060d2ea31ab6670249a34a98eef59726217018c91ec631f7d753459127d930658392`；安装后仍逐一比对上表的 binary hash。不要重新运行旧安装脚本自动获取缺失 sidecar。[固定 point release 规则](https://gvisor.dev/docs/user_guide/install/#point-release)

3. 回到宿主仓库根目录，将已审查配置复制到**该新 VM**。`daemon.json` 包含本次实际 Colima 默认特性加 runsc runtime；不是可覆盖任意现有 Docker 配置的通用模板。

```sh
colima ssh --profile allrice-cloud-b4 -- sudo install -m 644 /dev/stdin /etc/docker/daemon.json < apps/worker/src/cloud-runner/daemon.json
colima ssh --profile allrice-cloud-b4 -- sudo install -d -m 755 /usr/local/lib/allrice-cloud
colima ssh --profile allrice-cloud-b4 -- sudo install -m 755 /dev/stdin /usr/local/lib/allrice-cloud/watchdog.py < apps/worker/src/cloud-runner/watchdog.py
colima ssh --profile allrice-cloud-b4 -- sudo install -m 644 /dev/stdin /etc/systemd/system/allrice-cloud-watchdog.service < apps/worker/src/cloud-runner/allrice-cloud-watchdog.service
colima ssh --profile allrice-cloud-b4 -- sudo systemctl daemon-reload
colima ssh --profile allrice-cloud-b4 -- sudo systemctl restart docker
colima ssh --profile allrice-cloud-b4 -- sudo systemctl enable --now allrice-cloud-watchdog.service
docker --host unix:///Users/a123/.colima/allrice-cloud-b4/docker.sock pull node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
colima ssh --profile allrice-cloud-b4 -- sudo /usr/local/lib/allrice-cloud/watchdog.py --attest
```

本次镜像来自现有 B2 的**只读 image save** 再 load 到新 VM，同样验证固定 ID；未为导出镜像修改 B2。上面的公网 pull 是新安装替代步骤，执行后还必须通过 backend preflight 与整套隔离实测，不能以下载完成当验收。

4. 增量数据库迁移 0082、部署代码、启用 flags、授予特定租户 grant/冻结工具是四个独立步骤。`installCloudExecutionGrant` 要求当前管理员，目标与 owner 同租户；没有公开“模型自授予”入口。先合成身份/随机 schema 测试，再按批次门禁决定 Dev 灰度；本文不授权修改线上数据库。

## 预算、未知结果与故障恢复

- 默认 Root 工具调用 32 次；已经存在的 Root 使用原 deadline、容量、source，切换目标不扩额。每项配置预算都需要预留；已测工具次数按原 meter/accounting ID 结算。无法测得的成本/其他消耗不虚报零；unknown 保留预留。
- 运行前和期间检查当前权限及 job lease。取消是 intent，不等于物理停止；Docker stopped/exit 与清理验证是物理证据。整容器 kill 覆盖脱离父进程的子孙，不仅杀一个 shell。
- 私有 journal 和 dispatch 同一数据库事务；如果 journal 失败，lease、状态和审批消费一并回滚。工具响应丢失后只能恢复原 attempt；不得因为容器不见就重新执行。
- StoragePort 出错时保留 stopped container、daemon logs 与 journal，恢复时发布原结果，不重算。真正持久化工件后才删容器。事务回滚后的未登记 bytes 位于确定性 key，保留以供安全恢复，不盲删未知写入结果。
- 冷恢复原租约失效、Root 取消或 deadline 到达的 attempt：停止仍存活的容器，保留结果 journal，标记 unknown/停止证据并清理。失去原授权的结果不自动变成可下载成功工件。
- VM/daemon/watchdog不可达时拒绝新运行；无法确认物理状态的操作维持 unknown，不释放预算或假称已停止。VM 本身故障时守护无法提供秒级停止承诺；恢复后必须对账。未实现持久磁盘故障、灾备/跨宿主故障转移和完整告警系统。

## 独立分片的验证与发布边界

本片只新增 `cloud.process.execute` envelope 工具：manifest 26 项、原生 DSH 22 项、Broker 原生 21 项。它仅在云开关和 Runtime Policy 开关开启、冻结工具 allowlist 精确包含该工具且具备 storage:write 时对原生 Agent Loop 可见。可见不等于批准；不走旧关键词副作用路由，每次调用仍须精确审批。其他未选中的副作用工具和只读预览不因此获得执行权限。

P15 复用现有 P04 审批与共享账本；统一云/MCP 审批工作台留在后续 P16。此片不复制其 cloud-operation-view/API/UI，也不复制 Skill 包、MCP 连接或对账工具。默认关闭的功能在 B4 整批界面与业务链验收前不应向真实租户开启。

以下命令在独立工作树运行：专用 `allrice_b2` 测试库、每个 suite 随机 schema、仅合成输入，无租户目录/密钥；真实 VM suite 串行运行。

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
ALLRICE_RUN_DB_INTEGRATION=1 ALLRICE_RUN_CLOUD_INTEGRATION=1 ALLRICE_TEST_DATABASE_URL=postgres://a123@127.0.0.1:5432/allrice_b2 pnpm exec vitest run apps/worker/src/cloud-runner/backend.test.ts packages/database/src/cloud-execution.integration.test.ts --maxWorkers=1 --reporter=verbose
ALLRICE_RUN_DB_INTEGRATION=1 ALLRICE_TEST_DATABASE_URL=postgres://a123@127.0.0.1:5432/allrice_b2 pnpm exec vitest run packages/database/src/runtime-ledger/ledger.integration.test.ts packages/database/src/runtime-ledger/bridge-http.integration.test.ts packages/database/src/runtime-policy.integration.test.ts packages/database/src/runtime-governed-bridge.integration.test.ts --maxWorkers=1
```

独立分片验证结果（2026-09-08，实际在 `/Users/a123/allrice-b4-p15-check` 执行）：

- 全仓 `pnpm lint`、`pnpm typecheck`、`pnpm build` 全部通过，包括 Next.js production build；`pnpm install --frozen-lockfile` 未改变 lockfile。
- Tool Broker / P15 visibility / manifest / runtime-contract：6 files、39/39 通过（10.42 秒）。
- 本片真实云执行：2 files、26/26 通过（17:44，60.32 秒）；15 backend + 11 cloud PG。
- 共享 ledger、P04、HTTP Bridge、完整既有 Bridge 治理：4 files、170 通过、4 个未开启的 UI/VM 项跳过（47.94 秒）。
- `git diff --check` 通过；没有 P16/P18/P19 生产文件，也未把 storage 的生成 JS/d.ts 留在源目录。

这些是本片自身的结果，不引用 B4 集成工作树的 P19/界面测试作为此 PR 已包含的功能。

真实后端验收覆盖：runsc/cgroups、非 root/只读/无宿主挂载/禁网、整树取消、租约撤销、输出/超时、软链接和超量工件拒绝、500 KB stdin 输入、tmpfs ENOSPC、进程/内存耗尽后下一个沙箱可用、CPU throttling；Worker SIGKILL + guest PID 1 SIGSTOP 后独立守护仍终止，Sentry Seccomp:2。当前分片已重跑全部 15 个后端测试。

P15 数据库 11 项覆盖：不可变精确审批、跨租户/输入 hash/撤销、plan-only/冻结工具、共享预算竞争、同 Worker 的旧 job lease 拒绝、冷恢复不取消替换 job、真实工件销毁后读取/回放、授权撤销后不发布、存储失败恢复不重算、已开始但无容器证据只返回 unknown。另增加 visibility、共享 Root 不扩额和原子 lease journal 失败回滚回归。

首次 PoC 发现并修正：完整 runsc sidecar 不可缺失；guest OCI seccomp 与此 Node 的线程兼容；PIDs 32 太低（最终 64）；500 KB 输入不能放 argv/env；只依赖 guest timer 无法抵抗 SIGSTOP（增加 VM 守护）。资源耗尽可能使整沙箱非零退出，不保证都产生友好的 EAGAIN/OOMKilled；验收以真实停止、限额证据及后续沙箱可用为准。

尚未包含：P16/P18/P19 下游业务与 UI、实际 Dev 部署/租户启用、第三方客户数据、M5/ARM 云后端、Linux Prod、任意网络/包安装、长任务、灾备与跨宿主恢复。
