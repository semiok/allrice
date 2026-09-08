# P18：Skill 资源与冻结发布（MET-131）

本片复用现有 catalog、员工 revision/runtimePackage、租户发布与 Run native_skills。代码与隔离验收完成后仍须单独审核 PR；B4 批末合并/Dev 部署不属于本片验收。

## 版本与资源边界

- v1 旧 runtimePackage 不新增默认字段，不改变历史 checksum。带资源的包为 v2；bundle 有独立规范化 digest，
  覆盖正文 checksum、所有资源内容/路径/媒体类型、固定依赖、版本、来源、许可及审核标签。
- 首版为小型随包资产：每资源最多 128 KiB，32 个资源，解码后总量 512 KiB；以私有数据库快照保存。
  大文件和用户数据继续用 StoragePort，不将 SaaS 数据库/存储路径暴露给脚本。
- `skills/<name>/bundle.json` 明确列出 references/assets/scripts，按文件真实 bytes 校验，不做目录自动发现。
  拒绝路径逃逸、软硬链接/特殊文件、重复大小写路径、未知字段/依赖、同版本不同 bundle。
- 小资源以规范 base64 随冻结包保存；不可变版本表拒绝更新/删除。回退改发布指针，不改旧包。
- 仅声明经过验证的 Node 22.23.2 固定镜像依赖；不自动 npm install、不读取 Hooks、不执行宿主脚本。
  `workspace.skill.read` 只返回当前 Run 冻结资源；读取脚本不授予执行权限，实际执行继续经过 P15/本地 Runner。

## 发布与兼容修正

原代码 materialize 会从当前平台 Skill 表读取，可能把旧 revision 与新 Skill 混在一起。
新路径验证发布 revision 内 runtimePackage 的 checksum/治理/资源，再据该包物化租户；新 Run 从其员工版本包冻结，
不受可变 tenant Skill 行的覆盖影响。非 package 历史员工保留原读取路径。
DSH 进程 fingerprint 加入 bundle digest，防止正文不变但资源升级时误用旧实例。

发布证据绑定到本次编译的确切 `frozen_package_checksum`，不能仅凭相同 revision ID 的旧成功记录发布新资源。
没有精确 package hash 的旧试用记录保留为历史，不授予新发布权限。回退指向的已发布 revision 不允许重新编译；必须保存新草稿，再编译、试用和发布。
发布事务按员工 → revision 的一致顺序锁定，重验当前草稿、运行包、工作区、Provider 健康与成功试用记录。
行锁等待之后和提交之前按数据库墙钟复验时效，任何冲突整笔回滚租户版本、分配、发布指针和审计；Web 返回不可自动重试的 409 中文说明。

本 PR 不给 Skill 新增执行权限，不创建平行 SkillHub；权限/撤销独立于内容版本。依赖不可用必须显示/返回明确原因。

## 发布回退与服务回滚不是同一件事

员工回退只切换已审核版本指针，已开始的 Run 继续读取自己的冻结包，不改历史资源。
如果部署后已经发布 v2 runtimePackage 或创建对应 Run，不能直接回滚到不认识 v2 的旧服务二进制；
应保留本版 v1/v2 读取器，关闭新执行能力和新发布入口，再做向前修复。
只有核查没有新 v2 发布/Run（或完成单独审核的数据兼容恢复方案）时，才允许回退整个服务版本。
数据库迁移为扩展式；不要为了二进制回滚删除不可变版本或用户运行记录。

## 独立分片边界与验证范围

- 不添加 P19 Golden Skill。`skills/catalog.json` 保持原有 10 个 Skill；工具 manifest 为 28 项，只新增只读 `workspace.skill.read`。
- `skill-bundles.integration.test.ts`：真实 PostgreSQL 的已发布 revision fixture → 租户物化 → 资源版本升级 → 回退、旧 Run 资源不变、不可变版本/篡改拒绝；还实际同步合成 bundle，验证 JSONB 重排后的幂等、资源变化必须升版本和历史版本保留。该 fixture 本身不执行模型 preview，也不能代替发布门禁测试。
- `platform-skill-publication.integration.test.ts`：实际调用 compile、创建试用、完成试用、publish、保存新草稿、rollback 的数据库服务；11 个用例验证旧资源试用失效、无精确 hash 的历史记录拒绝、草稿/资源变化竞态、工作区/Provider/试用撤销、真实行锁等待与提交前过期的整笔回滚。仅模型回答是合成数据，不调用真实 Provider，也不声称浏览器按钮/真实模型端到端已覆盖。
- `platform-content/sync.integration.test.ts`：原 10 个 Skill 的真实同步兼容；反复同步使用规范 hash 比较 bundle，避免 PostgreSQL JSONB 键顺序造成假冲突。
- `platform-content/bundles.test.ts`：以独立合成目录测试真实文件 bytes 组装、完整性、路径边界与软硬链接拒绝，不依赖 P19 资产。打开前拒绝非普通文件，非阻塞打开后再检查 inode、设备、链接数和大小；真实私有 FIFO 测试确认不会阻塞（Windows 明确跳过 POSIX FIFO 用例）。macOS 系统 `/var` 别名只在根目录做 realpath；Skill 内链接仍拒绝。
- `p18-skill-resource.test.ts`：资源只读权限与冻结 allowlist、惰性脚本返回、未绑定 Skill/宿主路径/篡改拒绝。读取不授予执行权限，保留 P16 的两个 governed execution adapter。
- 原 v1 runtimePackage 的 JSONB 重排回读仍可校验，不注入新 bundle 字段；带资源快照 v2 与旧包分开测试。无 bundle 的 Worker 配置 checksum 保留 P16 字段顺序。
- 强化正文 checksum 后，旧 P08 合成 fixture 曾错误地 hash JSON 字符串引号；修正的是 fixture 的实际 bytes digest，不放宽生产校验。

可复跑：显式设置 `ALLRICE_RUN_DB_INTEGRATION=1` 与专用 `ALLRICE_TEST_DATABASE_URL` 后运行上述集成测试；不要使用仓库 `.env` 默认库。CI 使用 `127.0.0.1:54329` 的自有 PostgreSQL，不连接 Dev/Prod、真实租户或模型服务。Golden Skill 的业务算例、下载重开属于 P19，不以资源包单测替代。

2026-09-08 独立分片验收：frozen install、lint、format、typecheck、build 全通过；完整 `pnpm test --maxWorkers=4` 为 159 个文件、1213 项通过（17 个集成文件、308 项默认 gated 跳过）。另外显式启用专用 PostgreSQL 后，发布/冻结资源/同步/文件边界四套件 22 项通过；Bridge、Gemini 与 MCP 五套兼容测试 112 项通过、4 项单独 gated 跳过。共享源码中的 FIFO 修复亦单独跑过 5 项真实文件测试。首轮在与 tsc/eslint 高并发争用时两个既有 DSH 5 秒等待超时，限制 worker 数后两次完整回归均通过；没有扩大超时或放宽断言。
