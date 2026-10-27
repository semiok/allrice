# P09-b：受控 npm 依赖准备

MET-123，B3 第二个独立 PR，堆叠 P09-a。复用 P05 受控命令和 P08 的输入版本审查边界；不是主机全局包管理器、任意网络出口或自动修复器。

## 工作链和首版限制

`local.process.execute.arguments.dependencies` 明确 npm / locked_ci、固定 registry.npmjs.org、包名/精确版本/SHA-512、是否允许安装生命周期脚本，以及可选已授权归档路径。清单和 npm v3 锁文件与所有传递包必须一致；支持最多 8 个不同包/版本、32 个锁节点，归档总计 128 KiB。项目 files 仍限 64 个、256 KiB。暂不支持 workspace、overrides、Git/目录链接源、私有 registry、代理、IPv6-only、自动扩大限制或全局安装。

流程：精确批准 → 输入 SHA 校验 → 核对锁文件/来源 → 准备归档 → 校验 SHA-512 → 本地隔离 VM 内 npm cache add → 离线 npm ci → 原请求的验证命令 → 真实退出/有界输出/持久回执。安装位置为本次临时隔离副本；既不把 node_modules 写回主机，也不暗示后续新操作能复用它。需再次验证时明确重新准备同一锁定依赖。安装和验证共享原时限、资源、取消和根预算，不通过额外 Run 重置预算。

已授权归档走明确文件清单与双重 SHA 检查，不访问网络；远程获取仅发送获批包的 canonical URL，并要求冻结的 `network:outbound` 能力。固定主机 HTTPS、IPv4 公网校验和地址 pin、无认证/代理/npmrc/重定向、无查询参数、下载限额与绝对期限。项目源码不会随下载请求上传。完整性哈希是内容校验，不证明发布者身份或包本身可信。实际安装及项目脚本始终无网络、最小环境/UID、只读基础镜像、cgroup 资源限额、PID 1 截止与全树停止。

安装脚本默认由调用者明确选择 disabled；允许必须在同一次具体批准里显示 `allow_in_isolated_copy`。即便允许，脚本也无主机写入/凭证/出站权限。安装失败不执行验证；输出使用 foreground-scripts 流式回传，避免等脚本退出才知道它在做什么。临时安装成功不等于原工作区安装成功，验证命令退出 0 也不等于未被要求的测试已经通过。

## 治理与失败

- 与诊断互斥，不能借诊断安装。参数/脚本策略/版本/源/文件变化使原审批失配；执行前重检 Worker、租约、授权与冻结能力。
- profile 和领取都要求 npm_dependencies；旧 Bridge 不领扩展载荷。任何缺权限、过期、撤销、拒绝都不会被安装器绕过。
- 密钥/配置文件仍不得进入输入；npm user/global 配置使用两个不同、空白、root-owned 的只读文件，避免主机配置注入，也避免 npm 对同一 /dev/null 双重加载报错。
- 下载来源、网络、内容限额、清单、锁定版本和完整性失败分别用中文解释；容器启动前的失败不谎报为命令已经运行。启动后的不确定结果继续走 unknown 和 journal 恢复，不能盲目重装。
- 自审补齐下载期间的授权窗口：准备前后重检、每秒非重叠续租，撤销/检查异常主动中止下载；取消不等待卡住的检查，所有退出路径清理定时器。`dependency-preparation-lease.test.ts` 覆盖这些失败路径。
- 多文件 staging 沿用 P09-a 的无新增 capability 修复；改变脚本行为必须重新批准，绝不使用事后审批冒充提前授权。

## 自审与验收入口

`dependency-preparation.test.ts` 使用自建 tar/npm 项目，真实 npm 安装并通过依赖算出 42；覆盖脚本禁用/显式允许、脚本越界失败、取消安装/验证和真正已运行的脚本及 detached 子进程。所有源文件不变、主机没有 node_modules；进程停止由容器实际状态核对。

`npm-registry-download.test.ts` 覆盖公网 IP pin、无凭证、混合私网 DNS、停止 DNS、3xx/错误状态不重定向、编码/大小限制。2026-09-08 本机代理 DNS 返回 198.18.0.153，被产品正确拒绝；另用测试专属 DNS seam 指向 Google Public DNS 当时核验的 104.16.5.34，**真正访问 npm 公网 HTTPS 并核对 is-number@7.0.0 官方 SHA-512**。这一实测包含真实证书/下载，但不伪称系统代理 DNS 路径可用；产品无跳过私网校验开关。测试地址不进入生产配置。

PG 集成覆盖出站能力/旧 profile/旧客户端/精确批准/脚本参数变化/拒绝。真实 Chrome→批准→HTTP→Bridge→npm→验证→PG→页面刷新和 390px 窄屏通过同一既有 P05 E2E，保留 ACK 丢失与 SIGKILL 回归。所有测试为合成租户/目录，不更改现有 Dev 数据。固定 SHA、CI、最终测试数量在工单及批次交付记录继续登记。

取消测试使用实际进程输出的完整就绪行作为取消触发，不依赖容器启动前的固定毫秒计时。2026-09-08 本机联合实测 108 passed / 1 skipped（该跳过项依赖独立全工作台门禁）；全仓 typecheck 和构建通过。新增租约测试另行纳入普通测试及最终批次回归，不用单次通过代替批末集成验收。

无迁移，无新增默认执行权限。正式下载包、M 平台、菜单栏和跨网络开发预览不在本切片发布；B3 批末再合并/部署 Dev，Prod 不动。

参考并以实际固定工具链测试验证：[npm ci](https://docs.npmjs.com/cli/v10/commands/npm-ci/)、[npm cache](https://docs.npmjs.com/cli/v10/commands/npm-cache/)、[package-lock](https://docs.npmjs.com/cli/v10/configuring-npm/package-lock-json/)。文档说明不能替代上面的实际安装、隔离与取消证据。
