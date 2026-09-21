# MET-147 · UX01-C：真实租户验收与恢复修复

独立 PR，叠加 UX01-B（PR #74）；不合并 main，不部署 Prod。用户授权仅 Dev 的 Snow 灰度。本文中的自动化层级分别标注，隔离组件/协议测试不算真实 Codex 任务通过。

## 本次修复

- **历史会话刷新恢复**：选择会话时以 `replaceState` 记录地址中的 `session`；新工作清除旧定位，迟到请求不改写选择。刷新仍须经工作区列表鉴权，不信任 URL 作为授权。保留 Next 路由状态及其他查询参数，清除旧会话审批锚点；History 写入不可用时不中断任务。
- **抽屉关闭焦点**：宽屏内编辑后切窄屏，不再把即将卸载的内部输入框当返回目标；保留外部入口，且不覆盖父组件指定的焦点。
- **候选版本辨识**：ready 健康接口在配置合法的 `ALLRICE_RELEASE_SHA` 时提供 `X-AllRice-Release-Sha`，禁止缓存。不猜测版本；验收脚本在登录/发送前核对部署 SHA。

## 可重复的真实网页验收

入口：`scripts/acceptance/ui/met147-tenant-workbench.mjs`。使用独立 Chromium、实际租户登录、真实 HTTP/数据库/Worker；不注入模型返回、不修改历史 Run、不读取个人浏览器配置。

由私有启动脚本提供环境（不要把密码放入命令历史、PR 或验收记录）：

- `ALLRICE_ACCEPTANCE_BASE_URL`：明确 Dev 地址。
- `ALLRICE_ACCEPTANCE_SHA`：完整候选 SHA，与在线健康响应一致。
- `ALLRICE_ACCEPTANCE_WORKSPACE_ID`：被授权的工作区。
- `ALLRICE_ACCEPTANCE_USER` / `ALLRICE_ACCEPTANCE_PASSWORD`：既有租户成员登录。
- `ALLRICE_ACCEPTANCE_EVIDENCE`：私有证据目录；截图可能含租户内容，不提交仓库。
- 可选 `ALLRICE_TEST_CHROME_EXECUTABLE`：隔离浏览器可执行文件。

模式：

1. 默认 `--inspect`：不发模型任务；验证历史会话刷新、成员的十二项能力入口、窄屏及 JS 错误。仅登录/登出产生身份会话写入。
2. `--submit-research`：**明确授权才使用**，从网页发送一条 COIN/MSTR/CRCL 研究任务。先独占写发送意图，防止响应丢失后自动重发。保存实际 Session/Run，最多观察 15 分钟；超时不擅自取消或再建任务。
3. `--resume`：只观察同一证据目录的既有 Run，绝不重新发送。跨代码版本保留最初提交 SHA，区分原冻结执行与当前前端。

研究验收检查：成功终态、来自该 Run 的真实 document Artifact、所有者/会话一致、三家公司与引用、右栏自动选中、表格渲染、真实下载与 SHA 校验、刷新恢复及无正常完成预算警告。报告内容和来源质量还须人工核对；存在三个 URL 本身不是事实正确性的证明。

## 灰度与待验收边界

- 首次 Dev 候选 `56d00b6` 保留了原有开关，无新授权；Prod 进程及配置哈希未变。
- 真实网页首次提交 Run `f2f910be-fd80-4cb7-a433-dde4e22a5d87` 被 `MODEL_TOKEN_QUOTA_EXCEEDED` 拦截，未进入模型。Snow 真实本月累计 2,213,797 Token 已超过默认用户月限额 2,000,000；不能说成官方 Codex 周额度耗尽。
- 用户另行批准：仅 Snow 的用户月限额临时 5,000,000，验收结束恢复。真实账本、异常预留、组织/员工限制及单 Run 规则保持不变。此操作不构成生产默认预算调整，预算长期取值继续归 MET-150。
- M5 Bridge 心跳在线不等于 SSH 可管理；未经许可不通过重配 Intel 撤销 M5。当前配对逻辑每工作区替换已有设备，必须保留这一约束。
- 完整关单仍要求真实研究报告、网页审批→Bridge 文件/命令→交付、真实浏览器证据及异常恢复。只完成上述修复/脚本不得把整个 UX01-C 或 MET-147 标 Done。

实际通过/失败结果、候选 SHA、配置前后及回退状态在收尾时补齐；未执行项明确保留，不以历史 B6 验收充当当前版本证据。
