# Bridge 0.3.0-dev.1：Apple Silicon 补充适配

2026-09-08；B3 后的 Dev 增量，保留现有 Gemini 密钥格式修复，统一留到后续 PR。
本文补充 P05/P09 的历史 Intel 验收记录，不把旧记录改写成当时已支持 ARM。

## 本次交付边界

- 原生 macOS ARM SEA 客户端和本机 ARM Linux VM/container Runner；不是 macOS 宿主 Shell，也不是云端代跑。
- 客户端、设备 profile、Worker 目标选择、操作账本在派发/启动/续租时一致校验平台、架构和固定镜像。
- 容器创建显式指定原生平台，不使用 Rosetta 或跨架构回退。保留 Intel 兼容性和旧文件队列。
- `--version`、`sandbox status|enable|disable`；图形下载包提供对应 `.command` 入口。
- 本机设置默认关闭，私有文件绑定当前 server/device；不覆盖原配对、目录授权或模型凭证。启用必须先完成本地预检和服务端 profile 验证；失败不保存设置。
- 服务端关闭 operation 功能时，保留本地 journal/outbox，继续普通文件队列，不把命令改成文件操作重试。
- 下载入口不再因为 Bridge 已在线且选了工作区而消失。弹框不将下载版本误称为当前设备的安装版本。

本次不自动打开 Dev 的高权限功能开关、不修改租户策略/员工冻结权限，不替换用户正在使用的二进制。
安装沙箱、升级 Bridge、本机 opt-in、服务端开关、员工权限、目录授权、单次审批是不同条件。
菜单栏、自动更新、Apple Developer ID 签名/公证不在此 Dev 包范围；下载包为 ad-hoc 签名测试包。

## 固定工具链

`node:22.23.2-bookworm-slim` 的不可变 OCI **多架构索引**：
`sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`。
Docker containerd image store 在 Intel/ARM 上均将该索引报告为 image.Id，不能将其误称为仅 Intel 的 config digest。

- amd64 子 manifest：`sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96`
- arm64/v8 子 manifest：`sha256:8d342e46d3b2883df69f797cb60fc71d8a0b65de65ddfbf4bf63fdc02049615f`

准入必须同时匹配 device platform、Docker architecture、image architecture 与索引摘要。
当前仅支持已验证的 Docker image-store 表现；不接受任意 config digest 或不匹配镜像“兼容回退”。

ARM 包采用官方 Node 22.23.2 darwin-arm64，归档 SHA-256：
`61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6`。
打包固定 postject 1.0.0-alpha.6 和 pnpm lockfile 内的 esbuild；公共构建显式拒绝静态设备凭证。
每包附 release.json、二进制 SHA-256 和 ZIP 校验文件。

## 独立 M5 测试 VM

Colima 0.10.3 / Lima 2.2.0，profile `allrice-b2`，aarch64 / VZ，2 CPU、2 GiB 内存，
10 GiB 根盘和 10 GiB 数据盘。没有用户目录挂载、SSH agent、Rosetta、binfmt、LAN 地址或 TCP 转发；
不切换 Docker 默认 context、不配置登录自启动。Docker socket 仅走当前用户私有 Unix socket。

初次镜像的 `/etc/resolv.conf` 指向不存在的 systemd-resolved 文件，导致 dnsmasq 失败。
仅在该新建 VM 内保留原软链接为 `/etc/resolv.conf.allrice-original` 并安装显式 DNS 配置后恢复；
未更改 Mac 的 DNS/代理或日常网络。今后重建 VM 应先做同样的连通性检查，不能假定镜像无缺陷。
容器内依旧 NetworkMode=none；VM 镜像拉取网络不等于任务拥有网络出站权限。

安装采用 [Colima 官方命令](https://colima.run/docs/commands/)；
Node 包核对 [官方 SHA-256 清单](https://nodejs.org/download/release/v22.23.2/SHASUMS256.txt)。

## 验证与回退

M5 原生真实 VM 测试涵盖 40 项此前跳过的沙箱用例：结构化执行、输出/退出码、隔离、CPU/PID/内存硬限制、
setsid 子孙树取消、命令/Bridge 失联期限、依赖脚本权限、服务 readiness/stdin/取消/恢复、Changeset 工作副本。
真实 PostgreSQL 覆盖 ARM 单次审批、派发、启动、续租，以及架构改变、撤销和过期后的拒绝。

执行 `scripts/acceptance/runtime/bridge-distribution.mjs <已打包 RiceBridge>` 验证实际下载二进制，
使用合成 localhost 配对，不接触真实 Keychain/租户；覆盖版本、沙箱预检、拒绝时不保存、成功启用、
重启读取设置、服务端回退后继续旧队列、SIGTERM 和关闭设置。具体次数与下载哈希另存部署证据。

无需数据库迁移。Dev Web/Worker 从独立源码快照构建，保留所有原有环境覆盖与高权限开关。
回退先退出新 Bridge，恢复保留的旧二进制；不要删配对配置、journal 或执行证据。
服务器恢复旧 Dev release/plist，下载 ZIP 保留发布前备份；不得动 Prod。
