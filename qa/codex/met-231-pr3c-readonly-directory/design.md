# MET-231 PR3c U1 写前对照

离当前目标还差：父 header 原生目录、各 child 的自有任务/历史摘要、可见父行真实 direct running 输入；热过程、原生事件更新与 Dev 热/冷截图由后续片和发布主会话完成。

- DSH 原生：已读 rc.2 `dsh-client-ui-subagent` README 与目录行实现；父 header 只数直接子节点，hover 150ms/leave 120ms、click 固定，嵌套展开；child 从普通侧栏隐藏。`running` 与 residency `activity` 不混同，completed 仅指上次关闭回合。
- 我们照搬：按上述规格实现窄目录/右侧只读摘要，复用公开 primitives 和既有员工侧栏行；消费 C1 受权 GET 的 running/title/own task/诊断，不拷 DSH 源码、不伪造 Session。
- SaaS 四类：仅单向账本展示；沿用既有多租户/owner/谱系门卫、存储后端，不新增状态、租约、执行所有者或 PG 字段。依据：用户 10-30 PR3c 先看后控及主会话派工、Astra 报告 §3/§5/§6。
- MET-225 已只读核对 `updatedAt=2026-10-30T07:13:08.647Z`：U05 员工工作区、冷宿主摘要与“原生child只读过程”行。候选更新由主会话誊写，不直接写 Linear。

## 范围与预算

产品新增+删除 240–360 行；目录/摘要约 220、样式约 40、接线/侧栏约 90。接近 400 时先将侧栏独立拆片，不以拆片重置累计；超过原估两倍停手。只改本树 UI、必要浏览器测试与 QA 文档。

冷摘要标明“历史摘要 · 当前活动状态未知”，耗时按 same-cut active.through 冻结，四桶累计可能含 fork 继承，最后回复不能证明完成。diagnostic 保留占位，错误不能清成空目录。侧栏不显示 stale 正数；只数 direct child running===true，不将孙辈或 unknown 纳入。

可见父行采用 C1 的 liveOnly 受权探测（接口待 C1 确定），目录打开可读完整摘要；不以 Run.status 推断、不轮询 JSONL。U1 只含初始及生命周期刷新，C3 原生事件接好前不能标实时完成。冷全过程、raw 工具数据、隐藏 reasoning、网页控制不在本片。

## 验证

浏览器走真实组件入口：打开/固定/关闭目录、展开孙辈、右侧自有任务/最后回复、direct count、驻留 idle、unknown/读取错误、child 隐藏、fork 自有任务；窄屏无溢出。提交后固定 SHA 用 m5-test --wait 0 --browser --maxWorkers=2 留日志。纯 UI 不用真实模型。

发布主会话另做独立 Astra 复核、同头 CI 和 Dev H1/H2/C1 截图；U1 不宣称 H3 热流/重连或无唤醒实景已验收。

## 按实际行数拆片（不重置原估）

首版格式化后目录/摘要/样式加 header 约 400，侧栏与共用读 hook 约 180，总计约 580，未超过原估 360 的两倍。已先向 root 说明，将共享受权读取与侧栏输入独立 U1a，目录/摘要为 U1b；共用同一 worktree，堆叠 PR，不扩热过程或执行接缝。两片分别带浏览器行为测试，组合头再验。
