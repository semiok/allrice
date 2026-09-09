# P23：本地项目预览执行端

本切片复用 P09-c 服务进程和 P22 原生浏览器控制器，不增加 Agent Loop、宿主 Shell、公网隧道或任意 CDP 连接。

## 实际链路

用户/原生工具只提交 `processId`。数据库从当前 Run、Job、已批准进程和实际 service exchange 派生短租约。Bridge 仅在本机另行启用 `preview` 后领取；旧客户端缺省不领取。受信任控制器把不可变租约交给浏览器 driver，页面不能指定容器、设备、端口或请求 SaaS 令牌。

浏览器使用单一虚拟 HTTPS origin；请求经固定 Node HTTP relay 转入同一 `network=none` 容器的 `127.0.0.1` 服务端口。没有 Docker host port 绑定，浏览器不自行解析虚拟地址；缺失 relay 或目标不匹配直接拒绝，不回退公网代理或云端执行。预览内容在独立原生 Chrome 沙箱中执行，SaaS 只展示截图、观察和受控动作。

## 执行与关闭边界

- 每次转发前后核对短租约、固定 target、端点 lease ID、容器 ID/镜像/标签、只读根和无挂载/无端口绑定。短租约不超过 5 秒及服务硬期限；最新服务心跳由 PostgreSQL 权威生成。
- 使用固定 `/usr/local/bin/node --eval` 程序和容器 UID 1000，正文通过 stdin 输入，不拼 Shell，不在 argv/env 放用户正文。
- 当前并发上限 4，单请求/响应 1 MB、wire 1.5 MB、单请求绝对期限不超过 4.5 秒。超限拒绝，不无界缓存。
- 有副作用的 HTTP 请求继续经过 P22 精确审批。未知结果保留，不重放。关闭时首先取消该 driver 的私有 relay AbortSignal，防止等待中的批准随后产生新的写入；再等待原生 helper 确认整个 Chrome 进程组退出，才能回传成功停止。
- 关闭 preview opt-in、断开配对、租约到期、服务结束或权限变化均阻止继续 I/O。首次领取后的校验失败也进入统一清理，不留下无 driver 的续租占位。
- `preview status` 只读，不启动 VM/Chrome。`preview enable` 要求先启用 sandbox/browser 并完成固定本机组件 preflight；任何失败不写入启用状态。菜单切换先停止活跃任务，停止未确认时不改变权限；恢复不重启旧服务。
- 新客户端连接旧 P22 服务端时，普通 claim 不发送新字段。仅 preview capability probe 的 HTTP 400 可退回普通 claim；401/403/404/500 不降级重试，且绝不把预览改为其他执行目标。

## 第一版产品范围

支持普通 HTTP 页面、脚本资源、截图与审批后的交互。暂不支持 WebSocket/HMR、Service Worker、Cookie/登录态持久化、上传下载；请求不携带 Cookie/Authorization，响应不落 Set-Cookie。不会把 SaaS Cookie 或日常 Chrome 登录资料带入项目。此范围应在预览面板与分发说明中明确，不把“服务就绪”误报为“公网发布”。

## 验证与发布边界

真实 Intel 专用 VM 已验证 relay 7 项；原生监督 Chrome + 同一 VM 的生产 driver 验证包括 HTML/JS 渲染、POST 批准前 0 次/批准后 1 次、拒绝不写、关闭后批准不写、缺失 relay/越界 URL 拒绝、target 变化、短租约过期和服务停止。早期关闭竞态的失败保留，修复后重跑；不是以 synthetic renderer 替代物理执行。

另有实际 HTTP 协商、有限桌面协议、CLI 许可顺序和持久化测试。数据库→实际服务循环→Bridge→Chrome 全链路、最终双架构 ZIP、Dev 部署仍是独立发布门禁，以执行总表的最终证据为准；本文不表示已完成发布。测试仅使用临时身份/数据/目录，不代表实际计费模型 E2E。

`scripts/acceptance/runtime/p23-preview-workbench.ts` 在独立端口、临时 PostgreSQL schema 和私有 Chrome 中验证生产 ChatFlow：历史 Run 点击准备后立即刷新对应浏览器面板、刷新页面保留 pending 状态、重复请求不创建第二个端点、不伪造 control ACK 或导航、客户端不能指定 URL/端口、390px 窄屏与停止服务后禁止再次准备。该 UI 门禁使用合成身份及服务事实，不等同于上述真实 VM/Bridge 全链路。

`scripts/acceptance/runtime/b5-shipped-browser.mjs <解压后的 RiceBridgeCore>` 不重打测试 SEA，也不替换 driver：直接运行指定分发程序的 `start`，经私有 loopback 合成 authority 验证真实 Chrome 截图/control ACK、正常停止、租约到期和撤权后的进程组清理。回执绑定实际 Core 与 Launcher SHA-256；不使用个人配对、Keychain、数据库或 VM。候选包通过不能替代最终 main 同源双架构包重验。
