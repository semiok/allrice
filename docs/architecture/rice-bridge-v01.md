# Rice Bridge v0.1 架构

状态：MET-89 开发基线。

## 责任边界

```text
AllRice Web
  -> ChatFlow 3.0
  -> DSH
  -> DSH Native Tool Adapter (bidirectional JSON-RPC)
  -> Tool Broker / Policy / Audit
  -> Durable Bridge Command
  -> Rice Bridge on Snow Mac
  -> Explicitly granted folder
```

Rice Bridge 不是 Harness。Session、模型、提示词、员工配置、租户权限和 DSH Agent Loop 都留在 SaaS。Bridge 不获取模型 Provider 凭证，只持有可撤销的设备令牌。

五项本地能力注册为真正的 DSH Native Tools。DSH 不直接连接设备；每次
native call 都必须回到当前 Worker Run 的 Tool Broker，再次校验本轮冻结的
工具清单与 capability 后，才会生成结构化 Bridge command。DSH 子进程不能
借助反向 JSON-RPC 调用任意 Worker 方法，也不能绕过目录授权或取得 Shell。

## v0.1 协议

共享契约位于 `packages/contracts/src/bridge.ts`，协议版本固定为 1。设备只能声明五项只读 capability，命令不存在 `command`、`shell` 或任意可执行字符串字段。

一次命令依次经历：

```text
queued -> claimed -> succeeded | failed
                  -> expired | canceled
```

数据库保存命令、租约、结果与审计。PostgreSQL `LISTEN/NOTIFY` 作为低延迟唤醒点，CLI 验证版暂时通过 HTTPS 短轮询领取命令；后续 outbound WSS 复用同一持久命令语义。

## 身份与配对

1. 已登录用户为自己的 workspace 生成十分钟有效的一次性配对码。
2. Mac 使用配对码换取随机设备令牌。
3. 服务端只保存 SHA-256 令牌哈希。
4. Mac 使用 Keychain 保存明文令牌。
5. 用户或设备均可撤销；撤销同时取消未完成命令与目录授权。

配对码不是长期凭证，不能重复使用。

## 文件夹授权

本地绝对路径永远不上传。服务端只保存设备 ID、目录显示名和本地真实路径的 SHA-256 指纹。本机配置负责将 `folderGrantId` 映射到绝对路径，每次执行都会重新检查真实路径仍在授权根目录内。

## 失败策略

- 设备超过 90 秒无心跳：不再派发命令。
- 命令超时：标记 `expired`，迟到结果不能覆盖。
- 租约不匹配：拒绝完成，防止重放或重复执行。
- 设备撤销：所有未完成命令取消。
- 输出超过 500 KB：服务端拒绝；单文件读取上限 200 KB。

## 后续 DMG

DMG 与菜单栏应用复用 `apps/rice-bridge` 的协议、客户端和执行器。需要新增的主要是原生壳、LaunchAgent、签名、公证、自动更新和 outbound WSS，不重写 SaaS 控制平面。
