# P09-a：受控项目环境诊断

子工单 MET-122，B3 第一个独立切片；执行总表为排期权威。复用 P05 命令、精确审批、设备 journal 和 PostgreSQL 证据，不新增 Agent Loop。

## 已实施范围

`local.process.execute` 可携带 `diagnostics: {kind: "node_project", expectedNodeMajor?: 22, expectedNpmMajor?: 10}`，此时只允许固定 Node 路径和空 args。先用现有文件读取取得明确文件的 SHA，再提交准确清单。Bridge 在已授权文件的隔离副本中运行固定探针，不加载项目 JS、不执行 package scripts、不调用主机 PATH 程序。固定镜像的 Node/npm 版本、Linux 架构、实际工作目录、清单/锁文件、包管理器和依赖准备状态形成结构化报告；页面中文呈现，刷新后由原回执恢复。

可选 expected major 是明确比较，不冒充完整 semver 求解。项目 engines 表达式只保留有限安全字符，并标记需审查；复杂版本范围不会被声称已满足。当前依赖未带入新隔离副本，不能以本机存在 node_modules 推断隔离环境可用。主机工具链标记未检查，不上传全局环境或主机绝对目录。未提供、无效清单和多个锁文件分别说明，探测不修复或联网。只覆盖 Node/npm；识别到 pnpm/yarn 声明不代表已安装或能执行。

## 治理、兼容与风险

- 诊断仍经过 P05 精确操作批准，绑定完整参数/文件哈希/镜像/工作区/期限；批准不是后续安装授权。
- 新 profile `project_diagnostics` 特征与领取能力双重协商。创建、派发、执行前重查 profile；不把新载荷投给旧 P05 客户端。旧 profile、命令与 HTTP 路径仍兼容。
- 文件读取继续拒绝敏感路径、软/硬链接、越界、检查后替换和过大输入。镜像不可换成 PATH 中的相似程序，既有 VM/cgroup/网络隔离不放宽。
- 结构化结果只是当时、指定输入、指定执行副本的诊断，不是主机扫描、软件签名或远端可信证明。输出缺失/截断/失败不伪造报告。
- 实测发现 P05 多输入 staging 的目录属主移交过早；修为全部文件准备后统一移交目录。PID 1 继续不拥有 DAC_OVERRIDE，不通过扩大权限修问题。

## 验证

`apps/rice-bridge/src/project-diagnostics.test.ts`：参数限制、未知能力、文件变化、缺失证据；显式 VM 下验证真实版本/依赖缺失、版本不符、主机 PATH/NODE_OPTIONS 污染不影响探针、清单缺失/无效、多锁文件、无脚本副作用、敏感属性不回传及 journal recovery 所需结果重建。

`packages/database/src/runtime-governed-bridge.integration.test.ts`：真实 PG 的旧 profile/旧客户端拒绝、新特征撤销、批准前不可领取、同 call 参数变化冲突；既有 Chrome→批准→HTTP→VM→回执测试增加诊断与移动窄屏/刷新持久结果验证。继续运行 P05 VM 回归与全仓门禁。

无 schema migration，无新的默认执行权限。Dev 发布留 B3 批末，M 实测及正式下载包仍按后续门禁；本切片不是菜单栏、安装器、后台服务或通用本机 CLI 的完成声明。

2026-09-08 本地自审/实测：24 项诊断/输入专项通过（包含 6 个真实 VM 场景）；真实 PG/Chrome/VM 联测 88 通过、1 个未启用的完整工作台环境项跳过；全仓常规 1011 通过、178 环境项跳过。format/typecheck/lint/build 通过。专用 VM `allrice-b2`、隔离 PG schema（数据库 allrice_b2）、合成浏览器身份；未触碰现有 Dev 用户文件、配对或消息。M、真实模型推理、正式签名包未测。PR/CI 与批末 Dev 证据在工单和执行总表继续登记。
