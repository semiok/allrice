# P19：无 Bridge 对账交付（MET-132）

已实现、完成隔离链路测试；B4 的 PR 合并和 Dev 部署另记。本能力不要求 Bridge，不自动读取本地文件，也不把模型的文字算术当作核对依据。

## 交付边界

`skills/business-reconciliation` 是固定版本、经过 checksum 校验的 Skill Bundle。两份 CSV 必须由用户明确上传和选定；规则不明确时先澄清。通过 `workspace.skill.read` 取得当前 Run 冻结的脚本，再经 `cloud.process.execute` 的精确审批，在 P15 的无网络 gVisor 沙箱内运行。容器只收到授权文件副本和已审查脚本。

执行时优先提交 `frozenScript: { skill, path }`：服务端只从当前 Run 的冻结资源还原原始脚本，模型不必逐字搬运代码。它与旧 `script` 输入严格二选一，最终仍将完整原字节纳入原有精确审批；不忽略 BOM、末尾换行或 hash 差异，也不能引用其他会话、版本或宿主路径。

确定性计算以整数分处理金额，拒绝畸形 CSV、无效金额、超限和 unsafe integer；重复编号标记歧义，不自动合并成成功。输出 JSON/CSV 是可追溯、不可变的云端工具结果。`workspace.reconciliation.export` 仅接受当前 Run 已确认的 JSON 工件，再使用现有 ExcelJS 生成三张工作表：核对摘要、发票明细、待人工核查。不解析任意公式，不接受模型自填的汇总数据冒充沙箱输出。

脚本放在资源包中不等于执行授权。现有租户不会因 catalog 新增该 Skill 而自动获得它、Cloud Runner 或文件权限。

## 权威关系与重试

- 下载沿用 StoragePort、DeliverableVersion 和工件工作台，不另建成果数据库。生成文件保留源 object ID/checksum、原 operation 和云端 execution scope。
- 发布要求精确的 `workspace.reconciliation.export` 冻结授权，不错误地要求用户额外授予通用 export 权限。
- 始终重查当前用户/工作区/Run/job/worker 与原 job lease；相同 Worker 取得新租约不能继续旧执行结果的授权发布。
- 同一调用的幂等依据是来源工件与渲染器身份，不是含 ZIP 时间戳的 XLSX 字节；重试返回原版本。新版本必须显式关联旧 object。
- DB 审计/存储/锁等待之后再按数据库时钟检查 deadline；超期拒绝新增版本，不让最后一次异步等待跨过授权期限。既有版本仍可在原权限下读取。

## 固定算例

两份资产各 6 行。独立参考断言为：发票总额 36049 分，有效付款 34550 分，分配付款 34050 分，未分配 500 分，差额 1999 分；5 个核对对象、3 条需人工核查的问题。重复发票、超付、少付与无对应发票的付款分别呈现，不统一标成功。

## 已完成的测试

- 脚本 10 项单测、工作簿 3 项单测，覆盖格式边界、金额、重复/异常、公式注入与实际 XLSX 重开。
- 冻结脚本解析 15 项真实 PG 权威与失败路径测试，覆盖范围隔离、read/execute 权限、资源及运行时 hash、UTF-8/BOM/末尾换行；原生 DSH JSON-RPC 参数与注册一致性另有独立回归。
- `reconciliation-cloud.integration.test.ts`：真实 PostgreSQL + gVisor + 真实工具 handler + StoragePort + ExcelJS 重开，3 项通过。包括无通用 export 授权的成功交付、幂等/新版本/越权、旧 job lease 拒绝、审计等待跨 deadline 的完整回滚。
- `scripts/acceptance/runtime/b4-cloud-workbench.ts`：独立 Chrome 与私有 Next 服务、随机 PG schema、合成身份，实际刷新审批/HTTP 重试 → runsc → 容器销毁 → XLSX 下载重开；同工作区其他用户的读取/审批/下载拒绝，拒绝后不执行，窄屏抽屉与已关闭 flag 的历史读取。最终截图复核与断言确认“目标：云端沙箱”，没有冒称本地 Bridge；pageerror/5xx 均为 0。
- 同一脚本还验证真实签名租户 Portal 的 MCP 管理边界；未使用个人浏览器、真实租户配对或用户文件。

上述脚本直接驱动合成 Worker 上下文，**不等于真实 DSH/模型的完整对话端到端验收**。真实模型行为、正式租户启用与批末 Dev 验收必须独立记录，不能把本节结果扩大为已发布/GA。

真实模型的逐次结果、失败修正和最终集成版本复验记录见 `p19-dsh-model-acceptance.md`。不会把离线链接重放或直接 handler 测试冒充整场模型对话。

## 回退

先关闭 Cloud Runner admission；历史工件继续读取。先排空/对账再停止专属沙箱，不重放 unknown。代码回退不删除 0082～0086 的增量表/历史版本；若已有 v2 冻结包，保留兼容读端，不能退到只识别 v1 的旧二进制。Skill 回退通过既有发布版本指针，只影响后续新 Run，不改运行中冻结资源。
