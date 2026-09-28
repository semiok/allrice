# GitHub 和 Linear 默认应用

平台设置 → 应用连接：`/runtime-console?view=apps`。
成员设置 → 已连接应用：GitHub 和 Linear 是预置入口，点击后才创建个人连接；不会给全部租户自动绑定平台管理员账号。

## GitHub 平台配置（一次）

1. 打开 <https://github.com/settings/applications/new> 创建 OAuth App，名称建议 `AllRice（Dev）`。
2. Homepage URL 填当前管理后台地址。
3. Authorization callback URL **复制 AllRice 后台显示的地址**。Dev 当前为 `https://allrice-admin.bplabs.xyz/api/v1/connections/github/callback`。
4. 注册后复制 Client ID，Generate a new client secret，将两项填入 AllRice 后台并保存。不要粘贴到聊天。留空 Client Secret 会保留原密钥；更换 Client ID 时必须同时提供新密钥。
5. 成员进入已连接应用 → 连接 GitHub，登录自己的 GitHub 并授权。申请 `repo`、`read:org`，组织可能要求管理员批准。Dev、Prod 分别创建应用。

没有配置 OAuth App 时，成员可先选“使用访问令牌连接”，用自己的 GitHub PAT，选择需要访问的仓库和读写权限。令牌只进入凭据接口，不进入聊天或模型上下文。后续在管理连接中更新凭据或重新登录。

## Linear

点击“连接 Linear”，使用官方 OAuth 2.1 动态注册和 PKCE，选择自己的账号及 Linear 工作区并授权，无需平台填写 Client ID 或密钥。也支持个人 API key。

每个 AllRice 成员在每个 AllRice 工作区对同一预置服务保留一个个人连接。需要切换 Linear 工作区时重新账号登录。个人连接不会被其他成员列出或执行；工作区共享连接仍是独立的管理能力。

## 实现与边界

- 官方 Streamable HTTP：`https://api.githubcopilot.com/mcp/`、`https://mcp.linear.app/mcp`。
- 工具发现、调用与 OAuth/PKCE/令牌刷新复用 DSH MCP client 和官方 MCP SDK。AllRice 管理租户授权、凭据加密、连接生命周期和操作账本。
- GitHub 不支持动态客户端注册。本接入固定使用 GitHub 文档中的授权及令牌地址，平台密钥仅允许发往 `https://github.com/login/oauth/access_token`。
- 单一 GitHub 回调是只读转交：用随机 state 查找原始租户回调，再由原始租户验证当前成员、连接和有效期后交换 code。不能用调用参数指定跳转地址，过期或已消费的 state 无法重用。
- GitHub 平台密钥保存在 `allrice_runtime_metadata` 的独立 `platform-mcp-oauth:github` 项中，以现有 MCP AES-256-GCM 密钥加密并绑定版本。接口只返回是否配置，审计只记录版本。成员令牌和 OAuth 会话继续使用绑定组织、工作区、连接和版本的加密存储。
- 官方服务遇到系统 TUN Fake-IP 时，复用现有浏览器公网 DNS 验证逻辑，独立解析并固定真实公网地址用于 TLS。不会连接 Fake-IP 或放开内网地址；自定义 MCP 的原有 DNS 检查不变。
- 连接状态必须以工具发现成功为准；平台保存 GitHub Client ID/Secret 只表示已配置，不代表已经完成真实账号授权。初次第三方账号授权仍需成员本人完成。

## 官方说明

- [GitHub Remote MCP 集成](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)
- [创建 OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
- [GitHub OAuth 授权与 PKCE](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [Linear MCP](https://linear.app/docs/mcp)
