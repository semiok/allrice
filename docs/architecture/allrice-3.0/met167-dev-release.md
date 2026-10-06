# MET167 Dev 发布控制

PR5b1a 是控制面引导切片，并未实现独立发布监督或自动发布。

固定任务类型 `allrice.platform.dev.release` 预留给独立 supervisor。普通 enqueue 拒绝整个 `allrice.platform.dev.*` 命名空间；普通 Worker claim 跳过控制任务，start、heartbeat、事件写入、成功和失败回调也拒绝，即使调用者知道正确租约。当前发布 admission 始终关闭；无模型、浏览器、普通管理员或 Worker 路径可获得主机权限。维护与超时仍是 canonical queue 事实，不表示主机已恢复。

人工操作者在干净、准确版本的可信 Dev 目录构建后运行：

```sh
node scripts/dev-release/prepare-identity.mjs --root=/Users/a123/allrice-dev-releases/<release> --release-sha=<merged-main-sha>
```

准备器核对实际 Git HEAD/tree、Web BUILD_ID 与运行产物、Worker 编译产物及传递工作区运行依赖的实际解析目标与入口，再写入 `.local/dev-build-identity.json`。服务从自己的真实入口路径定位此文件，首次测量实际字节并验证每条工作区依赖链接仍指向本发布目录；开发模式不返回生产身份；ready 响应附加源码/tree、manifest/产物/依赖摘要及本进程 boot、PID、Node 版本。原健康字段和 SHA header 保留。未登记的旧服务没有 verified identity；存在但损坏、字节不符或 SHA 不一致时不能返回 ready。该文件是受信操作者登记的构建描述，并非平台用户提交的发布授权，也不是 CI、维护屏障或产品 QA 凭据。

身份记录是本次进程初始化时的观测，运行中的主机文件变动需由后续 supervisor 在物理阶段前后重新核对。后续 prepared manifest 必须冻结完整预期摘要，而不能只核对环境变量 header。两服务准确身份也不等于任务、页面或原问题验收已通过。

PR5b1 后续仍须：已安装监督身份、同一 canonical 控制 Run/Job、所有 producer/admission 的持久维护屏障与 ACK、统一人工入口、独立主机锁和阶段意图/回执、真实无迁移切换及兼容恢复。忙则退出；先封 claim 再等待 queued 排空会造成自锁。bootstrap 完成前不开放发布任务。PR5b2 再消费准确 merge generation/action/receipt，核对 A→T 集成范围、固定构建和迁移兼容，并补原 command-output QA。Prod、数据库降级、Bridge 自动升级不在范围内。
