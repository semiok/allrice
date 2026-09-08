# P13 补测：真实审批、桌面暂停与停止回执

2026-09-08。本文补充 `p13-desktop-bridge.md` 的真实 PostgreSQL 联测缺口，不改变其 M5 Accessibility、Keychain、正式签名与发布门禁。没有部署 Dev / Prod，没有访问 M5 或真实租户配对、目录。

## 测试边界

- `packages/database/src/desktop-bridge.integration.test.ts` 使用独立随机 PostgreSQL schema、合成租户/用户/员工/Run/Bridge 身份、真实冻结配置、当前运行租约和精确审批。没有从其他 `.test.ts` 导入 fixture，也没有模拟数据库、审批服务、账本、Runner 或桌面控制器。
- 只接受本机 `allrice_b2` 测试数据库；`DATABASE_URL` 清空。只使用专用 `allrice-b2` VM socket 和固定工具链 image，不使用默认 Docker context。
- HTTP fixture 只装配生产 handler，并人工注入回执端点 `503`；认证查询真实测试数据库中的设备 token 哈希。所有 token 均为临时合成值。
- 实际启动已打包 Intel `0.4.0-dev.1` 的 `RiceBridgeCore desktop`，通过真实私有 JSONL 控制通道暂停/恢复。运行时只读取绑定的持久化 sandbox opt-in，没有给子进程注入 operation 功能环境变量。
- 这是 **真实 PG + 已打包 desktop core + VM** 联测，不冒充本次同时点击 AppKit 菜单；原生 UI 点击有独立验收。未连接真实 SaaS 服务。
- 清理只针对本次随机 schema、临时目录及带本次精确 attempt label 的容器；不扫描/停止日常 Bridge。

## 发现与最小修复

首次联测验证了审批前无容器、批准后任务真实运行、暂停后进程真实停止、SQLite Outbox 保留停止回执；但恢复时服务端返回 `409 RECEIPT_RECONCILIATION_REQUIRED`，数据库状态仍为 `running`、回执为 `conflict`。

原因：状态机要求 `running → cancel_requested → canceled`；账本原先只为后台服务的本机主动停止补充有针对性的取消意图。前台命令没有这个分支，导致真实停止事实无法入账，Outbox 持续阻塞。

修复仅在 `packages/database/src/runtime-ledger/ledger.ts` 的既有后台服务分支后增加前台 `local.process.execute` 分支：

1. 保留原租户范围、operation attempt、租约 token 和重复回执校验。
2. 只接受完整 `RuntimeLocalCommandResult`：真实停止字段、隔离副本、原目录未修改、固定 image、一致的 `canceled / lease_lost` 原因，且 effects 必须为 `none`。
3. 在同一个事务中先保存该 operation 的取消意图，再保存实际停止证据；不取消整个 Run，不授权执行或重试，不放宽通用状态机。
4. 重复提交同一个回执仍返回 `duplicate`，不重复产生状态事件。

未重构 frozen P13 Bridge / AppKit 实现；无需重打包客户端候选。后台服务原校验不变，账本其他分片的 lease recovery / cancelRoot 改动不属于本修复。

## 断言与结果

- 待审批时：Bridge 实际轮询，但没有创建测试容器；更改请求 digest 的审批被拒绝，跨租户查询被拒绝。
- 精确批准后：实际 VM 容器开始运行，`P13_GOVERNED_TASK_STARTED` stdout 写入 PostgreSQL，desktop 显示一个活跃前台任务。
- 暂停：只有实际容器停止后才返回 `paused`，活跃任务数为零；人为阻断回执时，本地 SQLite 中仍有 `operation.stopped`，没有删除 journal。
- 负例：不完整/伪造的停止结果、错误 image、不匹配停止原因、partial effects、错误租约和跨租户回执都被拒绝；在收到真实回执之前，账本仍为 `running`，不伪造已停止。
- 恢复：同一 journal 将停止回执投递入账并清空 Outbox，继续至少两次真实工作轮询，没有重新创建容器；数据库只有一次 start、一次 cancel_requested 和一次 stopped。
- 审计：冻结绑定中的租户/工作区、请求 owner、精确审批 digest 和响应 owner 均一致，原工作区输入文件字节不变，desktop 安全退出码为零。

验证结果：新增联测 **1 passed / 0 failed**；既有 `runtime-governed-bridge` 与 `runtime-ledger` PostgreSQL 回归 **115 passed / 0 failed / 2 skipped**。两条 skipped 是分别需要额外 Chrome gate 的 P07/P09-c 浏览器测试，不算通过。数据库 TypeScript 检查、这两个 TypeScript 文件的 ESLint/Prettier 通过。

本地原始报告保留于：

- `.local/p13-host-poc.CZB8en/governed-desktop-tests.json`
- `.local/p13-host-poc.CZB8en/governed-desktop-ledger-regression.json`

中途测试曾把错误租约写成非 UUID，触发结构校验而不是期望的租约校验；已改成另一个有效 UUID 并复测。未把首次失败删去当作始终通过。

## 重现

在仓库根运行（以下均为合成测试/公开工具链配置，不需要生产密钥）：

```sh
DATABASE_URL='' \
ALLRICE_TEST_DATABASE_URL='postgres://a123@127.0.0.1:5432/allrice_b2' \
ALLRICE_RUN_DB_INTEGRATION=1 \
ALLRICE_LOCAL_DOCKER_TEST_SOCKET='/Users/a123/.colima/allrice-b2/docker.sock' \
ALLRICE_LOCAL_DOCKER_TEST_IMAGE='sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5' \
ALLRICE_P13_TEST_CORE='/Users/a123/allrice-dev/.local/p13-host-poc.CZB8en/app-intel-handoff-0.4.0-dev.1/Rice Bridge.app/Contents/Resources/RiceBridgeCore' \
pnpm exec vitest run packages/database/src/desktop-bridge.integration.test.ts
```

不指定 `ALLRICE_P13_TEST_CORE` 时启动同一仓库的 TS 源码 `desktop` 入口，适用于源码回归；不能将源码运行记录称为候选二进制验证。专用 VM/image 未准备时测试必须显式跳过或失败，不回退到宿主裸执行。

本补测完成后，M5 真正的 Accessibility 菜单/表单点击、真实用户 Keychain 成功/迁移以及安装签名/公证/分发等仍按原文保留未覆盖，不能用本机 PG 结果代替。
