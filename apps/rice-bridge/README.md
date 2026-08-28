# Rice Bridge v0.1

Rice Bridge 是 AllRice 的轻量本地只读执行端。DSH 仍在 SaaS 端负责理解、规划与工具选择，Bridge 只执行 Tool Broker 已授权的结构化本地命令。

v0.1 支持 Apple Silicon macOS，且只提供：

- `local.fs.list`
- `local.fs.search`
- `local.fs.read`
- `local.git.status`
- `local.git.diff`

它不提供 Shell、文件写入、Git 提交、本地模型或本地聊天界面。

## 开发安装

```bash
pnpm install
pnpm --filter @allrice/rice-bridge build
pnpm --filter @allrice/rice-bridge exec rice-bridge
```

## 配对 Snow 的 Mac

1. 登录 Snow 的 AllRice，在左下角打开“本地电脑”。
2. 点击“生成配对码”。
3. 在 Snow 的 Mac 上执行：

```bash
pnpm --filter @allrice/rice-bridge exec rice-bridge pair \
  --server https://allrice-snow.bplabs.xyz \
  --code XXXX-XXXX
```

4. 明确授权一个目录：

```bash
pnpm --filter @allrice/rice-bridge exec rice-bridge grant /absolute/project/path
```

5. 启动执行端：

```bash
pnpm --filter @allrice/rice-bridge exec rice-bridge start
```

设备令牌在 macOS Keychain 中保存。配置文件只记录服务地址、设备 ID 与本机授权目录映射，权限为 `0600`。

## 其他命令

```bash
rice-bridge status
rice-bridge revoke
```

## 安全边界

- Bridge 只主动请求 AllRice HTTPS API，不监听公网入站端口。
- 服务端只保存授权目录的显示名与不可逆指纹，不保存本机绝对路径。
- 所有路径经过 `realpath` 校验；目录外路径和符号链接逃逸会被拒绝。
- `.env`、SSH/AWS/GPG/Codex 凭证目录及常见密钥文件默认不可读取。
- Git 使用 `execFile` 与固定只读参数，不经过 Shell，也不接受任意子命令。

## v0.1 传输说明

CLI 验证阶段使用带设备 Bearer 凭证的 HTTPS 心跳与短轮询。命令已经采用持久化、租约和幂等契约；DMG/菜单栏版本会在不改变命令协议的前提下切换为 outbound WSS，降低空闲轮询开销。
