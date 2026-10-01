# MET164 PR3：原始文件与本机文件交接

PR3 复用附件、StorageObject/StoragePort、`getToolBrokerFile`、Workbench/DeliverableVersion、Bridge 命令队列和 v2 OperationLedger。文件字节不进入模型参数、工具回执或 JSON/base64 大包；模型只取得对象 ID、MIME、大小、checksum、来源版本和物理文件身份。每个文件沿用平台现有 9,000,000 bytes 上限。

## 实际入口与执行契约

- 发送前附件菜单“通过我的电脑选择文件”使用 Mac 原生文件窗口。确认前不上传，取消/超时/撤销授权会关闭窗口。已上传的原始字节进入当前用户的已有附件与对话引用。
- 成果卡菜单“保存到电脑 / 打开”使用原有 DSH 卡片和对话框。用户选择当前 Mac 的已授权目录和文件名；保存读取原 StorageObject，保留 DeliverableVersion 与原始字节。Finder 定位和默认应用打开复核当前文件版本。
- 员工工具为 `local.file.inspect/import/save/open/reveal`。五项在 DSH 原生工具注册表接入已有 Broker，模型可见声明复用同一严格参数契约；调用沿用真实运行中的 Run/job、冻结配置、目录授权代次、当前权限、时限、计量和 v2 收据。原始文件交接不依赖 Office/Python 或 VM profile。
- 终态成果和发送前附件没有运行中的 Run；它们复用已有用户 Bridge command 队列，以同一个 byte executor 和持久 SQLite journal 执行。没有伪造 Run 或延长 runtime deadline。

`inspected` 只证明当前文件内容与身份；`uploaded` 证明经过服务端实际 size/SHA256 校验的对象已 ready 且可下载；`saved` 证明文件已原子创建并同步到授权目录；`opened/revealed` 只证明 macOS 接收默认应用/Finder 动作，不证明用户已读。平台下载可用与本机已保存分开显示。

## 授权、取消与重试

本机选择复用现有 NSOpenPanel 和真实目录 grant。当前 App 没有 sandbox entitlement/security-scoped bookmark，不能把目录选择描述为 OS 沙箱边界。byte executor 复用现有敏感路径/realpath 检查；文件读取拒绝符号链接、非普通文件和变更身份，打开另外拒绝应用、脚本、可执行位和可执行文件头。保存可以保留任意原始二进制格式；默认应用打开支持 Office、PDF、图片和常用文本，MIME 来源元数据不是文件内容有效性认证。

保存使用同目录独占临时文件、实际字节 hash/size、fsync 和原子 create-only 提交。已有同名文件永不覆盖；取消、断线、超限和 checksum 不符会清理未提交临时文件。操作绑定设备、当前用户、可选对话 owner、目录 grant 代次和一次性 lease。传输只能连接已配对服务端的固定鉴权接口，不接受任意下载 URL。

相同 idempotency key 的请求只能读取同一命令，变更参数返回冲突。副作用之后丢失 ACK 或执行中崩溃保留 `unknown`；重启只交付 journal 收据，不重做文件操作。用户可以另发只读 inspect 对账物理结果，或读取已上传的原对象；重新执行需要新的明确动作。ACK 后只裁剪已确认的已知命令缓存，未确认及 unknown 证据保留。

## 兼容与发布

Bridge 源码版本为 `0.6.0-dev.12`，文件契约版本为 1。设备只有实际支持时才报告新 file capabilities/readiness，旧 v1/v2 客户端保留原行为且不会领取新文件任务。迁移 `0124_bridge_binary_files.sql` 只扩现有 capability/status CHECK 并给已有命令增加 nullable 的授权代次、session、取消和请求摘要列。

员工默认定义和 Office Skill 工具能力映射只是构造/发布接线。已有明确配置的员工需要正常发布工具清单与 checksum 才能在下一次发送调用；历史 Run 的冻结清单不变，显式权限与 deny 继续生效。

## 验证范围

真实文件系统测试覆盖中文/空格、DOCX/XLSX/PPTX/PDF/PNG 的二进制字节往返、变更/移动、超限、重名、取消、临时文件清理、打开失败和 unknown journal 恢复。测试中的格式后缀是 transport byte fixture，不代表 Office/PDF 内容验证。真实 loopback HTTP 测试覆盖卡住的 download reader 的 AbortSignal 和 upload ACK 丢失。

隔离 PostgreSQL fixture 覆盖旧设备不领取新命令、授权代次、对话 owner、实际服务端 hash/size、现有附件引用、取消、unknown 后物理对账，以及真实 Run→v2 HTTP→SQLite→原文件导入/保存；不使用业务租户、用户资料或配对设备。Mac Swift 类型检查通过；实际打包客户端、Finder/default app 和 Dev UI/用户动作的最终验收由交付流程另取物理证据。ARM 实机、Windows 和本地 Office 执行均未在 PR3 承诺；`local.office` 继续 unsupported，PR4 才负责原生 Office 后端。
